'use strict';
/**
 * 真实前台应用探测（dumpsys 解析）。
 *
 * 为什么单独抽一层：
 *   系统级崩溃弹窗（如「Bluetooth keeps stopping」）出现时，应用会被挤到后台，
 *   但 `runningPackages()` 仍然能列出它（进程还活着）。旧实现直接取列表第一个当
 *   前台，于是接口谎报 `foreground: true` —— 用户看到的是弹窗，接口说应用在前台。
 *   这里只认「窗口焦点」事实：topResumedActivity / ResumedActivity / mResumedActivity
 *   / mCurrentFocus / mFocusedApp，宁可如实报告前台是弹窗宿主（甚至 `android`），
 *   也不谎报。
 *
 * ⚠️ 字段随 Android 版本变化（真机实测，Android 14 / API 34 / google_apis x86_64 /
 *   emulator 37.3.8.0）：
 *     Android 9/10 及更早  → `mResumedActivity: ActivityRecord{...}`
 *     Android 11+          → `ResumedActivity: ActivityRecord{...}`，
 *                            并在最前面多一行 `topResumedActivity=ActivityRecord{...}`
 *   新版机器上 **`mResumedActivity` 一行都没有**。只认 `mResumedActivity` 会在此类
 *   机器上恒定返回 null（曾在 6c3f9dfe 上真实发生）。因此按优先级依次尝试全部 5 种。
 *
 * ⚠️ ANR / 崩溃弹窗（偏差 11）：弹窗窗口里没有 `<pkg>/<activity>`，形如
 *   `mCurrentFocus=Window{7061971 u0 Application Not Responding: com.android.systemui}`。
 *   而弹窗弹出时 `topResumedActivity` **仍指向弹窗底下的那个 Activity**（不会变成弹窗），
 *   所以必须先判弹窗、再看 Activity 栈，否则又变成「用户看到无响应，接口说应用在前台」。
 *
 * 纯解析函数可单测（不依赖 adb），夹具全部取自真机原文（见 test/fnos-unit.js）。
 */

/**
 * 各字段的正则。约束：
 *   - 只在 `ActivityRecord{...}` / `Window{...}` **包裹体内**抓取（`[^}]*?`），
 *     不对整段 dumpsys 做贪婪匹配，避免误抓其他行里的包名；
 *   - `ActivityRecord` 里包名跟在 `<token> uN ` 之后（N 可能是两位数 user id），
 *     包名之后紧跟 `/`；
 *   - `topResumedActivity=` 用 `=`，另外两个用 `:`。
 */
const RE_TOP_RESUMED = /topResumedActivity=\s*ActivityRecord\{[^}]*?\su\d+\s+([A-Za-z0-9_.]+)\/([.\w$]+)/;
const RE_RESUMED = /(?:^|\s)ResumedActivity:\s*ActivityRecord\{[^}]*?\su\d+\s+([A-Za-z0-9_.]+)\/([.\w$]+)/;
const RE_M_RESUMED = /mResumedActivity:\s*ActivityRecord\{[^}]*?\su\d+\s+([A-Za-z0-9_.]+)\/([.\w$]+)/;
const RE_CURRENT_FOCUS = /mCurrentFocus=(?:Window|ActivityRecord)\{[^}]*?\su\d+\s+([A-Za-z0-9_.]+)\/([.\w$]+)/;
const RE_FOCUSED_APP = /mFocusedApp=(?:Window|ActivityRecord)\{[^}]*?\su\d+\s+([A-Za-z0-9_.]+)\/([.\w$]+)/;

/**
 * 系统级弹窗（ANR / 崩溃）的焦点窗口。真机原文（Android 14）：
 *   mCurrentFocus=Window{7061971 u0 Application Not Responding: com.android.systemui}
 *   mCurrentFocus=Window{626b07c u0 Application Not Responding: system}
 *   mCurrentFocus=Window{... u0 Application Error: com.example.app}
 * 这类窗口里 **没有 `<pkg>/<activity>`**，只有一个弹窗标题 + 被弹的进程名，
 * 所以 RE_CURRENT_FOCUS / RE_FOCUSED_APP 一条都匹配不上（偏差 11）。
 */
