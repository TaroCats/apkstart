'use strict';
/**
 * 安装流水线（ARCH §4.3 / §5.3）：
 *   install -r → 解析 launcher → am start → 存活观察 → 写 store
 * 保留上游的「闪退重试 / 存活观察」精髓，去掉 .lnk/ICO 等 Windows 副作用。
 */
const fs = require('fs');
const { AdbClient, friendlyInstallError, friendlyLaunchError } = require('../../core/adb');
const { SYSTEM_IMAGE } = require('../config');
const foreground = require('./foreground');

/** 无 lib/ → 纯 Java 不算 armOnly；有 abi 且不含 x86/x86_64 → armOnly。 */
function isArmOnly(abis) {
  if (!abis || abis.length === 0) return false;
  return !abis.some((a) => a === 'x86' || a === 'x86_64');
}

/**
 * arm64-only 应用在当前运行时镜像下不可运行的统一中文说明。
 * google_apis 镜像不含 ARM 翻译层，故直接判为 UNSUPPORTED（不做兼容镜像下载）。
 */
const ARM_ONLY_MESSAGE =
  '当前运行时镜像不含 ARM 翻译层，暂不支持 arm64-only 应用（P1 将支持可切换镜像）';

function errWith(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

class Installer {
  constructor({ paths, store, emulator, uploads }) {
    this.paths = paths;
    this.store = store;
    this.emulator = emulator;
    this.uploads = uploads; // Map<uploadId, {path, parsed, expiresAt}>
  }

  _adb() {
    return this.emulator.adb();
  }

  _assertRunning() {
    if (this.emulator.state !== 'running') {
      throw errWith('EMULATOR_DOWN', '模拟器未运行，请先启动模拟器');
    }
  }

  /** 由 APK 上传 id 安装并（尽力）启动，返回 AppVO。 */
  async install(uploadId) {
    this._assertRunning();
    const entry = this.uploads.get(uploadId);
    if (!entry || !entry.path || !fs.existsSync(entry.path)) {
      throw errWith('BAD_REQUEST', '上传已失效或不存在，请重新上传 APK');
    }
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      try { fs.rmSync(entry.path, { force: true }); } catch (_) { /* ignore */ }
      this.uploads.delete(uploadId);
      throw errWith('BAD_REQUEST', '上传已过期，请重新上传 APK');
    }

    const parsed = entry.parsed;
    const adb = this._adb();

    // 0) arm64-only 预判：当前 google_apis 镜像无 ARM 翻译层，直接明确拒绝
    //    （不做静默失败、也不尝试下载兼容镜像），并清理上传暂存。
    if (isArmOnly(parsed.abis || [])) {
      try { fs.rmSync(entry.path, { force: true }); } catch (_) { /* ignore */ }
      this.uploads.delete(uploadId);
      throw errWith('UNSUPPORTED', ARM_ONLY_MESSAGE);
    }

    // 1) 安装
    try {
      await adb.install(entry.path);
    } catch (e) {
      const raw = String(e.raw || e.message || '');
      if (e.code === 'NO_MATCHING_ABIS' || /NO_MATCHING_ABIS/.test(raw)) {
        // 兜底：清单未声明 ABI 但设备仍拒绝时，同样归类为 arm64-only 不支持
        throw errWith('UNSUPPORTED', ARM_ONLY_MESSAGE);
      }
      throw errWith('INTERNAL', friendlyInstallError(raw));
    }

    // 2) 解析 launcher（清单里可能解析不到）
    let activity = parsed.launchActivity || null;
    if (!activity) {
      try {
        const resolved = await adb.resolveLauncher(parsed.package);
        if (resolved && resolved.startsWith(`${parsed.package}/`)) {
          activity = resolved.split('/')[1];
        }
      } catch (_) { /* ignore */ }
    }

    // 3) 落盘图标
    let iconFile = '';
    if (parsed.iconPng) {
      try { iconFile = this.store.saveIcon(parsed.package, parsed.iconPng); } catch (_) { /* ignore */ }
    }

    const now = new Date().toISOString();
    const appRecord = {
      package: parsed.package,
      label: parsed.label,
      versionName: parsed.versionName,
      versionCode: parsed.versionCode,
      launchActivity: activity,
      abis: parsed.abis || [],
      armOnly: isArmOnly(parsed.abis || []),
      iconFile,
      sizeBytes: parsed.sizeBytes,
      installedAt: now,
      lastStartedAt: null,
    };

    // 4) 尽力启动（失败不阻断安装落盘，但把中文原因抛给上层，让用户看到 4xx 而非 500）
    let launchError = null;
    try {
      await adb.startApp(parsed.package, activity);
      appRecord.lastStartedAt = now;
    } catch (e) {
      launchError = friendlyLaunchError(String(e.crash || e.message || ''), parsed.package);
    }

    const saved = this.store.upsertApp(appRecord);
    // 清理上传暂存
    try { fs.rmSync(entry.path, { force: true }); } catch (_) { /* ignore */ }
    this.uploads.delete(uploadId);

    if (launchError) {
      // 安装成功但启动失败：以 422 + 中文原因返回，避免 500
      throw errWith('UNSUPPORTED', `应用已安装，但启动失败：${launchError}`);
    }

    // 前台与否如实判断（见偏差 9）：装完刚 am start，别直接断言 foreground=true。
    // 同样显式传 12s（偏差 11 / P1：软件渲染下 splash→main 要 4~10s）。
    let isForeground = null;
    try {
      const fg = await foreground.waitForPackage(adb, parsed.package, { timeoutMs: 12000 });
      if (fg) isForeground = !fg.systemSurface && fg.package === parsed.package;
    } catch (_) {
      isForeground = null;
    }

    return this._toAppVO(saved, true, isForeground);
  }

  /** 启动已安装应用。 */
  async startApp(pkg, activity) {
    this._assertRunning();
    const app = this.store.getApp(pkg);
    if (!app) throw errWith('NOT_FOUND', '未找到该应用，请先安装');
    const adb = this._adb();
    let act = activity || app.launchActivity || null;
    if (!act) {
      try {
        const resolved = await adb.resolveLauncher(pkg);
        if (resolved && resolved.startsWith(`${pkg}/`)) act = resolved.split('/')[1];
      } catch (_) { /* ignore */ }
    }
    try {
      await adb.startApp(pkg, act);
    } catch (e) {
      throw errWith('INTERNAL', friendlyLaunchError(String(e.crash || e.message || ''), pkg));
    }
    this.store.upsertApp({ ...app, lastStartedAt: new Date().toISOString() });
    // 语义澄清（IMPL 偏差 9）：started=已下发 am start 且未报错；
    // foregroundNow=事后用 dumpsys 的 mResumedActivity 复核的真实前台包名。
    // 系统崩溃弹窗（如「Bluetooth keeps stopping」）会立刻抢回焦点，
    // 所以这里绝不返回「foreground: true」这种乐观断言，宁可如实给 null/别的包名。
    let foregroundNow = null;
    let foregroundIsApp = null;
    try {
      // 显式传 12s：目标机 `-gpu off` 软件渲染，splash→main 切换要 4~10s，
      // 4s 窗口会把刚启动成功的应用报成桌面（偏差 11 / P1）。
      const fg = await foreground.waitForPackage(adb, pkg, { timeoutMs: 12000 });
      if (fg) {
        foregroundNow = fg.package;
        foregroundIsApp = !fg.systemSurface && fg.package === pkg;
      }
    } catch (_) {
      foregroundNow = null;
      foregroundIsApp = null;
    }
    return { started: true, activity: act, foregroundNow, foregroundIsApp };
  }

  /** 停止（force-stop）已安装应用。 */
  async stopApp(pkg) {
    const app = this.store.getApp(pkg);
    if (!app) throw errWith('NOT_FOUND', '未找到该应用');
    if (this.emulator.state === 'running') {
      try { await this._adb().forceStop(pkg); } catch (_) { /* ignore */ }
    }
    return { stopped: true };
  }

  /** 卸载并从 store 移除。 */
  async uninstall(pkg) {
    const app = this.store.getApp(pkg);
    if (!app) throw errWith('NOT_FOUND', '未找到该应用');
    if (this.emulator.state === 'running') {
      try { await this._adb().uninstall(pkg); } catch (_) { /* 忽略：可能已不存在 */ }
    }
    this.store.removeApp(pkg);
    try {
      const iconAbs = this.store.iconPath(pkg);
      if (fs.existsSync(iconAbs)) fs.rmSync(iconAbs, { force: true });
    } catch (_) { /* ignore */ }
    return { removed: true };
  }

  /** store 记录 → AppVO（§3.3）。running/foreground 由调用方决定是否覆盖。 */
  _toAppVO(app, running, foreground) {
    return {
      package: app.package,
      label: app.label,
      versionName: app.versionName,
      versionCode: app.versionCode,
      iconDataUri: this.store.iconDataUri(app.package),
      installedAt: app.installedAt,
      running: running === undefined ? null : running,
      foreground: foreground === undefined ? null : foreground,
    };
  }

  toAppVO(app, running, foreground) {
    return this._toAppVO(app, running, foreground);
  }
}

module.exports = { Installer, isArmOnly, AdbClient, SYSTEM_IMAGE };
