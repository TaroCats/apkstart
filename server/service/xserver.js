'use strict';
/**
 * 宿主侧「带硬件 3D 的 X display」管理器（IMPL 偏差 5 改造方案，第 1~5 步）。
 *
 * 为什么需要它：`-gpu host` 走宿主 GL/Vulkan，必须先能连上一个 X display；
 * 而 `Xvfb` 与 TigerVNC 的 `Xvnc` 都**不支持** `-hw3d`（只能 llvmpipe 软渲染，
 * 实测 29553ms 无收益）。支持 `-hw3d` 的目前只有 KasmVNC 的 `Xkasmvnc`。
 *
 * 关键实测细节（10.31.0.4，见 docs/fnos/IMPL.md 偏差 5 更正）：
 *   - 命令行**必须**带 `-interface 127.0.0.1`。缺它时启动失败，报
 *     `vncExtInit: failed to bind socket, is someone else on our -websocketPort?:
 *      Address already in use (98)` —— 卡的是 **websocketPort**，不是 rfbport，
 *     也不是 `:N` 编号（简写日志把前半句「websocketPort」截掉了，极易误判）。
 *   - `-SecurityTypes None` 只绑回环时才安全，否则等于把无鉴权 VNC 暴露到局域网。
 *
 * 设计取舍：**不自带二进制**。KasmVNC 是 GPL-2.0（强 copyleft），随 MIT 包分发
 * 需要附源码/书面要约；且它还依赖 libxfont2 / libpixman-1-0 / libunwind8 /
 * libwebp7 / libxshmfence1 等独立 deb 包，干净 fnOS 未必齐备。因此本模块只做
 * 「探测 + 拉起 + 就绪判定」，二进制由宿主/运维提供（见 locate() 的候选顺序）。
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/** 默认 display 与端口（与真实可用命令行一致）。 */
const DEFAULT_DISPLAY_NUM = 9;
const BASE_RFB_PORT = 5996;
const BASE_WS_PORT = 6996;
const RENDER_NODE = '/dev/dri/renderD128';
const GEOMETRY = '1080x1920';
const DEPTH = 24;

/** 允许尝试的 display 槽位：占用时依次后退，避开别的应用留下的 :9。 */
const DISPLAY_SLOTS = [9, 10, 11, 12];
const START_TIMEOUT_MS = 10000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 构造 X server 命令行（纯函数，可单测）。
 * @param {{bin?:string, display?:string, renderNode?:string, rfbPort?:number,
 *          wsPort?:number, geometry?:string, depth?:number, xkbDir?:string}} o
 * @returns {string[]}
 */
function buildXserverArgs(o = {}) {
  const display = o.display || `:${DEFAULT_DISPLAY_NUM}`;
  const args = [
    display,
    '-hw3d',
    '-drinode', o.renderNode || RENDER_NODE,
    '-geometry', o.geometry || GEOMETRY,
    '-depth', String(o.depth || DEPTH),
    '-SecurityTypes', 'None',
    '-disableBasicAuth',
    // 缺这一行就起不来（websocketPort 绑定失败，报 98）。见文件头。
    '-interface', '127.0.0.1',
    '-rfbport', String(o.rfbPort || BASE_RFB_PORT),
    '-websocketPort', String(o.wsPort || BASE_WS_PORT),
    '-NeverShared',
  ];
  // 显式给 xkb 数据目录：不给时 X server 可能按编译期路径找不到 keymap，
  // 报 `XKB: Failed to compile keymap` → `Fatal server error: Failed to activate
  // virtual core keyboard` 后**直接退出**（真机踩过，表现是「X 起来 1 秒就没了」）。
  if (o.xkbDir) args.push('-xkbdir', o.xkbDir);
  return args;
}