const RE_DIALOG_ANR = /mCurrentFocus=Window\{[^}]*?\su\d+\s+Application Not Responding:\s+([A-Za-z0-9_.]+)\}/;
const RE_DIALOG_ERROR = /mCurrentFocus=Window\{[^}]*?\su\d+\s+Application Error:\s+([A-Za-z0-9_.]+)\}/;
const DIALOG_SOURCES = [
  { name: 'Application Not Responding', re: RE_DIALOG_ANR },
  { name: 'Application Error', re: RE_DIALOG_ERROR },
];

/**
 * 优先级顺序（命中即停）。resumedGroup 来自 `dumpsys activity activities`，
 * focusGroup 来自 `dumpsys window`；mFocusedApp 在 window 里也有。
 */
const RESUMED_SOURCES = [
  { name: 'topResumedActivity', re: RE_TOP_RESUMED },
  { name: 'ResumedActivity', re: RE_RESUMED },
  { name: 'mResumedActivity', re: RE_M_RESUMED },
];
const FOCUS_SOURCES = [
  { name: 'mCurrentFocus', re: RE_CURRENT_FOCUS },
  { name: 'mFocusedApp', re: RE_FOCUSED_APP },
];

/**
 * 按给定来源列表依次匹配，返回第一处命中。
 * @param {string} text
 * @param {Array<{name: string, re: RegExp}>} sources
 * @returns {{package: string, activity: string, source: string}|null}
 */
function matchFirst(text, sources) {
  const s = String(text || '');
  if (!s) return null;
  for (const item of sources) {
    const m = item.re.exec(s);
    if (m) return { package: m[1], activity: m[2], source: item.name };
  }
  return null;
}

/**
 * 解析 `dumpsys activity activities` 输出里的「已恢复 Activity」。
 * 兼容 topResumedActivity=（Android 11+）/ ResumedActivity:（Android 11+）/
 * mResumedActivity:（Android 9/10）。
 * @param {string} dump
 * @returns {{package: string, activity: string, source: string}|null}
 */
function parseResumedActivity(dump) {
  return matchFirst(dump, RESUMED_SOURCES);
}

/**
 * 解析 `dumpsys window` 输出里的焦点窗口。
 * 兼容 mCurrentFocus=（Window 或 ActivityRecord 包裹）/ mFocusedApp=。
 * @param {string} dump
 * @returns {{package: string, activity: string, source: string}|null}
 */
function parseCurrentFocus(dump) {
  return matchFirst(dump, FOCUS_SOURCES);
}

/**
 * 解析 ANR / 崩溃弹窗窗口。
 *
 * `topResumedActivity` 在弹窗弹出时**仍然是弹窗底下那个 Activity**，所以只靠
 * resumed 会谎报「应用在前台」——用户看到的其实是「应用无响应」。弹窗窗口
 * 没有 `<pkg>/<activity>` 形态，必须单独识别。
 *
 * `system` / `system_server` 不是合法包名，统一归一成 `android`（`isSystemSurface`
 * 对 `android` 恒为 true）。
 *
 * @param {string} focusDump `dumpsys window` 的输出
 * @returns {{package: string, activity: string, source: string, systemSurface: boolean}|null}
 */
function parseSystemDialog(focusDump) {
  const hit = matchFirst(focusDump, DIALOG_SOURCES);
  if (!hit) return null;
  const pkg = hit.package;
  const normalized = pkg === 'system' || pkg === 'system_server' ? 'android' : pkg;
  return { package: normalized, activity: '', source: 'dialog', systemSurface: true };
}

/**
 * 是否「系统弹窗 / 系统界面」的宿主包名。
 * 这些包名出现在前台，说明用户看到的不是我们的应用（而是弹窗、桌面、系统 UI）。
 * @param {string} pkg
 * @returns {boolean}
 */
function isSystemSurface(pkg) {
  const p = String(pkg || '');
  if (!p) return false;
  if (p === 'android') return true;
  return /^com\.android\.(systemui|settings|bluetooth|nfc|permissioncontroller|packageinstaller)$/.test(p)
    || p === 'com.google.android.apps.nexuslauncher'
    || /\blauncher\b/i.test(p);
}

/**
 * 给解析结果补上 `systemSurface` 标记（null 原样透传）。
 * @param {{package: string, activity: string, source: string}|null} hit
 * @returns {{package: string, activity: string, source: string, systemSurface: boolean}|null}
 */
function withSurface(hit) {
  if (!hit) return null;
  return { ...hit, systemSurface: isSystemSurface(hit.package) };
}

/**
 * 组合判定：弹窗 > 「已恢复 Activity」三兄弟（最权威）> 窗口焦点两个字段。
 * @param {{resumed?: string, focus?: string}} dumps
 * @returns {{package: string, activity: string, source: string, systemSurface: boolean}|null}
 */
