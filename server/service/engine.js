'use strict';
/**
 * 引擎聚合层（ARCH §1.2 / §4.3 / §5）：持有单例状态，向 API 暴露聚合视图。
 * - ensureAdb()：确保 adb server 可用
 * - status()：组装 StatusVO
 * - healthCheck()：运行中周期性探测 screencap，连续失败判定运行时异常
 * - shutdown()：优雅停机（停模拟器、关 adb 输入通道）
 */
const { execFile } = require('child_process');
const { AdbClient } = require('../../core/adb');
const foreground = require('./foreground');

const HEALTH_INTERVAL_MS = 10000;
const SCREEN_FAIL_LIMIT = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Engine {
  constructor({ paths, provision, emulator, store }) {
    this.paths = paths;
    this.provision = provision;
    this.emulator = emulator;
    this.store = store;
    this._timer = null;
    this._closed = false;
    this._health = {
      adbConnected: false,
      consecutiveScreenFail: 0,
      lastOkAt: null,
      foregroundPackage: null,
      foregroundDetail: null,
      screen: null,
    };
  }

  /** 启动后台健康巡检。 */
  async init() {
    await this.ensureAdb().catch(() => false);
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => {
      this.healthCheck().catch(() => { /* 巡检异常不影响主流程 */ });
    }, HEALTH_INTERVAL_MS);
    if (this._timer.unref) this._timer.unref();
    return true;
  }

  /** 拉起 adb server。 */
  ensureAdb() {
    return new Promise((resolve) => {
      const s = this.store ? this.store.getSettings() : {};
      const adbBin = AdbClient.resolveAdb(s.adbPath, this.paths.APPDATA);
      execFile(adbBin, ['start-server'], {
        timeout: 20000,
        env: { ...process.env, ANDROID_ADB_SERVER_PORT: process.env.ANDROID_ADB_SERVER_PORT || '5044' },
      }, (err) => resolve(!err));
    });
  }

  /** @returns {Promise<{adbConnected:boolean}>} */
  async healthCheck() {
    if (this._closed) return { adbConnected: false };
    const st = this.emulator.status();
    if (st.state !== 'running') {
      this._health.adbConnected = false;
      this._health.consecutiveScreenFail = 0;
      return { adbConnected: false };
    }
    const adb = this.emulator.adb();
    const online = await adb.isOnline().catch(() => false);
    this._health.adbConnected = online;

    if (!online) {
      this._health.consecutiveScreenFail += 1;
    } else {
      try {
        const png = await adb.screenshot();
        if (Buffer.isBuffer(png) && png.length > 8) {
          this._health.consecutiveScreenFail = 0;
          this._health.lastOkAt = Date.now();
        } else {
          this._health.consecutiveScreenFail += 1;
        }
      } catch (_) {
        this._health.consecutiveScreenFail += 1;
      }
      // 采集前台包与分辨率（失败不影响健康判定）
      // 注意：不能用 runningPackages()[0] —— 那只是「进程存活列表」的顺序，
      // 系统崩溃弹窗抢走焦点时它仍会返回应用包名，导致 /api/status 谎报前台。
      // 这里用 dumpsys 的 mResumedActivity 解析真实窗口焦点（IMPL 偏差 9）。
      try {
        const fg = await foreground.current(adb);
        this._health.foregroundPackage = fg ? fg.package : null;
        this._health.foregroundDetail = fg ? { activity: fg.activity, source: fg.source, systemSurface: fg.systemSurface } : null;
      } catch (_) { /* ignore */ }
      try {
        const sz = await adb.wmSize();
        if (sz) this._health.screen = { width: sz.width, height: sz.height };
      } catch (_) { /* ignore */ }
    }

    if (this._health.consecutiveScreenFail >= SCREEN_FAIL_LIMIT) {
      this.emulator.state = 'error';
      this.emulator.error = '模拟器无响应（连续多次截屏失败），请尝试重启模拟器';
    }
    return { adbConnected: this._health.adbConnected };
  }

  /**
   * 组装 StatusVO（§3.3）。
   * @returns {object}
   */
  status() {
    const rt = this.provision.status();
    const emu = this.emulator.status();
    const running = emu.state === 'running';
    return {
      runtime: { deployed: rt.deployed, phase: this.provision.progress().phase },
      emulator: emu.state,
      adbConnected: running ? this._health.adbConnected : false,
      foregroundPackage: running ? (this._health.foregroundPackage || null) : null,
      // 附加字段（§3.3 之外的补充）：说明前台来源与「是否是系统弹窗/桌面」，
      // 便于前端与线上排查区分「应用真在前台」和「弹窗抢了焦点」。
      foregroundDetail: running ? (this._health.foregroundDetail || null) : null,
      screen: running ? (this._health.screen || null) : null,
      kvm: { available: rt.kvm.available, writable: rt.kvm.writable },
      // GPU 裁决与 X server 探测结果：让「我配了 host 为何是 off」在接口里可解释，
      // 不用去翻 service.log（IMPL 偏差 5 改造方案第 5 步的可观测性部分）。
      gpu: emu.gpu,
      xserver: emu.xserver,
      bootMs: emu.bootMs,
      rssMB: running ? emu.rssMB : null,
      error: emu.error || (this.provision.progress().error || null),
    };
  }

  /** 优雅停机：停模拟器 → 关 adb 输入通道。 */
  async shutdown() {
    this._closed = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    try { await this.emulator.stop(); } catch (_) { /* ignore */ }
    try { this.emulator.adb().disposeInput(); } catch (_) { /* ignore */ }
    // 给子进程一点清理时间
    await sleep(200);
    return true;
  }
}

module.exports = { Engine };