/**
 * 本模块解析的全是 **POSIX 路径**（X11 的 `/tmp/.X11-unix`、`/usr/share/X11/xkb`、
 * 包内 `…/usr/bin/Xkasmvnc`），产品也只在 Linux 上跑。所以一律用 `path.posix`
 * 而不是 `path`：否则在 Windows 上跑单测时 `path.join('/opt/app','share','X11','xkb')`
 * 会变成 `\opt\app\share\X11\xkb`、`path.join('/usr/bin')` 会带出盘符 `D:\usr\bin`，
 * 断言全挂（CI 就是 Windows runner）。
 */
const P = path.posix;

/** 由可执行文件路径推断安装前缀（`…/usr/bin/Xkasmvnc` → `…/usr`）。 */
function prefixOf(bin) {
  const dir = P.dirname(bin);
  return P.basename(dir) === 'bin' ? P.dirname(dir) : dir;
}

/**
 * 选 xkb 数据目录（宿主或二进制自带树里找 `share/X11/xkb`）。
 * @param {string} bin
 * @param {(p:string)=>boolean} [exists]
 * @returns {string} 找不到返回空串（此时不传 `-xkbdir`，交给 X server 默认值）
 */
function pickXkbDir(bin, exists = fs.existsSync) {
  const cands = [
    P.join(prefixOf(bin), 'share', 'X11', 'xkb'),
    '/usr/share/X11/xkb',
    '/usr/local/share/X11/xkb',
  ];
  for (const c of cands) {
    if (exists(c)) return c;
  }
  return '';
}

/**
 * 选 X server 的工作目录。
 *
 * 某些 Xvnc 打包版本（真实案例：某第三方 fnOS 应用 vendor 的 `Xkasmvnc`）被改成
 * 从**相对路径** `.xkbbin/xkbcomp` 解析键盘编译器，因此必须把 cwd 放到含
 * `.xkbbin/xkbcomp` 的那一层，否则报
 *   sh: 1: .xkbbin/xkbcomp: not found → Failed to activate virtual core keyboard
 * 然后 X server fatal 退出。宿主 `/usr/bin/xkbcomp` 存在也没用：它根本不查 PATH。
 *
 * @returns {string} 找不到返回空串（用默认 cwd）
 */
function pickXkbBinCwd(bin, exists = fs.existsSync) {
  let dir = P.dirname(bin);
  for (let i = 0; i < 4; i += 1) {
    if (exists(P.join(dir, '.xkbbin', 'xkbcomp'))) return dir;
    const up = P.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return '';
}

/** 找 xkbcomp 可执行文件（软链目标）。找不到返回空串。 */
function findXkbcompBin(bin, exists = fs.existsSync) {
  const cands = [P.join(prefixOf(bin), 'bin', 'xkbcomp'), '/usr/bin/xkbcomp'];
  for (const c of cands) if (exists(c)) return c;
  // PATH 分隔符用 path.delimiter（Linux ':'，Windows ';'）：产品只在 Linux 跑，
  // 但单测在 Windows 上也要能扫到，硬编码 ':' 会把整条 PATH 当成一个目录。
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (d && exists(P.join(d, 'xkbcomp'))) return P.join(d, 'xkbcomp');
  }
  return '';
}

/**
 * 准备 X server 的工作目录（解决「相对 .xkbbin/xkbcomp」这个打包硬编码）。
 *
 * 只投放一个裸二进制时，`pickXkbBinCwd()` 找不到 `.xkbbin/`（那是 vendor 包的
 * 私有目录，体积/许可都不适合随我们分发）。但该二进制**不会退回查 PATH**，
 * 于是 `-xkbdir` 也救不了它 —— 真机上表现为 `sh: 1: .xkbbin/xkbcomp: not found`
 * → `Failed to activate virtual core keyboard` → fatal 退出。
 *
 * 因此这里在工作目录下造一个最小 shim：`<workRoot>/xkbroot/.xkbbin/xkbcomp`
 * 软链到宿主真实 xkbcomp，再把 cwd 放到 `<workRoot>/xkbroot`。实测（10.31.0.4）
 * 有此软链时 X server 可稳定存活并监听 6996。
 *
 * @returns {string} 可用作 cwd 的目录；都不行时返回空串（保持原样，让 fatal 暴露）
 */
