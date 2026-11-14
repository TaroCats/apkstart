'use strict';
/**
 * 路径解析（纯对象，不依赖任何 service，供 store/service 注入，避免循环依赖）。
 *
 * 数据根取 fnOS 实测可用的环境变量（见 docs/fnos/fnos-runtime-patterns.md 与 ARCH §10）：
 *   TRIM_PKGVAR   —— 持久数据根（首选）
 *   TRIM_APPDATA  —— 次选回退（社区文档写法，机上脚本未出现，但保留兼容）
 *   TRIM_PKGTMP   —— 临时目录（下载/上传暂存，可被系统清空）
 *   TRIM_APPDEST  —— 代码根（安装后 app/ 目录）
 * 本地开发（三者皆无）回退到 $HOME/.apkstart。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

/** 代码根：TRIM_APPDEST，否则取仓库/安装根（server/service/paths.js 的上两级）。 */
function resolveAppDest(env) {
  if (env.TRIM_APPDEST) return env.TRIM_APPDEST;
  return path.resolve(__dirname, '..', '..');
}

/** 持久数据根：TRIM_PKGVAR → TRIM_APPDATA → $HOME/.apkstart。 */
function resolveDataRoot(env) {
  if (env.TRIM_PKGVAR) return env.TRIM_PKGVAR;
  if (env.TRIM_APPDATA) return env.TRIM_APPDATA;
  return path.join(os.homedir(), '.apkstart');
}

/** 临时目录：TRIM_PKGTMP → TRIM_APPTEMP → <dataRoot>/tmp。 */
function resolveTempRoot(env, dataRoot) {
  if (env.TRIM_PKGTMP) return env.TRIM_PKGTMP;
  if (env.TRIM_APPTEMP) return env.TRIM_APPTEMP;
  return path.join(dataRoot, 'tmp');
}

/**
 * 由环境变量构造完整路径表。
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [codeRootOverride] 允许测试/单例显式覆盖代码根
 */
function buildPaths(env = process.env, codeRootOverride) {
  const APPDEST = codeRootOverride || resolveAppDest(env);
  const APPDATA = resolveDataRoot(env);
  const APPTEMP = resolveTempRoot(env, APPDATA);
  // 进程 HOME：Android AVD/SDK 的基址，交给 emulator 使用。
  const APPHOME = env.TRIM_APPHOME || APPDATA;

  const RUNTIME = path.join(APPDATA, 'runtime');
  const AVD = path.join(APPDATA, 'avd');
  const SHARED = path.join(APPDATA, 'shared');
  const ICONS = path.join(APPDATA, 'icons');
  const LOGS = path.join(APPDATA, 'logs');
  const DOWNLOADS = path.join(APPTEMP, 'downloads');
  const UPLOADS = path.join(APPTEMP, 'uploads');

  return {
    APPDEST,
    APPDATA,
    PKGVAR: APPDATA, // 语义别名，与 TRIM_PKGVAR 对齐
    APPTEMP,
    APPHOME,
    RUNTIME,
    AVD,
    SHARED,
    ICONS,
    LOGS,
    DOWNLOADS,
    UPLOADS,
    RUNTIME_MARKER: path.join(RUNTIME, '.deployed'),
    APPS_FILE: path.join(APPDATA, 'apps.json'),
    SETTINGS_FILE: path.join(APPDATA, 'settings.json'),
    SERVICE_PID: path.join(APPDATA, 'service.pid'),
    SERVICE_LOG: path.join(LOGS, 'service.log'),
    EMULATOR_LOG: path.join(LOGS, 'emulator.log'),
  };
}

/** 创建运行所需目录（幂等）。 */
function ensureDirs(paths) {
  const dirs = [
    paths.APPDATA, paths.RUNTIME, paths.AVD, paths.SHARED,
    paths.ICONS, paths.LOGS, paths.DOWNLOADS, paths.UPLOADS,
  ];
  for (const d of dirs) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) { /* 并发安全：忽略 EEXIST */ }
  }
}

/** 单例路径表（进程默认环境）。 */
const PATHS = buildPaths(process.env);

module.exports = { PATHS, buildPaths, ensureDirs, resolveAppDest, resolveDataRoot };
