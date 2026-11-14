'use strict';
/**
 * 模拟器启停与日志（ARCH §3.3 #8 #9 #10 / §4.2）。
 * start/stop 立刻返回（后续通过 /api/status 轮询），避免长请求挂住 HTTP。
 */
/** POST /api/emulator/start { wipe? } → { status:"starting" } */
async function start(ctx, req, res, params, h) {
  let body = {};
  try { body = await h.readJson(req); } catch (_) { body = {}; }
  const emu = ctx.emulator;

  if (emu.state === 'running' || emu.state === 'starting') {
    const e = new Error('模拟器已在运行或启动中');
    e.code = 'CONFLICT';
    throw e;
  }
  if (!ctx.provision.status().deployed) {
    const e = new Error('运行时尚未部署，请先在「运行时」区域完成部署');
    e.code = 'RUNTIME_NOT_READY';
    throw e;
  }

  // 异步启动，立即返回「启动中」
  emu.start({ wipe: !!(body && body.wipe) }).catch(() => { /* 错误体现在 /api/status.error */ });
  h.sendJson(res, 200, { status: 'starting' });
}

/** POST /api/emulator/stop → { status:"stopping"|"stopped" }（幂等） */
async function stop(ctx, req, res, params, h) {
  const emu = ctx.emulator;
  if (emu.state === 'stopped' && !emu.pid) {
    h.sendJson(res, 200, { status: 'stopped' });
    return;
  }
  emu.stop().catch(() => { /* 状态最终在 /api/status 反映 */ });
  h.sendJson(res, 200, { status: 'stopping' });
}

/** GET /api/emulator/logs?lines=200 */
function logs(ctx, req, res, params, h) {
  const url = new URL(req.url, 'http://localhost');
  const n = Number(url.searchParams.get('lines')) || 200;
  h.sendJson(res, 200, { lines: ctx.emulator.logs(n) });
}

module.exports = { start, stop, logs };
