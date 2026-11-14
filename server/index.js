'use strict';
/**
 * 进程入口（ARCH §2.2 / §6.1）：
 * 加载 config → 构造单例（Store/Provision/Emulator/Engine/Installer）→ 装配路由
 * → 启动 HTTP（0.0.0.0:8890，或 LISTEN_SOCKET）→ 注册 SIGTERM/SIGINT 优雅退出。
 */
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { PATHS, ensureAllDirs, DEFAULT_PORT, DEFAULT_HOST, VERSION } = config;

const { Store } = require('./service/store');
const { Provision } = require('./service/provision');
const { EmulatorManager } = require('./service/emulator');
const { Engine } = require('./service/engine');
const { Installer } = require('./service/installer');
const { Router } = require('./http/router');
const { createServer } = require('./http/server');

const healthApi = require('./api/health');
const settingsApi = require('./api/settings');
const runtimeApi = require('./api/runtime');
const emulatorApi = require('./api/emulator');
const apkApi = require('./api/apk');
const appsApi = require('./api/apps');
const screenApi = require('./api/screen');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  // 同时写 stdout（cmd/main 重定向到 logs/service.log）与错误流
  // eslint-disable-next-line no-console
  console.log(line);
}

/**
 * 把关键错误同时写入平台日志（TRIM_TEMP_LOGFILE），
 * 这样「应用中心 → 日志」里能直接看见，不必登录机器翻 service.log。
 */
function logPlatform(msg) {
  const file = process.env.TRIM_TEMP_LOGFILE;
  if (!file) return;
  try {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch (_) { /* 平台日志不可写时忽略，不影响主流程 */ }
}

function buildContext() {
  ensureAllDirs();
  const store = new Store(PATHS);
  store.ensureDirs();

  const uploads = new Map();
  const provision = new Provision({ paths: PATHS });
  const emulator = new EmulatorManager({
    paths: PATHS,
    provision,
    settingsGetter: () => store.getSettings(),
  });
  const engine = new Engine({ paths: PATHS, provision, emulator, store });
  const installer = new Installer({ paths: PATHS, store, emulator, uploads });

  return { paths: PATHS, config, store, provision, emulator, engine, installer, uploads, version: VERSION };
}

function buildRouter() {
  const r = new Router();
  // 健康 / 状态
  r.get('/api/health', healthApi.health);
  r.get('/api/status', healthApi.status);
  // 设置
  r.get('/api/settings', settingsApi.getSettings);
  r.put('/api/settings', settingsApi.putSettings);
  // 运行时
  r.get('/api/runtime/status', runtimeApi.getStatus);
  r.post('/api/runtime/deploy', runtimeApi.deploy);
  r.get('/api/runtime/deploy/progress', runtimeApi.progress);
  // 模拟器
  r.post('/api/emulator/start', emulatorApi.start);
  r.post('/api/emulator/stop', emulatorApi.stop);
  r.get('/api/emulator/logs', emulatorApi.logs);
  // APK 解析
  r.post('/api/apk/parse', apkApi.parse);
  // 应用
  r.get('/api/apps', appsApi.list);
  r.post('/api/apps/install', appsApi.install);
  r.post('/api/apps/:pkg/start', appsApi.start);
  r.post('/api/apps/:pkg/stop', appsApi.stop);
  r.del('/api/apps/:pkg', appsApi.remove);
  // 画面与输入
  r.get('/api/screen/frame', screenApi.frame);
  r.get('/api/screen/size', screenApi.size);
  r.post('/api/screen/tap', screenApi.tap);
  r.post('/api/screen/swipe', screenApi.swipe);
  r.post('/api/screen/text', screenApi.text);
  r.post('/api/screen/key', screenApi.key);
  return r;
}

function main() {
  const ctx = buildContext();
  const router = buildRouter();
  const uiDir = path.join(PATHS.APPDEST, 'ui');
  const server = createServer({ ctx, router, uiDir, logger: log });

  // 后台健康巡检
  ctx.engine.init().catch((e) => log(`engine init 失败: ${e.message}`));

  const settings = ctx.store.getSettings();
  const port = Number(process.env.TRIM_SERVICE_PORT) || Number(settings.port) || DEFAULT_PORT;
  const listenSocket = process.env.LISTEN_SOCKET; // P1 统一网关预留分支

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return;
    closing = true;
    log(`收到 ${sig}，开始优雅退出…`);
    try { await ctx.engine.shutdown(); } catch (e) { log(`停机异常: ${e.message}`); }
    server.close(() => { log('HTTP 已关闭，退出'); process.exit(0); });
    setTimeout(() => process.exit(0), 4000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // 监听错误必须先注册：EADDRINUSE 等在 listen() 后异步触发。若不显式退出，
  // 进程会「活着但没在服务」，再叠加健康检查误判就变成「假成功」（真机已踩过）。
  server.on('error', (e) => {
    const code = (e && e.code) || 'UNKNOWN';
    let msg;
    if (code === 'EADDRINUSE') {
      msg = listenSocket
        ? `socket ${listenSocket} 已被占用，请释放该 socket 后重启 ApkStart。`
        : `端口 ${port} 已被占用，请在 Web 控制台的设置里改用其他端口，或释放该端口后重启 ApkStart。`;
    } else {
      msg = `HTTP 服务错误（${code}）: ${(e && e.message) || String(e)}`;
    }
    log(msg);
    logPlatform(msg);
    // 同时写 stderr：cmd/main 启动失败时会 tail 日志尾部，用户无需登录即可看到原因
    // eslint-disable-next-line no-console
    console.error(msg);
    process.exit(1);
  });

  if (listenSocket) {
    server.listen(listenSocket, () => log(`ApkStart ${VERSION} 监听 unix socket: ${listenSocket}`));
  } else {
    server.listen(port, DEFAULT_HOST, () => {
      log(`ApkStart ${VERSION} 已启动，监听 ${DEFAULT_HOST}:${port}（数据根 ${PATHS.APPDATA}）`);
    });
  }

  return server;
}

if (require.main === module) {
  main();
}

module.exports = { main, buildContext, buildRouter };
