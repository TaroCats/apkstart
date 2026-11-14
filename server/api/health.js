'use strict';
/**
 * 健康与状态（ARCH §3.3 #1 #2）。
 *
 * `/api/health` 必须携带**身份标识**（app + pid）：
 *   fnOS 上一个端口可能已被第三方服务占用（实测目标机 8890 被 uvicorn 占用，
 *   其 /api/health 同样返回 200），若只看状态码会把「别人的 200」误判为自己启动成功。
 *   `fnos/cmd/main` 的 health_ok() 会校验 app === APP_ID 且 pid 与 service.pid 一致。
 */
const { VERSION } = require('../config');

/** 应用唯一标识，健康检查与 cmd/main 共用同一常量值。 */
const APP_ID = 'apkstart-fnos';

/** GET /api/health */
function health(ctx, req, res, params, h) {
  h.sendJson(res, 200, {
    app: APP_ID,
    status: 'ok',
    version: VERSION,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
  });
}

/** GET /api/status → StatusVO */
function status(ctx, req, res, params, h) {
  h.sendJson(res, 200, ctx.engine.status());
}

module.exports = { health, status, APP_ID };
