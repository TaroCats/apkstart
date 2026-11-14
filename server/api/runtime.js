'use strict';
/**
 * 运行时部署（ARCH §3.3 #5 #6 #7 / §4.1）。
 */
/** GET /api/runtime/status */
function getStatus(ctx, req, res, params, h) {
  h.sendJson(res, 200, ctx.provision.status());
}

/** POST /api/runtime/deploy { force? } → { taskId, state:"running" } */
async function deploy(ctx, req, res, params, h) {
  let body = {};
  try { body = await h.readJson(req); } catch (_) { body = {}; }
  const result = ctx.provision.deploy({
    force: !!(body && body.force),
    settings: ctx.store.getSettings(),
  });
  h.sendJson(res, 200, result);
}

/** GET /api/runtime/deploy/progress */
function progress(ctx, req, res, params, h) {
  h.sendJson(res, 200, ctx.provision.progress());
}

module.exports = { getStatus, deploy, progress };
