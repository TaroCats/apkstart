'use strict';
/**
 * 极简路由表（ARCH §3.3）：
 *   router.add('GET', '/api/apps/:pkg/start', handler)
 *   router.resolve('POST', '/api/apps/com.x/start') → { handler, params }
 * handler 签名：(ctx, req, res, params, helpers) => Promise<void>|void
 */
class Router {
  constructor() {
    this._routes = [];
  }

  /**
   * 注册路由。pattern 使用 `:name` 占位。
   */
  add(method, pattern, handler) {
    const keys = [];
    // 先转义所有正则元字符（':' 不属于元字符，保持原样）
    let source = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 再把 :name 换成捕获组
    source = source.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    });
    const rx = new RegExp(`^${source}$`);
    this._routes.push({ method: String(method).toUpperCase(), rx, keys, handler });
    return this;
  }

  /** 便捷方法。 */
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  del(p, h) { return this.add('DELETE', p, h); }

  /**
   * @returns {{handler:Function, params:object}|null}
   */
  resolve(method, pathname) {
    const m = String(method).toUpperCase();
    for (const r of this._routes) {
      if (r.method !== m) continue;
      const match = r.rx.exec(pathname);
      if (!match) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        try { params[k] = decodeURIComponent(match[i + 1]); } catch (_) { params[k] = match[i + 1]; }
      });
      return { handler: r.handler, params };
    }
    return null;
  }
}

module.exports = { Router };
