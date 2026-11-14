'use strict';
/**
 * 应用列表 / 安装 / 启动 / 停止 / 卸载（ARCH §3.3 #12 #13 #14 #15 #16 / §4.3）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseApk, quickCheck } = require('../../core/apk');
const { isUnsupportedExt } = require('./apk');
const foreground = require('../service/foreground');

/**
 * 当前前台包名（若模拟器运行）。
 *
 * 这里**不再**用 runningPackages()[0] 当真实前台 —— 那只是「进程还活着」的列表顺序，
 * 系统崩溃弹窗把应用挤到后台时它仍然会返回应用包名，导致接口谎报 foreground。
 * 改为解析 dumpsys 的 mResumedActivity（退化 mCurrentFocus）：只认窗口焦点事实。
 */
async function _runningState(ctx) {
  const running = ctx.emulator.state === 'running';
  if (!running) return { runningMatch: null, foregroundPkg: null, systemSurface: false };
  let pkgs = [];
  try {
    const r = await ctx.emulator.adb().runningPackages();
    pkgs = Array.isArray(r) ? r : [];
  } catch (_) {
    pkgs = [];
  }
  let fg = null;
  try {
    fg = await foreground.current(ctx.emulator.adb());
  } catch (_) {
    fg = null;
  }
  return {
    runningMatch: pkgs,
    foregroundPkg: fg ? fg.package : null,
    // 前台是系统弹窗/桌面宿主时为 true —— 此时任何应用都不算「在前台」
    systemSurface: fg ? Boolean(fg.systemSurface) : false,
  };
}

/** GET /api/apps → AppVO[] */
async function list(ctx, req, res, params, h) {
  const apps = ctx.store.getApps();
  const { runningMatch, foregroundPkg, systemSurface } = await _runningState(ctx);
  const out = apps.map((app) => {
    let running = null;
    let fore = null;
    if (runningMatch !== null) {
      running = runningMatch.includes(app.package);
      // 前台被系统弹窗/桌面占据时，一个应用都不算在前台（如实上报）
      fore = !systemSurface && foregroundPkg === app.package;
    }
    return {
      package: app.package,
      label: app.label,
      versionName: app.versionName,
      versionCode: app.versionCode,
      iconDataUri: ctx.store.iconDataUri(app.package),
      installedAt: app.installedAt,
      running,
      foreground: fore,
    };
  });
  h.sendJson(res, 200, out);
}

/** 非 JSON 请求（重传 file）→ 解析并登记上传，返回 uploadId。 */
async function _ingestUpload(ctx, req, h) {
  const id = crypto.randomBytes(6).toString('hex');
  const tmpPath = path.join(ctx.paths.UPLOADS, `up_${Date.now()}_${id}.apk`);
  const ctype = String(req.headers['content-type'] || '');
  let saved = null;
  let filename = String(req.headers['x-filename'] || 'upload.apk');
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
    saved = await h.streamToFile(req, tmpPath);
  }
  if (!saved || !saved.size) {
    const e = new Error('未收到上传文件');
    e.code = 'BAD_REQUEST';
    throw e;
  }
  if (isUnsupportedExt(filename)) {
    try { fs.rmSync(tmpPath, { force: true }); } catch (_) { /* ignore */ }
    const e = new Error('暂不支持 .apks / .xapk 拆分包');
    e.code = 'UNSUPPORTED';
    throw e;
  }
  if (!quickCheck(tmpPath)) {
    try { fs.rmSync(tmpPath, { force: true }); } catch (_) { /* ignore */ }
    const e = new Error('文件不是有效的 APK');
    e.code = 'BAD_REQUEST';
    throw e;
  }
  let parsed;
  try { parsed = parseApk(tmpPath); } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch (_) { /* ignore */ }
    const e = new Error(err && err.message ? err.message : 'APK 解析失败');
    e.code = 'BAD_REQUEST';
    throw e;
  }
  const uploadId = `up_${Date.now()}_${id}`;
  ctx.uploads.set(uploadId, {
    path: tmpPath, parsed: { ...parsed, filename }, expiresAt: Date.now() + 30 * 60 * 1000,
  });
  return uploadId;
}

/** POST /api/apps/install { uploadId } 或重传 file → AppVO */
async function install(ctx, req, res, params, h) {
  const ctype = String(req.headers['content-type'] || '');
  if (!ctx.emulator || ctx.emulator.state !== 'running') {
    const e = new Error('模拟器未运行，请先启动模拟器');
    e.code = 'EMULATOR_DOWN';
    throw e;
  }
  let uploadId = null;
  if (ctype.includes('application/json')) {
    const body = await h.readJson(req);
    uploadId = body && body.uploadId;
    if (!uploadId) {
      const e = new Error('缺少 uploadId（请先调用 /api/apk/parse）');
      e.code = 'BAD_REQUEST';
      throw e;
    }
  } else {
    uploadId = await _ingestUpload(ctx, req, h);
  }
  const appVO = await ctx.installer.install(uploadId);
  h.sendJson(res, 201, appVO);
}

/** POST /api/apps/:pkg/start { activity? } */
async function start(ctx, req, res, params, h) {
  let body = {};
  try { body = await h.readJson(req); } catch (_) { body = {}; }
  const result = await ctx.installer.startApp(params.pkg, body && body.activity);
  h.sendJson(res, 200, result);
}

/** POST /api/apps/:pkg/stop */
async function stop(ctx, req, res, params, h) {
  const result = await ctx.installer.stopApp(params.pkg);
  h.sendJson(res, 200, result);
}

/** DELETE /api/apps/:pkg */
async function remove(ctx, req, res, params, h) {
  const result = await ctx.installer.uninstall(params.pkg);
  h.sendJson(res, 200, result);
}

module.exports = { list, install, start, stop, remove };
