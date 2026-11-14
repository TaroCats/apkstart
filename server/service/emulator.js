'use strict';
/**
 * 无头 Android 模拟器托管（ARCH §4.2 / §5.2 / §5.4）。
 * - ensureAvd()：手写 AVD 配置（在线包通常不含 cmdline-tools，不走 avdmanager）
 * - buildArgs()：-no-window 无头；有 KVM 用 -accel on，否则降级 -accel off
 * - start()：spawn emulator → 等 sys.boot_completed=1（≤180s）
 * - stop()：adb emu kill → 等 → SIGKILL
 * - 环形日志缓冲供 /api/emulator/logs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { AdbClient } = require('../../core/adb');
const { checkKvmAccess } = require('./kvm');
const { XServer } = require('./xserver');
const { resolveGpuMode } = require('./gpu');
const { SYSTEM_IMAGE, SYSTEM_IMAGE_DIR } = require('../config');

const EMULATOR_PORT = 5554;
const BOOT_TIMEOUT_MS = 180000;
const LOG_LIMIT = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 正则转义（AVD 名来自 settings，不能假设它只含安全字符）。 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 扫描「仍持有同一 AVD 的模拟器进程」（IMPL 偏差 16）。
 *
 * 为什么读 `/proc/<pid>/cmdline` 而不调 `pgrep -f`：
 *   ① 不依赖 procps 是否装了；② `pgrep -f` 会把本进程自己的命令行（我们的日志里
 *   就会打印 `-avd apkstart`）也算命中，等于自杀；③ 不需要再解析一遍 ps 的列。
 *
 * 传给 emulator 的 `-avd` 是**整词**匹配：`-avd apkstart` 不能命中 `-avd apkstart2`。
 *
 * @param {string} avdName
 * @param {{procRoot?: string, selfPid?: number}} [opts] 测试用：喂人造 /proc 目录
 * @returns {Array<{pid: number, cmd: string}>}
 */
function scanAvdEmulators(avdName, opts = {}) {
  const hits = [];
  const want = String(avdName || '').trim();
  if (!want) return hits;
  const procRoot = opts.procRoot || '/proc';
  const selfPid = opts.selfPid || process.pid;
  const re = new RegExp(`(?:^|\\s)-avd\\s+${escapeRe(want)}(?:\\s|$)`);

  let names = [];
  try {
    names = fs.readdirSync(procRoot);
  } catch (_) {
    return hits; // 非 Linux（本地跑测试）没有 /proc，直接放弃
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === selfPid) continue;
    let cmd = '';
    try {
      cmd = fs.readFileSync(path.join(procRoot, name, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim();
    } catch (_) {
      continue; // 读不到（权限 / 已退出）就当没有
    }
    if (!cmd || !/qemu-system/.test(cmd)) continue;
    if (!re.test(cmd)) continue;
    hits.push({ pid, cmd });
  }
  return hits;
}

/**
 * 开机后需要禁用的系统组件（ARCH 追加需求，IMPL 偏差 9）。
 *
 * 背景（10.31.0.4 真机实测）：无头模拟器缺少 netsim / bluetooth packet streamer，
 * emulator 日志持续打印
 *   WARNING | Unable to connect to packet streamer, no bluetooth emulation available
 *   WARNING | Failed to init netsim Wifi packet stream, fall back to previous network stack.
 * 于是 com.android.bluetooth 的 HAL 拿不到后端，进程反复崩溃，系统弹出
 * 「Bluetooth keeps stopping」对话框并抢走前台焦点：
 *   POST /api/apps/<pkg>/start → {started:true,foreground:true}
 *   数秒后 /api/status.foregroundPackage 变回 com.google.android.apps.nexuslauncher
 *   期间 /api/screen/frame 截到的是带弹窗的脏图。
 * 只 `pm disable-user --user 0` 当次会话有效，重启模拟器后复发；
 * 必须先 `adb root` 再整包 `pm disable`（持久化）才彻底消失。
 */
const HARDENING_BLUETOOTH_PKG = 'com.android.bluetooth';

/**
 * 生成开机后加固的 shell 命令序列（纯函数，便于单测）。
 * 顺序有意义：先 `pm disable`（持久化）→ `pm disable-user`（对当前用户立即生效）
 * → `am force-stop`（杀掉已经崩到半死的进程）→ `settings` 关掉蓝牙总开关。
 *
 * @param {{disableBluetooth?: boolean}} opts
 * @return {string[]} 需要依次执行的 adb shell 命令；空数组表示无需加固。
 */
function buildHardeningPlan(opts = {}) {
  const disableBluetooth = opts.disableBluetooth !== false;
  if (!disableBluetooth) return [];
  const pkg = HARDENING_BLUETOOTH_PKG;
  return [
    `pm disable ${pkg}`,
    `pm disable-user --user 0 ${pkg}`,
    `am force-stop ${pkg}`,
    'settings put global bluetooth_on 0',
  ];
}

/**
 * 解析 `pm list packages -d` 的输出，返回已禁用包名数组（纯函数，便于单测）。
 * 每行形如 `package:com.android.bluetooth`，可能带 \r 或前导空白。
 *
 * @param {string} text
 * @return {string[]}
 */
function parseDisabledPackages(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('package:'))
    .map((line) => line.slice('package:'.length).trim())
    .filter(Boolean);
}

