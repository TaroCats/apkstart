'use strict';
/**
 * fetch 封装（ARCH §2.3）。
 * 统一解析 {code, message} 错误体，抛出带 code/status 的 Error，便于 UI 统一提示。
 * 纯浏览器脚本（无构建），通过全局 window.Api 暴露。
 */
(function (global) {
  /** 后端错误对象：保留 HTTP 状态与业务 code，message 必为中文。 */
  class ApiError extends Error {
    constructor(message, code, status) {
      super(message || '请求失败');
      this.name = 'ApiError';
      this.code = code || 'INTERNAL';
      this.status = status || 0;
    }
  }

  /** 读取响应：按 content-type 决定 JSON 或文本/blob。 */
  async function parseResponse(res) {
    const ct = res.headers.get('content-type') || '';
    if (ct.indexOf('application/json') >= 0) {
      try {
        return await res.json();
      } catch (_) {
        return null;
      }
    }
    if (ct.indexOf('image/png') >= 0) {
      return await res.blob();
    }
    return await res.text();
  }

  /**
   * 通用请求。
   * @param {string} method HTTP 方法
   * @param {string} path 绝对路径（以 / 开头）
   * @param {*} [body] JSON 体（FormData 时原样发送）
   * @returns {Promise<*>} 解析后的响应体
   */
  async function request(method, path, body) {
    const opts = { method, headers: {} };
    if (body instanceof FormData) {
      opts.body = body; // 浏览器自动设置 multipart boundary
    } else if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      throw new ApiError('无法连接后端服务，请确认服务已启动', 'NETWORK', 0);
    }
    if (res.status === 204) return null;
    const data = await parseResponse(res);
    if (!res.ok) {
      const code = (data && data.code) || 'INTERNAL';
      const message = (data && data.message) || `请求失败（HTTP ${res.status}）`;
      throw new ApiError(message, code, res.status);
    }
    return data;
  }

  const Api = {
    ApiError,
    request,
    // —— 健康 / 状态 ——
    health: () => request('GET', '/api/health'),
    status: () => request('GET', '/api/status'),
    // —— 设置 ——
    getSettings: () => request('GET', '/api/settings'),
    putSettings: (patch) => request('PUT', '/api/settings', patch),
    // —— 运行时 ——
    runtimeStatus: () => request('GET', '/api/runtime/status'),
    deployRuntime: (force) => request('POST', '/api/runtime/deploy', { force: !!force }),
    deployProgress: () => request('GET', '/api/runtime/deploy/progress'),
    // —— 模拟器 ——
    startEmulator: (wipe) => request('POST', '/api/emulator/start', { wipe: !!wipe }),
    stopEmulator: () => request('POST', '/api/emulator/stop', {}),
    emulatorLogs: (lines) => request('GET', `/api/emulator/logs?lines=${encodeURIComponent(lines || 200)}`),
    // —— APK 解析（上传） ——
    parseApk: (file) => {
      const fd = new FormData();
      fd.append('file', file, file.name);
      return request('POST', '/api/apk/parse', fd);
    },
    // —— 应用 ——
    listApps: () => request('GET', '/api/apps'),
    installApp: (uploadId) => request('POST', '/api/apps/install', { uploadId }),
    startApp: (pkg, activity) => request('POST', `/api/apps/${encodeURIComponent(pkg)}/start`, activity ? { activity } : {}),
    stopApp: (pkg) => request('POST', `/api/apps/${encodeURIComponent(pkg)}/stop`, {}),
    removeApp: (pkg) => request('DELETE', `/api/apps/${encodeURIComponent(pkg)}`),
    // —— 画面 / 输入 ——
    screenSize: () => request('GET', '/api/screen/size'),
    tap: (x, y) => request('POST', '/api/screen/tap', { x, y }),
    swipe: (x1, y1, x2, y2, durationMs) => request('POST', '/api/screen/swipe', { x1, y1, x2, y2, durationMs: durationMs || 300 }),
    text: (t) => request('POST', '/api/screen/text', { text: t }),
    key: (k) => request('POST', '/api/screen/key', { key: k }),
  };

  global.Api = Api;
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
})(typeof window !== 'undefined' ? window : globalThis);