function ensureXkbRoot(bin, workRoot, exists = fs.existsSync) {
  const direct = pickXkbBinCwd(bin, exists);
  if (direct) return direct;
  const xkbcomp = findXkbcompBin(bin, exists);
  if (!xkbcomp || !workRoot) return '';
  const root = P.join(workRoot, 'xkbroot');
  const dir = P.join(root, '.xkbbin');
  const link = P.join(dir, 'xkbcomp');
  try {
    fs.mkdirSync(dir, { recursive: true });
    let same = false;
    try { same = fs.readlinkSync(link) === xkbcomp; } catch (_) { same = false; }
    if (!same) {
      try { fs.unlinkSync(link); } catch (_) { /* 不存在，忽略 */ }
      // 显式 type='file'：POSIX 忽略该参数，但 Windows 上目标不存在时若不指定
      // 类型，Node 无法推断会直接失败（单测在 Windows runner 上跑）。
      fs.symlinkSync(xkbcomp, link, 'file');
    }
    return root;
  } catch (e) {
    return '';
  }
}

/** X server fatal 退出信号（用于立刻判失败，别傻等 10s）。 */
function parseFatalError(text) {
  return /Fatal server error/i.test(String(text || ''));
}

/** display 字符串 → 数字（`:9` → 9）；非法返回 NaN。 */
function parseDisplayNum(display) {
  const m = /^:(\d+)(\.\d+)?$/.exec(String(display || '').trim());
  return m ? Number(m[1]) : NaN;
}

/** X server 就绪的日志信号（KasmVNC 输出 vncext 两行）。 */
function parseReadyLog(text) {
  const s = String(text || '');
  return /vncext:.*Listening/i.test(s) || /Listening for websocket connections/i.test(s);
}

/** 启动失败的已知致命信号，用于判定「这个槽位不可用，换下一个」。 */
function parseBindConflict(text) {
  const s = String(text || '');
  return /Address already in use/i.test(s) || /server is already active/i.test(s);
}

/** 该二进制是否真的支持 `-hw3d`（否则拉起来也用不上 GPU，白费一个进程）。 */
function supportsHw3d(bin) {
  try {
    const r = spawnSync(bin, ['-help'], { timeout: 5000, encoding: 'utf8' });
    const text = `${r.stdout || ''}${r.stderr || ''}`;
    return /-hw3d/.test(text) && /-drinode/.test(text);
  } catch (_) {
    return false;
  }
}

/** X11 unix socket 路径（`/tmp/.X11-unix/X9`）。 */
/** X server 的 unix socket 路径（`:9` → `/tmp/.X11-unix/X9`）；非法 display 返回 null。 */
function socketPathFor(display, tmpDir = '/tmp') {
  const n = parseDisplayNum(display);
  return Number.isNaN(n) ? null : `${tmpDir}/.X11-unix/X${n}`;
}

/** 读进程命令行（读不到返回空串）。 */
function readProcCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch (_) {
    return '';
  }
}

/**
 * 清理陈旧的 display 占用。
 *
 * X server 被 SIGTERM/SIGKILL 杀掉时会遗留 `/tmp/.XN-lock` 与 socket 文件，
 * 下一次启动就一律报
 *   `Fatal server error: Cannot establish any listening sockets - Make sure an
 *    X server isn't already running`
 * 且**四个槽位全部失败**（真机踩过：先是 :9 失败，随后 :10/:11 依次留下垃圾，
 * 最终 auto 永久退化成 off）。所以拉起前必须先判定「真占用」还是「垃圾」。
 *
 * 判据：lock 里的 pid 还活着 **且** 命令行像 X server → 真占用（busy）；
 * 否则（pid 不存在 / pid 已被无关进程复用）→ 删 lock + socket（cleaned）。
 *
 * @returns {'busy'|'cleaned'|'absent'}
 */
