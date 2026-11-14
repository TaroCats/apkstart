'use strict';
/**
 * HTTP 服务（ARCH §1.2 / §3.3）：
 * - 静态文件（ui 目录）+ /api 分派 + JSON body 读取
 * - 统一响应封装 sendJson/sendError/sendPng
 * - 统一错误：{ code, message中文 }，HTTP 状态语义化
 * - 预留 LISTEN_SOCKET（P1 统一网关）分支在 index.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** code → HTTP 状态码（ARCH §3.3）。 */
const CODE_STATUS = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNSUPPORTED: 422,
  RUNTIME_NOT_READY: 503,
  EMULATOR_DOWN: 503,
  INTERNAL: 500,
};

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { code: code || 'INTERNAL', message: message || '服务器内部错误' });
}

function sendPng(res, buffer) {
  if (!buffer || !buffer.length) {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

/** 读取 JSON 请求体（限 2MB）。空体返回 {}。 */
function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const e = new Error('请求体过大');
        e.code = 'BAD_REQUEST';
        req.destroy();
        reject(e);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        const e = new Error('请求体不是合法 JSON');
        e.code = 'BAD_REQUEST';
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** 把请求体流式写入文件（用于 ≤500MB 的 APK 上传）。返回 {path, size}。 */
function streamToFile(req, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const ws = fs.createWriteStream(dest);
    let size = 0;
    req.on('data', (c) => { size += c.length; });
    req.on('error', (e) => { ws.destroy(); reject(e); });
    ws.on('error', reject);
    ws.on('finish', () => resolve({ path: dest, size }));
    req.pipe(ws);
  });
}

/**
 * 从 multipart/form-data 请求体中提取名为 `file` 的分片并写入 dest。
 * 极简实现：只适用于单文件、≤500MB 的上传（P0-2 场景）。
 * @returns {Promise<{path:string,size:number,filename:string}|null>}
 */
function saveMultipartFile(req, dest, boundary) {
  return new Promise((resolve, reject) => {
    const delim = Buffer.from(`--${boundary}`);
    const parts = [];
    let buf = Buffer.alloc(0);
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 500 * 1024 * 1024) {
        const e = new Error('文件超过 500MB 限制');
        e.code = 'BAD_REQUEST';
        req.destroy();
        reject(e);
        return;
      }
      buf = Buffer.concat([buf, c]);
      // 防止内存无限增长：找到文件区分界后即可停止累积（这里简单累积，500MB 上限兜底）
    });
    req.on('end', () => {
      try {
        const idx1 = buf.indexOf(delim);
        if (idx1 < 0) return resolve(null);
        // 第二个 boundary 之前是文件内容
        const bodyStart = idx1 + delim.length;
        const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n'), bodyStart);
        if (headerEnd < 0) return resolve(null);
        const headers = buf.toString('utf8', bodyStart, headerEnd);
        const m = /filename="([^"]*)"/i.exec(headers);
        const filename = m ? m[1] : 'upload.apk';
        const contentStart = headerEnd + 4;
        const nextDelim = buf.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
        const contentEnd = nextDelim < 0 ? buf.length : nextDelim;
        const content = buf.subarray(contentStart, contentEnd);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
        resolve({ path: dest, size: content.length, filename });
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** 简易静态文件服务。 */
function serveStatic(res, uiDir, pathname) {
  let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  const base = path.resolve(uiDir);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    sendError(res, 403, 'BAD_REQUEST', '禁止访问该路径');
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      // 回退到 index.html（单页）
      if (rel !== 'index.html') {
        fs.readFile(path.join(base, 'index.html'), (e2, d2) => {
          if (e2) { sendError(res, 404, 'NOT_FOUND', '资源不存在'); return; }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(d2);
        });
        return;
      }
      sendError(res, 404, 'NOT_FOUND', '资源不存在');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/**
 * @param {object} opts { ctx, router, uiDir, logger }
 * @returns {http.Server}
 */
function createServer({ ctx, router, uiDir, logger }) {
  const helpers = {
    sendJson, sendError, sendPng, readJson, streamToFile, saveMultipartFile, CODE_STATUS,
  };
  const log = logger || (() => {});
  const baseDir = uiDir || path.join(ctx.paths.APPDEST, 'ui');

  return http.createServer((req, res) => {
    let parsed;
    try {
      parsed = new URL(req.url, 'http://localhost');
    } catch (_) {
      sendError(res, 400, 'BAD_REQUEST', '非法的请求地址');
      return;
    }
    const pathname = parsed.pathname;

    if (!pathname.startsWith('/api/')) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(res, baseDir, pathname);
      } else {
        sendError(res, 405, 'BAD_REQUEST', '不支持的请求方法');
      }
      return;
    }

    const route = router.resolve(req.method, pathname);
    if (!route) {
      sendError(res, 404, 'NOT_FOUND', '接口不存在');
      return;
    }

    Promise.resolve()
      .then(() => route.handler(ctx, req, res, route.params, helpers))
      .catch((err) => {
        const code = err && err.code && CODE_STATUS[err.code] ? err.code : 'INTERNAL';
        const status = err && err.status ? err.status : CODE_STATUS[code];
        const message = err && err.message ? err.message : '服务器内部错误';
        if (!res.headersSent) {
          sendError(res, status, code, code === 'INTERNAL' && !err.message ? '服务器内部错误' : message);
        } else {
          try { res.end(); } catch (_) { /* ignore */ }
        }
        if (code === 'INTERNAL') log(`[api-error] ${req.method} ${pathname} → ${message}`);
      });
  });
}

module.exports = {
  createServer, sendJson, sendError, sendPng, readJson, streamToFile,
  saveMultipartFile, serveStatic, CODE_STATUS, MIME,
};