class EmulatorManager {
  constructor({ paths, provision, settingsGetter, xserver }) {
    this.paths = paths;
    this.provision = provision;
    this.settingsGetter = settingsGetter || (() => ({ emulator: {} }));
    this.state = 'stopped';
    this.error = null;
    this.bootMs = null;
    this.pid = null;
    this._child = null;
    this._adb = null;
    this._logs = [];
    this._startedAt = 0;
    // 硬件 3D X display 管理器（IMPL 偏差 5 改造方案）。可注入以便单测替身。
    this.xserver = xserver || new XServer({ paths, settingsGetter: this.settingsGetter });
    if (typeof this.xserver._onLog !== 'function') {
      this.xserver._onLog = (line) => this._pushLog(line);
    }
    // 最近一次 start() 实际使用的 gpu 模式与裁决原因（供 /api/status 展示）
    this.gpu = { mode: 'off', want: 'auto', reason: '', message: '' };
  }

  _settings() {
    const s = this.settingsGetter() || {};
    return s.emulator || {};
  }

  _emulatorBin() {
    return path.join(this.paths.RUNTIME, 'emulator', 'emulator');
  }

  _adbBin() {
    const s = this.settingsGetter() || {};
    return AdbClient.resolveAdb(s.adbPath, this.paths.APPDATA);
  }

  adb() {
    if (!this._adb) {
      // 注意：serial 必须是 adb server 内的设备名 emulator-5554，
      // 不能用 127.0.0.1:5554 —— 5554 是 emulator 的 console 端口，
      // adb 走 5555，且模拟器向 adb server 注册的名字是 emulator-<consolePort>。
      // 写 127.0.0.1:5554 会永远 not found（真机实测）。
      this._adb = new AdbClient({ adbPath: this._adbBin(), serial: `emulator-${EMULATOR_PORT}` });
    }
    return this._adb;
  }

  _pushLog(line) {
    const text = String(line || '').replace(/\r$/, '');
    if (!text) return;
    this._logs.push(text);
    if (this._logs.length > LOG_LIMIT) this._logs.splice(0, this._logs.length - LOG_LIMIT);
  }

  logs(n = 200) {
    const k = Math.max(1, Math.min(Number(n) || 200, LOG_LIMIT));
    return this._logs.slice(-k);
  }