function cleanStaleDisplay(display, deps = {}) {
  const exists = deps.exists || fs.existsSync;
  // lock/socket 根目录可注入：生产永远是 /tmp（X 的约定），单测里换成 os.tmpdir()
  // 才能在非 Linux 上真实落盘（Windows runner 没有 D:\tmp）。
  const tmpDir = deps.tmpDir || '/tmp';
  const n = parseDisplayNum(display);
  if (Number.isNaN(n)) return 'absent';
  const lock = `${tmpDir}/.X${n}-lock`;
  const sock = socketPathFor(display, tmpDir);

  let pid = NaN;
  if (exists(lock)) {
    try { pid = parseInt(String(fs.readFileSync(lock, 'utf8')).trim(), 10); } catch (_) { pid = NaN; }
  }
  if (Number.isFinite(pid) && pid > 0) {
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (alive) {
      const cmd = readProcCmdline(pid);
      // 读不到命令行（别的用户/权限受限）时宁可按占用处理，避免误杀别人。
      const looksLikeX = !cmd || /(^|\/)(Xkasmvnc|Xvnc|Xorg|X)(\s|$)/.test(cmd);
      if (looksLikeX) return 'busy';
    }
  }

  let cleaned = false;
  try { if (exists(lock)) { fs.unlinkSync(lock); cleaned = true; } } catch (_) { /* ignore */ }
  try { if (sock && exists(sock)) { fs.unlinkSync(sock); cleaned = true; } } catch (_) { /* ignore */ }
  return cleaned ? 'cleaned' : 'absent';
}

/** PATH 中查找可执行文件。 */
function whichInPath(name, envPath) {
  const dirs = String(envPath || '').split(':').filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) { /* 继续找 */ }
  }
  return null;
}

class XServer {
  /**
   * @param {{paths:object, settingsGetter?:()=>object, env?:NodeJS.ProcessEnv}} o
   */
  constructor({ paths, settingsGetter, env = process.env } = {}) {
    this.paths = paths || {};
    this.settingsGetter = settingsGetter || (() => ({}));
    this.env = env;
    this._child = null;
    this._display = null;
    this._bin = null;
    this._source = null;
    this._logs = [];
    this._hw3dCache = new Map();
  }

  _pushLog(line) {
    const text = String(line || '').replace(/\r$/, '');
    if (!text) return;
    this._logs.push(text);
    if (this._logs.length > 200) this._logs.splice(0, this._logs.length - 200);
    if (typeof this._onLog === 'function') this._onLog(text);
  }

  logs(n = 50) {
    return this._logs.slice(-n);
  }

  /**
   * 按优先级探测可用的 X server。**只认支持 `-hw3d` 的 Xkasmvnc**：
   * 普通 `Xvnc`(TigerVNC) / `Xvfb` 会被 supportsHw3d() 否掉，避免「拉起来但没 GPU」。
   *
   * 顺序：
   *   ① 显式路径 settings.emulator.xserverPath
   *   ② 环境变量 APKSTART_XSERVER
   *   ③ 数据根 runtime/xserver/Xkasmvnc（运维投放，升级不丢）
   *   ④ 代码根 runtime/xserver/Xkasmvnc（若将来真随包分发）
   *   ⑤ PATH 中的 Xkasmvnc
   *
   * @returns {{bin:string, source:string, hw3d:boolean}|null}
   */
  locate() {
    const cfg = (this.settingsGetter() || {}).emulator || {};
    const candidates = [];
    if (cfg.xserverPath) candidates.push({ bin: cfg.xserverPath, source: 'settings' });
    if (this.env.APKSTART_XSERVER) candidates.push({ bin: this.env.APKSTART_XSERVER, source: 'env' });
    if (this.paths.RUNTIME) {
      candidates.push({ bin: path.join(this.paths.RUNTIME, 'xserver', 'Xkasmvnc'), source: 'runtime-dir' });
    }
    if (this.paths.APPDEST) {
      candidates.push({ bin: path.join(this.paths.APPDEST, 'runtime', 'xserver', 'Xkasmvnc'), source: 'package-dir' });
    }
    const inPath = whichInPath('Xkasmvnc', this.env.PATH);
    if (inPath) candidates.push({ bin: inPath, source: 'PATH' });

    for (const c of candidates) {
      try {
        fs.accessSync(c.bin, fs.constants.X_OK);
      } catch (_) {
        continue;
      }
      const hw3d = this._supportsHw3d(c.bin);
      // 显式指定时即使探测不到也返回（让上层报明确原因），其余候选必须过 hw3d。
      if (hw3d || c.source === 'settings' || c.source === 'env') {
        return { bin: c.bin, source: c.source, hw3d };
      }
    }
    return null;
  }

