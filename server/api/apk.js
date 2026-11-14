'use strict';
/**
 * APK 上传与解析（ARCH §3.3 #11 / §4.3 / §5.3）。
 * 支持 multipart/form-data（字段 file）或 application/octet-stream 直传。
 * 解析复用 core/apk.js（纯 JS，离线）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseApk, quickCheck } = require('../../core/apk');
const { isArmOnly } = require('../service/installer');

const UPLOAD_TTL_MS = 30 * 60 * 1000; // 上传暂存 30 分钟

function isUnsupportedExt(name) {
  return /\.(apks|xapk)$/i.test(String(name || ''));
}

/** 清理过期上传。 */
function sweepUploads(uploads) {
  const now = Date.now();
  for (const [id, entry] of uploads) {
    if (entry.expiresAt && entry.expiresAt < now) {
      try { if (entry.path) fs.rmSync(entry.path, { force: true }); } catch (_) { /* ignore */ }
      uploads.delete(id);
    }
  }
}

/** POST /api/apk/parse */
async function parse(ctx, req, res, params, h) {
  sweepUploads(ctx.uploads);
  const id = crypto.randomBytes(6).toString('hex');
  const tmpPath = path.join(ctx.paths.UPLOADS, `up_${Date.now()}_${id}.apk`);
  const ctype = String(req.headers['content-type'] || '');

  let saved = null;
  let filename = 'upload.apk';

  if (ctype.includes('multipart/form-data')) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
    const boundary = m ? (m[1] || m[2]).trim() : '';
    if (!boundary) {
      const e = new Error('无法解析上传请求（缺少 multipart 边界）');
      e.code = 'BAD_REQUEST';
      throw e;
    }
    saved = await h.saveMultipartFile(req, tmpPath, boundary);
    if (saved && saved.filename) filename = saved.filename;
  } else {
    // octet-stream 或其它：直接流式落盘
    saved = await h.streamToFile(req, tmpPath);
    filename = String(req.headers['x-filename'] || 'upload.apk');
  }

  if (!saved || !saved.size) {
    try { fs.rmSync(tmpPath, { force: true }); } catch (_) { /* ignore */ }
    const e = new Error('未收到上传文件');
    e.code = 'BAD_REQUEST';
    throw e;
  }

  // .apks/.xapk 在 P0 明确拒绝（不尝试解析，避免崩溃）
  if (isUnsupportedExt(filename)) {
    try { fs.rmSync(tmpPath, { force: true }); } catch (_) { /* ignore */ }
    const e = new Error('暂不支持 .apks / .xapk 拆分包（见 P1-3），请上传单个 .apk');
    e.code = 'UNSUPPORTED';
    throw e;
  }

  // 头校验：不是 PK 直接拒绝
  if (!quickCheck(tmpPath)) {
    try { fs.rmSync(tmpPath, { force: true }); } catch (_) { /* ignore */ }
    const e = new Error('文件不是有效的 APK（缺少 ZIP 文件头）');
    e.code = 'BAD_REQUEST';
    throw e;
  }

  let parsed;
  try {
    parsed = parseApk(tmpPath);
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch (_) { /* ignore */ }
    const e = new Error(err && err.message ? err.message : 'APK 解析失败');
    e.code = 'BAD_REQUEST';
    throw e;
  }

  const uploadId = `up_${Date.now()}_${id}`;
  const abis = parsed.abis || [];
  ctx.uploads.set(uploadId, {
    path: tmpPath,
    parsed: { ...parsed, filename },
    expiresAt: Date.now() + UPLOAD_TTL_MS,
  });

  const iconDataUri = parsed.iconPng
    ? `data:image/png;base64,${Buffer.from(parsed.iconPng).toString('base64')}`
    : '';

  h.sendJson(res, 200, {
    uploadId,
    package: parsed.package,
    label: parsed.label,
    versionName: parsed.versionName,
    versionCode: parsed.versionCode,
    minSdk: parsed.minSdk,
    targetSdk: parsed.targetSdk,
    launchActivity: parsed.launchActivity || null,
    abis,
    armOnly: isArmOnly(abis),
    sizeBytes: parsed.sizeBytes,
    iconDataUri,
  });
}

module.exports = { parse, sweepUploads, isUnsupportedExt };