  /** 手写 AVD 配置（ARCH §5.4）。已存在且不 wipe 且镜像标签一致则复用。 */
  ensureAvd({ wipe = false, gpuMode } = {}) {
    const cfg = this._settings();
    const name = cfg.name || 'apkstart';
    const memMB = this._effectiveMemMB(cfg);
    // 与 DEFAULT_SETTINGS 保持一致；start() 已裁决过就直接用裁决结果，
    // 避免 config.ini 与命令行 `-gpu` 自相矛盾（历史 bug：写死 swiftshader_indirect）。
    const mode = gpuMode || this._effectiveGpu(cfg);
    const avdHome = this.paths.AVD;
    const avdDir = path.join(avdHome, `${name}.avd`);
    const iniPath = path.join(avdHome, `${name}.ini`);
    const configPath = path.join(avdDir, 'config.ini');

    // 镜像标签变更（如 google_apis_playstore → google_apis）时旧 AVD 的
    // userdata 与新系统镜像不兼容，必须重建，避免 boot 失败。
    if (!wipe && fs.existsSync(configPath)) {
      let oldTag = '';
      try {
        const old = fs.readFileSync(configPath, 'utf8');
        const m = /^tag\.id=(.*)$/m.exec(old);
        oldTag = m ? m[1].trim() : '';
      } catch (_) { /* ignore */ }
      if (oldTag && oldTag !== SYSTEM_IMAGE.tag) wipe = true;
    }

    fs.mkdirSync(avdDir, { recursive: true });

    if (wipe) {
      try { fs.rmSync(avdDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      try { fs.rmSync(iniPath, { force: true }); } catch (_) { /* ignore */ }
      fs.mkdirSync(avdDir, { recursive: true });
    }

    const ini = [
      'avd.ini.encoding=UTF-8',
      `path=${avdDir}`,
      `target=android-${SYSTEM_IMAGE.apiLevel}`,
      '',
    ].join('\n');
    fs.writeFileSync(iniPath, ini, 'utf8');

    const config = [
      `image.sysdir.1=${SYSTEM_IMAGE_DIR}/`,
      `abi.type=${SYSTEM_IMAGE.abi}`,
      'hw.cpu.arch=x86_64',
      `tag.id=${SYSTEM_IMAGE.tag}`,
      'tag.display=Google APIs',
      'PlayStore.enabled=no',
      'hw.lcd.width=1080',
      'hw.lcd.height=1920',
      'hw.lcd.density=420',
      `hw.ramSize=${memMB}`,
      'disk.dataPartition.size=4G',
      `hw.gpu.enabled=${mode === 'off' ? 'no' : 'yes'}`,
      `hw.gpu.mode=${mode}`,
      'hw.keyboard=yes',
      'hw.mainKeys=no',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, config, 'utf8');
    return { name, avdDir, iniPath, configPath };
  }

  /** /dev/dri/renderD128 是否可读写（包用户若能读才允许用 render node 后端）。 */
  _renderNodeUsable() {
    try {
      fs.accessSync('/dev/dri/renderD128', fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 生效 GPU 模式（ARCH §1.4 / IMPL 偏差 5 更正后的完整前提）。
   *
   * 三条前提缺一不可，任一不满足就降级 `-gpu off`：
   *   ① 一个带硬件 3D 的 X display（`-gpu host` 走宿主 GL，无 X 时 QEMU 2s 崩）
   *   ② `/dev/dri/renderD128` 可读写（`render` 组）
   *   ③ 模式本身不是 `off`
   *
   * 旧实现只校验 ②，**漏了 ①**：没有 X 的机器上用户把 gpu 改成 host/swiftshader
   * 就是 2 秒静默崩溃。这里补齐，并把裁决原因留在 `this.gpu` 供状态接口展示。
   *
   * @param {object} [cfg] emulator 段设置
   * @param {{hasDisplay?:boolean}} [opts] 测试注入（默认按 xserver 探测结果）
   */
  _resolveGpu(cfg, opts = {}) {
    const s = cfg || this._settings();
    let hasDisplay = opts.hasDisplay;
    if (hasDisplay === undefined) {
      // 计划阶段按「可用」算（binary 支持 -hw3d 即可），真正拉起在 start() 里做。
      const found = this.xserver.locate();
      hasDisplay = this.xserver.isReady() || !!(found && found.hw3d);
    }
    return resolveGpuMode({
      want: s.gpu,
      hasDisplay,
      renderNodeUsable: this._renderNodeUsable(),
      autoEnabled: s.gpuAutoEnable !== false,
    });
  }

  /** 兼容旧调用点：只取模式字符串。 */
  _effectiveGpu(cfg) {
    return this._resolveGpu(cfg).mode;
  }

  /**
   * 开机后加固：禁用在无头模拟器里必然崩溃的系统组件，避免系统弹窗抢占前台
   * 并污染截图（IMPL 偏差 9）。必须在 _waitBoot() 之后、置 running 之前调用。
   *
   * 设计约束：**永不让启动失败**。任何一步失败只写日志并继续，
   * 最差退化成「有弹窗」的旧行为，而不是把一个已经开好机的模拟器判死。
   *
   * @return {Promise<{skipped: boolean, root: boolean, steps: Array<object>}>}
   */
  async _postBootHardening() {
    const cfg = this._settings();
    const plan = buildHardeningPlan({ disableBluetooth: cfg.disableBluetooth !== false });
    if (!plan.length) {
      this._pushLog('[hardening] disableBluetooth=false，跳过系统组件加固');
      return { skipped: true, root: false, steps: [] };
    }

    const adb = this.adb();
    const steps = [];

    // 1) adb root —— `pm disable` 需要 root 权限。
    //    模拟器默认镜像是 userdebug，root 可用；个别镜像不支持时只跳过加固。
    try {
      await adb.exec(['root'], { timeout: 15000 });
      // adbd 以 root 重启发牌，退出码先返回、服务还没起好；
      // 立刻执行 pm 会拿到 "device offline"/"closed"，等 2s 最稳。
      await sleep(2000);
      this._pushLog('[hardening] adb root 成功，等待 adbd 重启 2s');
    } catch (e) {
      this._pushLog(`[hardening] adb root 不可用（${e.message}），跳过需要 root 的加固步骤`);
      return { skipped: false, root: false, steps };
    }

    // 2) 逐条执行加固命令
    for (const cmd of plan) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const out = await adb.shell(cmd, { timeout: 15000 });
        const text = String(out || '').trim();
        steps.push({ cmd, ok: true, out: text });
        this._pushLog(`[hardening] ${cmd} → ok${text ? ` (${text})` : ''}`);
      } catch (e) {
        steps.push({ cmd, ok: false, error: e.message });
        this._pushLog(`[hardening] ${cmd} → 失败（${e.message}）`);
      }
    }

    // 3) 自检：把「是否真的进了 disabled 列表」写进日志，便于线上排查复发
    try {
      const out = await adb.shell('pm list packages -d', { timeout: 15000 });
      const disabled = parseDisabledPackages(out);
      const missing = disabled.includes(HARDENING_BLUETOOTH_PKG) ? [] : [HARDENING_BLUETOOTH_PKG];
      this._pushLog(
        `[hardening] 已禁用组件: ${disabled.join(',') || '(无)'}`
        + (missing.length ? `；未生效: ${missing.join(',')}` : ''),
      );
      steps.push({ verify: 'pm list packages -d', disabled, missing });
    } catch (e) {
      this._pushLog(`[hardening] 自检失败（${e.message}）`);
    }

    return { skipped: false, root: true, steps };
  }

  _effectiveMemMB(cfg) {
    const v = Number(cfg.memoryMB) || 0;
    if (v > 0) return Math.min(v, 4096);
    // 0=自动：按物理内存的 1/4，封顶 4096，兜底 2048
    try {
      const total = Math.round(require('os').totalmem() / (1024 * 1024));
      return Math.max(1024, Math.min(4096, Math.round(total / 4)));
    } catch (_) {
      return 2048;
    }
  }

  _effectiveCores(cfg) {
    const v = Number(cfg.cores) || 0;
    if (v > 0) return Math.min(v, 8);
    try {
      return Math.max(1, Math.min(4, Math.floor((require('os').cpus().length || 2) / 2)));
    } catch (_) {
      return 2;
    }
  }

  /** ARCH §5.2 buildArgs。 */
  buildArgs({ avdName, port, memMB, cores, kvmWritable, gpu, wipe }) {
    const accel = kvmWritable ? 'on' : 'off';
    const args = [
      '-avd', avdName,
      '-no-window', '-no-audio', '-no-boot-anim',
      '-gpu', gpu || 'off',
      '-accel', accel,
      '-port', String(port || EMULATOR_PORT),
      '-no-snapshot-save',
    ];
    if (memMB) args.push('-memory', String(memMB));
    if (cores) args.push('-cores', String(cores));
    if (wipe) args.push('-wipe-data');
    return args;
  }

  _spawnEnv(extra = {}) {
    // HOME 必须指向**可写**目录：包用户没有自己的家目录（/home/apkstart-fnos 不存在，
    // 父目录 root 属主也建不出来），emulator 会报
    //   Failed to create /home/apkstart-fnos for shader cache (Permission denied)
    // 然后关掉 shader cache。指向数据根既解决权限，也避免把缓存写进系统目录。
    const home = this.paths.APPHOME || this.paths.APPDATA;
    try {
      fs.mkdirSync(home, { recursive: true });
    } catch (_) { /* 建不出来就让 emulator 自己降级，不阻断启动 */ }
    return {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: path.join(home, '.cache'),
      ANDROID_AVD_HOME: this.paths.AVD,
      ANDROID_SDK_ROOT: this.paths.RUNTIME,
      ANDROID_HOME: this.paths.RUNTIME,
      ANDROID_SDK_HOME: this.paths.APPHOME,
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '0',
      // 必须与 core/adb.js 的 _adbEnv() 取同一个值（默认 5044）：
      // 模拟器把设备注册到「它自己的 ANDROID_ADB_SERVER_PORT 对应的 adb server」上，
      // 若两端不同值（旧实现漏传 → 模拟器去 5037，客户端走 5044），
      // 客户端就永远看不到设备（真机实测：5037 被宿主其他 adb server 占用）。
      ANDROID_ADB_SERVER_PORT: process.env.ANDROID_ADB_SERVER_PORT || '5044',
      // DISPLAY 只在 X server 确实就绪时传（IMPL 偏差 5 改造方案 第 3 步）。
      // 绝不能传一个假值：`-gpu != off` 且 DISPLAY 不可连时 QEMU 2s 内崩。
      ...extra,
    };
  }

  /**
   * emulator 子进程的工作目录。**必须显式给，不能继承服务进程的 cwd。**
   *
   * 真机（10.31.0.4）踩坑：管理员用 `su -s /bin/sh apkstart-fnos -c …` 从 `/root`
   * 启动服务时，cwd 继承成 `/root`（0700 root），包用户连 `..`/`.` 都读不了 →
   * QEMU 起 2s 内静默退出，日志里只有一句
   *   WARNING | QEMU main loop exits abnormally with code 1
   * 前后**没有任何错误行**；而 `-gpu off` 同一时刻能正常开机 → 很容易误判成
   * 「fnOS 显卡不能让 emulator 用」。实测同一台机：cwd=/root → host 必失败；
   * cwd=/ → host 正常（`vulkan_mode_selected:host`，boot 28.7s）。
   * 结论：包用户的可预期性不能依赖平台/运维怎么拉起服务。
   *
   * @returns {string|undefined} 建不出来时返回 undefined（退回继承 cwd，不阻断启动）
   */
  _spawnCwd() {
    const dir = this.paths.APPTEMP || this.paths.APPDATA;
    if (!dir) return undefined;
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch (_) {
      return undefined;
    }
  }

  /** AVD 目录（<AVD>/<name>.avd）。 */
  _avdDir(avdName) {
    return path.join(this.paths.AVD, `${avdName}.avd`);
  }

  /** AVD 目录下的锁文件（hardware-qemu.ini.lock / multiinstance.lock 等）。 */
  _avdLockFiles(avdName) {
    try {
      return fs
        .readdirSync(this._avdDir(avdName))
        .filter((f) => f.endsWith('.lock'))
        .map((f) => path.join(this._avdDir(avdName), f));
    } catch (_) {
      return [];
    }
  }

  /**
   * 启动前「腾出」这个 AVD（IMPL 偏差 16）。
   *
   * 现场：上一个服务实例没停干净，它的 qemu 还活着并持有 AVD（root 身份），
   * 我们再 spawn 就被 emulator 直接判死：
   *   FATAL | Running multiple emulators with the same AVD is an experimental feature.
   *   FATAL | Please use -read-only flag to enable this feature.
   * 然后 GPU 降级逻辑以为是「host 不行」，又用 -gpu off 重试一次，同样撞死——
   * 白等一轮、日志还把真正的因由埋在两段启动输出里。
   *
   * 处理顺序：SIGTERM → 等 → SIGKILL → 等 → 仍在则抛 CONFLICT（无权杀别人的进程时，
   * 唯一正确的做法是把话说清楚，而不是反复重试）。
   * 顺带清掉死进程留下的陈旧锁文件：它们会让 emulator 误以为已有实例。
   */
  async _releaseAvd(avdName, { termWaitMs = 6000, procRoot } = {}) {
    const selfPid = this._child ? this._child.pid : undefined;
    // procRoot 仅供单测注入伪造的 /proc（真机上永远是默认 /proc）
    const scan = () => scanAvdEmulators(avdName, { selfPid, procRoot });

    const orphans = scan();
    if (orphans.length) {
      for (const o of orphans) {
        this._pushLog(`[avd] 发现同一 AVD 的遗留模拟器 pid=${o.pid}，先回收：${o.cmd.slice(0, 160)}`);
        try {
          process.kill(o.pid, 'SIGTERM');
        } catch (e) {
          if (e && e.code === 'EPERM') this._pushLog(`[avd] 无权结束 pid=${o.pid}（EPERM）`);
        }
      }
      const deadline = Date.now() + termWaitMs;
      while (Date.now() < deadline && scan().length) await sleep(200);
      for (const o of scan()) {
        this._pushLog(`[avd] pid=${o.pid} 未响应 SIGTERM，改用 SIGKILL`);
        try {
          process.kill(o.pid, 'SIGKILL');
        } catch (_) { /* 记录在后面统一处理 */ }
      }
      if (scan().length) await sleep(300);

      const still = scan();
      if (still.length) {
        const who = still.map((x) => `pid=${x.pid}`).join('、');
        const err = new Error(
          `另一个使用 AVD「${avdName}」的模拟器还在运行（${who}），当前用户无权结束它。` +
            `请先停掉占用该 AVD 的实例（例如停掉另一个 ApkStart 服务，或手动 kill ${still[0].pid}）后再启动。`
        );
        err.code = 'CONFLICT';
        this._pushLog(`[avd] ${err.message}`);
        throw err;
      }
      this._pushLog('[avd] 遗留模拟器已回收');
    }

    for (const f of this._avdLockFiles(avdName)) {
      try {
        fs.unlinkSync(f);
        this._pushLog(`[avd] 清理陈旧锁 ${path.basename(f)}`);
      } catch (_) { /* 删不掉不影响启动，emulator 会自己判断 */ }
    }
  }

  /**
   * 启动模拟器并等待 boot_completed。返回 {status:'running', bootMs}。
   * 失败抛错（code: RUNTIME_NOT_READY / CONFLICT / EMULATOR_ERROR）。
   *
   * 若启用了 GPU（`-gpu != off`）却启动失败，自动用 `-gpu off` 重试一次：
   * 宿主 GL/X 环境的坏法千奇百怪（Mesa 升级、驱动缺失、X 半死），
   * 不值得让用户因为「开了加速反而起不来」而回不去。降级路径一定会告知日志。
   */
  async start({ wipe = false } = {}) {
    if (this.state === 'running' || this.state === 'starting') {
      const err = new Error('模拟器已在运行或启动中');
      err.code = 'CONFLICT';
      throw err;
    }
    if (!this.provision.status().deployed) {
      const err = new Error('运行时尚未部署，请先完成运行时部署');
      err.code = 'RUNTIME_NOT_READY';
      throw err;
    }

    // 先清空上一次的日志，再让 _prepareGpu 把「为什么用/不用 GPU」写进来；
    // _startOnce 不再清空，否则用户拿到的日志里看不到降级原因。
    this._logs = [];
    const gpu = await this._prepareGpu();
    try {
      return await this._startOnce({ wipe, gpuMode: gpu.mode, display: this.xserver.displayEnv() });
    } catch (e) {
      if (gpu.mode === 'off') throw e;
      // AVD 被另一个实例（或孤儿进程）占着，换 -gpu off 一样起不来。
      // 白白多跑一轮 180s 的等待，还会让日志里出现两段启动输出、掩盖真正的原因。
      if (e.code === 'CONFLICT') {
        this._pushLog('[gpu] AVD 冲突与 GPU 无关，不做 -gpu off 重试');
        try { await this.xserver.stop(); } catch (_) { /* ignore */ }
        throw e;
      }
      this._pushLog(`[gpu] -gpu ${gpu.mode} 启动失败（${e.message}），自动降级 off 重试`);
      // 「一句 QEMU main loop exits abnormally、前后全无错误行」是 QEMU 在**极早期**
      // 退出的特征（cwd 读不了 / AVD 锁 / 端口），不是显卡能力问题。留条线索，
      // 省得下次又去翻 Mesa 版本（真机踩过：真因是 cwd 继承成 /root）。
      if (/进程已退出/.test(String(e.message || ''))) {
        this._pushLog('[gpu] 提示：若上方只有「QEMU main loop exits abnormally」且无其他错误，'
          + '先看 [start] 行里的 cwd 是否可被包用户读取，再排查 AVD 锁与 5554 端口');
      }
      try { await this.stop(); } catch (_) { /* ignore */ }
      await this.xserver.stop();
      this.state = 'stopped';
      this.gpu = { mode: 'off', want: gpu.want, reason: 'fallback-after-failure', message: `-gpu ${gpu.mode} 启动失败，已降级 off` };
      return this._startOnce({ wipe, gpuMode: 'off', display: '' });
    }
  }

  /**
   * 决定本次启动的 GPU 模式，并在需要时把硬件 3D 的 X display 拉起来。
   * @returns {Promise<{mode:string, want:string, reason:string, message:string}>}
   */
  async _prepareGpu() {
    const cfg = this._settings();
    // 显式配了 xserverPath 却被忽略时要说出来：locate() 会因为「文件不存在 /
    // 不可执行」直接跳到下一个候选，用户否则永远不知道自己的配置没生效。
    const configured = String(cfg.xserverPath || '').trim();
    if (configured) {
      const found = this.xserver.locate();
      if (!found || found.source !== 'settings') {
        this._pushLog(`[gpu] 配置的 xserverPath=${configured} 不可用，已改用 ${found ? `${found.source}:${found.bin}` : '（无可用 X server）'}`);
      }
    }
    let r = this._resolveGpu(cfg);
    if (r.mode === 'off') {
      if (r.reason !== 'configured-off') this._pushLog(`[gpu] ${r.message}`);
      this.gpu = r;
      return r;
    }
    const xr = await this.xserver.ensureStarted();
    if (!xr.ok) {
      r = {
        mode: 'off',
        want: r.want,
        reason: 'no-xserver',
        message: `X server 未就绪（${xr.reason}），已降级为 -gpu off`,
      };
      this._pushLog(`[gpu] ${r.message}`);
      this.gpu = r;
      return r;
    }
    this.gpu = r;
    this._pushLog(`[gpu] ${r.message}（DISPLAY=${xr.display}）`);
    return r;
  }

  /** 单次启动（不含降级重试）。 */
  async _startOnce({ wipe = false, gpuMode = 'off', display = '' } = {}) {
    this.state = 'starting';
    this.error = null;
    this._startedAt = Date.now();
    // 不清空 _logs：start() 已经在调 _prepareGpu 之前清过一次，里面是 GPU 裁决
    // 与降级原因，清掉就等于「我配了 host 为什么是 off」查无实据。

    const cfg = this._settings();
    const kvm = checkKvmAccess();
    const avdName = cfg.name || 'apkstart';
    // 先把 AVD 腾出来：遗留实例的 qemu 还活着时，emulator 会直接 FATAL 退出，
    // 而错误文案（"multiple emulators with the same AVD"）不会告诉我们是谁占了。
    // 失败要把状态落到 error：否则调用方看到的是「一直在 starting」，前端转圈不停。
    try {
      await this._releaseAvd(avdName);
    } catch (e) {
      this.state = 'error';
      this.error = e.message;
      throw e;
    }
    this.ensureAvd({ wipe, gpuMode });

    const bin = this._emulatorBin();
    if (!fs.existsSync(bin)) {
      this.state = 'error';
      this.error = '未找到 emulator 可执行文件，请重新部署运行时';
      const err = new Error(this.error);
      err.code = 'RUNTIME_NOT_READY';
      throw err;
    }

    const args = this.buildArgs({
      avdName,
      port: EMULATOR_PORT,
      memMB: this._effectiveMemMB(cfg),
      cores: this._effectiveCores(cfg),
      kvmWritable: kvm.writable,
      gpu: gpuMode,
      wipe,
    });

    this._pushLog(`[start] ${bin} ${args.join(' ')}`);
    // cwd 一并打出来：`-gpu host` 静默失败时，第一个要排除的就是「cwd 包用户读不了」。
    const cwd = this._spawnCwd();
    this._pushLog(`[start] KVM available=${kvm.available} writable=${kvm.writable} accel=${kvm.writable ? 'on' : 'off'} gpu=${gpuMode}${display ? ` display=${display}` : ''} cwd=${cwd || '(继承)'}`);

    const env = this._spawnEnv(display ? { DISPLAY: display } : {});
    const child = spawn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    this._child = child;
    this.pid = child.pid;

    const onData = (buf) => String(buf).split('\n').forEach((l) => this._pushLog(l));
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    child.on('error', (e) => {
      this._pushLog(`[error] ${e.message}`);
      this.error = `模拟器进程启动失败：${e.message}`;
      this.state = 'error';
    });
    child.on('exit', (code, signal) => {
      this._pushLog(`[exit] code=${code} signal=${signal}`);
      this._child = null;
      this.pid = null;
      if (this.state === 'running' || this.state === 'starting') {
        this.state = 'stopped';
        if (code) this.error = `模拟器进程已退出（code=${code}）`;
      } else if (this.state === 'stopping') {
        this.state = 'stopped';
      }
    });

    // 等待 boot_completed
    try {
      await this._waitBoot();
    } catch (e) {
      this._pushLog(`[boot-fail] ${e.message}`);
      this.error = e.message;
      try { await this.stop(); } catch (_) { /* ignore */ }
      this.state = 'error';
      const err = new Error(e.message);
      err.code = 'EMULATOR_ERROR';
      throw err;
    }

    // 先记下真实开机耗时，再加固（加固的 2~4s 不该算进 bootMs）
    this.bootMs = Date.now() - this._startedAt;
    this._pushLog(`[boot] boot_completed in ${this.bootMs}ms`);

    // 开机后加固（IMPL 偏差 9）：无头模拟器没有 netsim/蓝牙后端，com.android.bluetooth
    // 必然反复崩，系统弹「keeps stopping」抢前台并把弹窗画进截图。加固失败只记日志。
    const hardenAt = Date.now();
    try {
      await this._postBootHardening();
    } catch (e) {
      this._pushLog(`[hardening] 异常（忽略，不影响启动）: ${e.message}`);
    }
    this._pushLog(`[hardening] 完成，耗时 ${Date.now() - hardenAt}ms`);

    this.state = 'running';
    return { status: 'running', bootMs: this.bootMs };
  }

  async _waitBoot() {
    const adb = this.adb();
    await adb.connect().catch(() => {});
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let online = false;
    while (Date.now() < deadline) {
      // 进程已退出（崩溃 / 参数错误 / GPU 初始化失败 / AVD 被锁）→ 立即失败。
      // 旧实现判断 `_child === null && state === 'error'`，但 child.on('exit') 在
      // starting 状态把 state 置为 'stopped'，条件永不成立 → 白等满 180s，
      // 最后抛一句「可能硬件加速不可用」误导排查（真机实测：模拟器 33s 已开机成功）。
      if (!this._child) throw new Error(this.error || '模拟器进程已退出');
      // eslint-disable-next-line no-await-in-loop
      if (!online) online = await adb.isOnline().catch(() => false);
      if (online) {
        // eslint-disable-next-line no-await-in-loop
        const v = await adb.shell('getprop sys.boot_completed', { timeout: 8000 }).catch(() => '');
        if (String(v).trim() === '1') return true;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    // 超时：抓一次现场，给可诊断信息（而不是归因于「硬件加速」）
    let devicesText = '(获取失败)';
    try {
      const r = await adb.exec(['devices'], { withSerial: false, timeout: 8000 });
      devicesText = String(r.stdout || '').trim() || '(空)';
    } catch (_) { /* 采集失败不影响报错 */ }
    const alive = this._child ? 'yes' : 'no';
    throw new Error(
      `模拟器启动超时（${Math.round(BOOT_TIMEOUT_MS / 1000)}s 内未完成开机）。`
      + `进程存活=${alive}；adb devices: ${devicesText}；`
      + `请检查 ${this.paths.APPDATA} 下的 emulator 日志`,
    );
  }

  /** 优雅停止：adb emu kill → 等待 → SIGKILL。幂等。 */
  async stop() {
    if (this.state === 'stopped' && !this._child) {
      // 模拟器本来就没跑，但可能还留着上次拉起的 X server（异常退出场景）
      try { await this.xserver.stop(); } catch (_) { /* ignore */ }
      return { stopped: true };
    }
    this.state = 'stopping';
    const adb = this.adb();
    try { await adb.exec(['emu', 'kill'], { timeout: 10000 }); } catch (_) { /* ignore */ }
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && this._child) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(500);
    }
    if (this._child) {
      try { this._child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      await sleep(500);
    }
    this._child = null;
    this.pid = null;
    this.state = 'stopped';
    // 模拟器停了就把我们自己拉起的 X server 一起收掉：不留常驻进程，
    // 也不用担心它长期占着 renderD128 / 5996 / 6996（IMPL 偏差 5 改造方案）。
    try { await this.xserver.stop(); } catch (_) { /* ignore */ }
    this._pushLog('[stop] stopped');
    return { stopped: true };
  }

  /** 进程 RSS（MB），尽力采集，取不到 null。 */
  _rssMB() {
    if (!this.pid) return null;
    try {
      const txt = fs.readFileSync(`/proc/${this.pid}/status`, 'utf8');
      const m = /VmRSS:\s*(\d+)\s*kB/.exec(txt);
      if (m) return Math.round(Number(m[1]) / 1024);
    } catch (_) { /* 非 Linux 或无权限 */ }
    return null;
  }

  /** 聚合状态（Engine 会再包一层）。 */
  status() {
    // 若声明 running 但进程已消失 → 纠正为 stopped
    if (this.state === 'running' && !this._child) this.state = 'stopped';
    let xserver = null;
    try { xserver = this.xserver.status(); } catch (_) { /* ignore */ }
    return {
      state: this.state,
      pid: this.pid,
      bootMs: this.bootMs,
      rssMB: this._rssMB(),
      error: this.error,
      // GPU 裁决结果：mode 是实际生效值，want 是配置值，reason 是降级原因。
      // 前端/日志靠这个解释「为什么我配了 host 却是 off」。
      gpu: { ...this.gpu },
      xserver,
    };
  }
}

module.exports = {
  EmulatorManager,
  scanAvdEmulators,
  EMULATOR_PORT,
  BOOT_TIMEOUT_MS,
  HARDENING_BLUETOOTH_PKG,
  buildHardeningPlan,
  parseDisabledPackages,
};