  _supportsHw3d(bin) {
    if (!this._hw3dCache.has(bin)) this._hw3dCache.set(bin, supportsHw3d(bin));
    return this._hw3dCache.get(bin);
  }

  /** 已拉起、进程仍存活、且 socket 在 → 就绪。 */
  isReady() {
    if (!this._child || !this._display) return false;
    // 进程已退出时 exitCode 非 null —— socket 可能还残留，不能只信文件
    if (this._child.exitCode !== null) return false;
    const sock = socketPathFor(this._display);
    if (!sock) return false;
    try {
      fs.accessSync(sock, fs.constants.R_OK);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 供 `_spawnEnv()` 使用的 DISPLAY；未就绪时返回空串。 */
  displayEnv() {
    return this.isReady() ? this._display : '';
  }

  /**
   * 确保 X server 就绪（幂等）。失败不抛错，返回 `{ok:false, reason}`，
   * 由调用方决定降级 —— 起不来 X 不该让整个模拟器启动流程炸在异常上。
   * @returns {Promise<{ok:boolean, display?:string, bin?:string, reason?:string}>}
   */
  async ensureStarted() {
    if (this.isReady()) return { ok: true, display: this._display, bin: this._bin };

    const found = this.locate();
    if (!found) {
      return { ok: false, reason: '未找到支持 -hw3d 的 X server（Xkasmvnc）' };
    }
    if (!found.hw3d) {
      return { ok: false, reason: `${found.bin} 不支持 -hw3d/-drinode` };
    }

    // 槽位依次尝试：别的应用可能已经占了 :9 / 5996 / 6996。
    for (let i = 0; i < DISPLAY_SLOTS.length; i += 1) {
      const num = DISPLAY_SLOTS[i];
      const display = `:${num}`;
      // 先区分「真占用」与「上次被杀的垃圾 lock/socket」，否则一次异常退出会
      // 让后续所有启动都报 Cannot establish any listening sockets。
      const occ = cleanStaleDisplay(display);
      if (occ === 'busy') {
        this._pushLog(`[xserver] ${display} 已被其他进程占用，换下一个槽位`);
        continue;
      }
      if (occ === 'cleaned') this._pushLog(`[xserver] 已清理 ${display} 的陈旧 lock/socket`);

      const rfbPort = BASE_RFB_PORT + i * 10;
      const wsPort = BASE_WS_PORT + i * 10;
      // eslint-disable-next-line no-await-in-loop
      const r = await this._spawnOnce(found.bin, display, rfbPort, wsPort);
      if (r.ok) {
        this._source = found.source;
        this._pushLog(`[xserver] 就绪 ${display}（${found.bin}，rfb ${rfbPort} / ws ${wsPort}，source=${found.source}）`);
        return { ok: true, display, bin: found.bin };
      }
      if (!r.conflict) {
        return { ok: false, reason: r.reason };
      }
      this._pushLog(`[xserver] ${display} 端口冲突，尝试下一个槽位`);
    }
    return { ok: false, reason: '所有候选 display 槽位都被占用' };
  }

  /** 拉起一次并等到就绪或失败；conflict=true 表示「换槽位可能有用」。 */
  async _spawnOnce(bin, display, rfbPort, wsPort) {
    const xkbDir = pickXkbDir(bin);
    // 裸二进制没有 vendor 的 .xkbbin/ 目录时，就地造一个 xkbcomp 软链（见 ensureXkbRoot）。
    const xkbCwd = ensureXkbRoot(bin, this.paths.APPTEMP);
    const args = buildXserverArgs({ display, rfbPort, wsPort, xkbDir });
    let child;
    try {
      child = spawn(bin, args, {
        // cwd 对齐「相对路径 .xkbbin/xkbcomp」的打包布局（见 pickXkbBinCwd）。
        cwd: xkbCwd || this.paths.APPTEMP || undefined,
        env: { ...this.env, HOME: this.env.HOME || this.paths.APPHOME || '/tmp' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return { ok: false, reason: `X server 启动失败：${e.message}` };
    }

    let bootLog = '';
    const onData = (buf) => {
      const text = String(buf);
      bootLog += text;
      if (bootLog.length > 16384) bootLog = bootLog.slice(-16384);
      text.split('\n').forEach((l) => this._pushLog(l));
    };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);

    let exited = false;
    let exitCode = null;
    child.on('exit', (code) => { exited = true; exitCode = code; });
    child.on('error', (e) => { exited = true; bootLog += `\n[spawn-error] ${e.message}`; });

    this._child = child;
    this._display = display;
    this._bin = bin;

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // fatal 错误（xkb/keymap/gpu 初始化失败）不必等满超时
      if (parseFatalError(bootLog)) break;
      if (exited) break;
      if (parseReadyLog(bootLog) && this.isReady()) {
        // 「起来了但 1 秒就死」是真实存在的一种（XKB fatal 就是），
        // 因此就绪必须带一次存活复核，不能只看 socket 出现过。
        // eslint-disable-next-line no-await-in-loop
        await sleep(600);
        if (!exited && this.isReady()) return { ok: true };
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(200);
    }

    const conflict = parseBindConflict(bootLog) && !parseFatalError(bootLog);
    const tail = bootLog.split('\n').filter(Boolean).slice(-3).join(' | ');
    const reason = exited
      ? `X server 退出（code=${exitCode}）：${tail}`
      : `X server 未在 ${START_TIMEOUT_MS}ms 内稳定就绪：${tail}`;
    try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    this._child = null;
    this._display = null;
    return { ok: false, conflict, reason };
  }

  /** 收掉我们自己拉起的 X server（不留常驻进程，也不留垃圾 lock）。 */
  async stop() {
    if (!this._child) {
      // 也顺手清掉上一次异常退出残留的 lock/socket。
      if (this._display) cleanStaleDisplay(this._display);
      this._display = null;
      return { stopped: true, wasRunning: false };
    }
    const display = this._display;
    const child = this._child;
    this._child = null;
    try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
    for (let i = 0; i < 20 && child.exitCode === null && !child.killed; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(100);
      if (child.exitCode !== null) break;
    }
    try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    // X 被信号杀掉时不会自己删 lock/socket，这一步不做的话下次启动必失败。
    if (display) {
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
        // eslint-disable-next-line no-await-in-loop
        if (cleanStaleDisplay(display) !== 'busy') break;
      }
    }
    this._pushLog('[xserver] stopped');
    this._display = null;
    return { stopped: true, wasRunning: true };
  }

  status() {
    const found = this.locate();
    return {
      available: !!found && found.hw3d,
      bin: found ? found.bin : '',
      source: this._source || (found ? found.source : ''),
      hw3d: found ? found.hw3d : false,
      display: this.isReady() ? this._display : '',
      running: this.isReady(),
    };
  }
}

module.exports = {
  XServer,
  buildXserverArgs,
  parseDisplayNum,
  parseReadyLog,
  parseBindConflict,
  parseFatalError,
  pickXkbDir,
  pickXkbBinCwd,
  ensureXkbRoot,
  findXkbcompBin,
  cleanStaleDisplay,
  prefixOf,
  supportsHw3d,
  socketPathFor,
  DEFAULT_DISPLAY_NUM,
  RENDER_NODE,
};
