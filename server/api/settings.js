'use strict';
/**
 * 设置读写（ARCH §3.3 #3 #4）。
 */
/** GET /api/settings */
function getSettings(ctx, req, res, params, h) {
  h.sendJson(res, 200, ctx.store.getSettings());
}

/** PUT /api/settings（深合并） */
async function putSettings(ctx, req, res, params, h) {
  const patch = await h.readJson(req);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    const e = new Error('请求体必须是 JSON 对象');
    e.code = 'BAD_REQUEST';
    throw e;
  }
  const next = ctx.store.saveSettings(patch);
  h.sendJson(res, 200, next);
}

module.exports = { getSettings, putSettings };