function pickForeground(dumps) {
  const d = dumps || {};
  const dialog = parseSystemDialog(d.focus);
  if (dialog) return dialog;
  return withSurface(parseResumedActivity(d.resumed) || parseCurrentFocus(d.focus));
}

/** 采集已恢复 Activity 的 shell 命令（大小写不敏感，覆盖新旧三种字段）。 */
const CMD_RESUMED = 'dumpsys activity activities | grep -iE "topResumedActivity|ResumedActivity"';
/** 采集窗口焦点的 shell 命令。用 `dumpsys window`（`dumpsys window windows` 在新版上已非首选）。 */
const CMD_FOCUS = 'dumpsys window | grep -iE "mCurrentFocus|mFocusedApp"';

/**
 * 采集当前前台（需要 adb 客户端）。失败返回 null，绝不抛错 —— 调用方都是
 * 「健康采集」路径，不能因为一次 dumpsys 失败影响状态上报。
 *
 * 采样顺序：**先窗口焦点，后 Activity 栈**。原因是 ANR / 崩溃弹窗弹出时
 * `topResumedActivity` 仍指向弹窗底下的 Activity，先看 resumed 就会谎报
 * 「应用在前台」；而弹窗一定持有窗口焦点（偏差 11）。
 * 两条命令各自 try/catch，任一条失败都不影响另一条。
 * @param {{shell: function(string, object=): Promise<string>}} adb
 * @returns {Promise<{package: string, activity: string, source: string, systemSurface: boolean}|null>}
 */
async function current(adb) {
  let focus = '';
  try {
    focus = await adb.shell(CMD_FOCUS, { timeout: 10000 });
  } catch (_) {
    focus = '';
  }
  // 弹窗优先级最高：命中即返回，不再看 Activity 栈
  const dialog = parseSystemDialog(focus);
  if (dialog) return dialog;

  let resumed = '';
  try {
    resumed = await adb.shell(CMD_RESUMED, { timeout: 10000 });
  } catch (_) {
    resumed = '';
  }
  return withSurface(parseResumedActivity(resumed) || parseCurrentFocus(focus));
}

/**
 * 轮询等待某个包成为真实前台（`am start` 之后 Activity 需要一点时间 resume）。
 * 返回最后一次采样结果；超时也返回最后采样（可能是 null 或别的包名），绝不抛错。
 *
 * 为什么不是「睡固定时间再查一次」：慢机器上固定 500ms 可能还没 resume，
 * 会得到桌面包名 → 误判启动失败；快机器上则白等。轮询两者都兼顾。
 *
 * 默认窗口为什么是 12s（偏差 11 / P1）：目标机是 `-gpu off` 软件渲染，
 * 冷启动除了 `Displayed ... +2s101ms` 还有 splash → main 的切换，真机上从
 * `am start` 到 `topResumedActivity` 变成目标包要 4~10s。原来 4s 的窗口太窄，
 * 最后采样正好落在桌面上，于是 start 接口把刚启动成功的应用报成 launcher。
 *
 * @param {{shell: function(string, object=): Promise<string>}} adb
 * @param {string} pkg 期望成为前台的包名
 * @param {{timeoutMs?: number, intervalMs?: number, sample?: function}} opts
 * @return {Promise<{package: string, activity: string, source: string, systemSurface: boolean}|null>}
 */
async function waitForPackage(adb, pkg, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 12000;
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 500;
  const sample = typeof opts.sample === 'function' ? opts.sample : current;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    last = await sample(adb);
    if (last && !last.systemSurface && last.package === pkg) return last;
    if (Date.now() >= deadline) return last;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = {
  parseResumedActivity,
  parseCurrentFocus,
  parseSystemDialog,
  isSystemSurface,
  pickForeground,
  current,
  waitForPackage,
  CMD_RESUMED,
  CMD_FOCUS,
  RE_TOP_RESUMED,
  RE_RESUMED,
  RE_M_RESUMED,
  RE_CURRENT_FOCUS,
  RE_FOCUSED_APP,
  RE_DIALOG_ANR,
  RE_DIALOG_ERROR,
  /** @deprecated 保留旧导出名，等价于 RE_M_RESUMED（Android 9/10 专用）。 */
  RESUMED_RE: RE_M_RESUMED,
  FOCUS_RE: RE_CURRENT_FOCUS,
};
