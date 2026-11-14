'use strict';
/**
 * fnOS 侧纯函数单测（不依赖 adb / 模拟器 / 网络 / 文件系统）。
 * 运行：npm test（已加入 package.json 的 test 链）
 *
 * 覆盖范围（对应 IMPL 偏差 9）：
 *   1. server/service/emulator.js —— 开机后加固计划与 `pm list packages -d` 解析
 *   2. server/service/foreground.js —— dumpsys 前台包名解析与轮询
 * 这些逻辑过去只靠真机（10.31.0.4）验证，改错一行就得重打包重部署，
 * 因此把「可纯函数化的部分」全部抽出来单测。
 */

const {
  buildHardeningPlan,
  parseDisabledPackages,
  HARDENING_BLUETOOTH_PKG,
  EmulatorManager,
  scanAvdEmulators,
} = require('../server/service/emulator');
const {
  parseResumedActivity,
  parseCurrentFocus,
  parseSystemDialog,
  isSystemSurface,
  pickForeground,
  waitForPackage,
  current,
  CMD_RESUMED,
  CMD_FOCUS,
} = require('../server/service/foreground');
const {
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
  socketPathFor,
} = require('../server/service/xserver');
const { resolveGpuMode } = require('../server/service/gpu');

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  // 注意：不能「先调用一次看是不是 Promise」——那会让每个异步用例跑两遍，
  // 第一遍的 rejection 没人接，直接变成 unhandled 崩溃（曾把 50ms 轮询用例
  // 干扰成「只采了 1 次」）。按函数类型判断即可。
  if (fn && fn.constructor && fn.constructor.name === 'AsyncFunction') {
    pending.push({ name, fn });
    return;
  }
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || '断言失败'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/* ------------------------------------------------------------------ */
console.log('\n[emulator.js / 开机后加固]');

test('默认计划禁用蓝牙：先 pm disable，再 disable-user，再 force-stop，最后关总开关', () => {
  const plan = buildHardeningPlan();
  assertEqual(plan.length, 4, '默认应有 4 条命令');
  assertEqual(plan[0], `pm disable ${HARDENING_BLUETOOTH_PKG}`);
  assertEqual(plan[1], `pm disable-user --user 0 ${HARDENING_BLUETOOTH_PKG}`);
  assertEqual(plan[2], `am force-stop ${HARDENING_BLUETOOTH_PKG}`);
  assertEqual(plan[3], 'settings put global bluetooth_on 0');
});

test('`pm disable` 必须排在 `pm disable-user` 之前（前者才持久化）', () => {
  const plan = buildHardeningPlan({ disableBluetooth: true });
  const iDisable = plan.indexOf(`pm disable ${HARDENING_BLUETOOTH_PKG}`);
  const iDisableUser = plan.indexOf(`pm disable-user --user 0 ${HARDENING_BLUETOOTH_PKG}`);
  assert(iDisable >= 0 && iDisableUser >= 0, '两条命令都应存在');
  assert(iDisable < iDisableUser, 'pm disable 必须在前');
});

test('disableBluetooth=false → 空计划（设置里可关掉加固）', () => {
  assertEqual(buildHardeningPlan({ disableBluetooth: false }).length, 0);
});

test('disableBluetooth 缺省（undefined）按 true 处理，向后兼容旧 settings.json', () => {
  assertEqual(buildHardeningPlan({}).length, 4);
});

test('parseDisabledPackages 解析 pm 输出（含 \\r 与空行）', () => {
  const out = 'package:com.android.bluetooth\r\n\r\n  package:com.android.wallpaper  \n';
  const list = parseDisabledPackages(out);
  assertEqual(list.length, 2, '应解析出 2 个包');
  assertEqual(list[0], 'com.android.bluetooth');
  assertEqual(list[1], 'com.android.wallpaper');
});

test('parseDisabledPackages 忽略非 package: 行与空输入', () => {
  assertEqual(parseDisabledPackages('').length, 0);
  assertEqual(parseDisabledPackages(null).length, 0);
  assertEqual(parseDisabledPackages('Error: no devices').length, 0);
  assertEqual(parseDisabledPackages('package:com.android.bluetooth').includes(HARDENING_BLUETOOTH_PKG), true);
});

/* ------------------------------------------------------------------ */
console.log('\n[foreground.js / 真实前台解析]');

/*
 * ⚠️ 以下夹具**逐字复制自真机原文**（10.31.0.4 / Android 14 / API 34 /
 * google_apis x86_64 / emulator 37.3.8.0），不是凭记忆编的。
 * 血泪教训：6c3f9dfe 版本只认 `mResumedActivity`，而这台机器上**根本没有这个字段**
 * （Android 11+ 改成了 topResumedActivity= / ResumedActivity:），于是恒返回 null，
 * 把本来能用的前台探测改坏了。所以夹具必须来自真机 dump。
 *
 * adb shell dumpsys activity activities | grep -iE "ResumedActivity"
 * adb shell dumpsys window | grep -iE "mCurrentFocus|mFocusedApp"
 */

// —— 真机原文：应用在前台 ——
const REAL_ACTIVITIES_DUMP = [
  '    topResumedActivity=ActivityRecord{7394cdb u0 com.simplemobiletools.flashlight/.activities.MainActivity t14}',
  '  ResumedActivity: ActivityRecord{7394cdb u0 com.simplemobiletools.flashlight/.activities.MainActivity t14}',
].join('\n');
const REAL_ACTIVITIES_TOP_ONLY = '    topResumedActivity=ActivityRecord{7394cdb u0 com.simplemobiletools.flashlight/.activities.MainActivity t14}';
const REAL_ACTIVITIES_RESUMED_ONLY = '  ResumedActivity: ActivityRecord{7394cdb u0 com.simplemobiletools.flashlight/.activities.MainActivity t14}';
const REAL_FOCUS_CURRENT = '  mCurrentFocus=Window{97f20a7 u0 com.simplemobiletools.flashlight/com.simplemobiletools.flashlight.activities.MainActivity}';
const REAL_FOCUS_FOCUSEDAPP = '  mFocusedApp=ActivityRecord{7394cdb u0 com.simplemobiletools.flashlight/.activities.MainActivity t14}';
const REAL_WINDOW_DUMP = [REAL_FOCUS_CURRENT, REAL_FOCUS_FOCUSEDAPP].join('\n');

// —— 真机形态的蓝牙崩溃弹窗（同一套字段与包裹体格式） ——
const REAL_BT_ACTIVITIES = '  topResumedActivity=ActivityRecord{9e1f0b2 u0 com.android.bluetooth/.btservice.AdapterService t98}\n'
  + '  ResumedActivity: ActivityRecord{9e1f0b2 u0 com.android.bluetooth/.btservice.AdapterService t98}';

// —— 真机形态的桌面 ——
const REAL_LAUNCHER_ACTIVITIES = '  topResumedActivity=ActivityRecord{1a2b3c4 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t7}';

// —— 旧系统（Android 9/10）兼容夹具：只有 mResumedActivity ——
const LEGACY_M_RESUMED = '    mResumedActivity: ActivityRecord{2b4c1a3 u0 com.simplemobiletools.flashlight/.MainActivity t123}';

// —— 两位数 user id（u10，工作资料 / 多用户） ——
const REAL_U10 = '  ResumedActivity: ActivityRecord{7394cdb u10 com.simplemobiletools.flashlight/.activities.MainActivity t14}';

/*
 * —— 真机原文：ANR 弹窗的焦点窗口（偏差 11）——
 * 逐字复制，含前导两个空格与 `Window{<token> u0 ` 前缀。
 * 关键点：这类窗口里**没有 `<pkg>/<activity>`**，只有一个弹窗标题 + 被弹进程名。
 */
const REAL_FOCUS_ANR_SYSTEMUI = '  mCurrentFocus=Window{7061971 u0 Application Not Responding: com.android.systemui}';
const REAL_FOCUS_ANR_SYSTEM = '  mCurrentFocus=Window{626b07c u0 Application Not Responding: system}';
/** 同一次 dumpsys window 里 mFocusedApp 仍指向底下的 Activity（真机上就是这样的）。 */
const REAL_WINDOW_DUMP_ANR = [
  REAL_FOCUS_ANR_SYSTEMUI,
  '  mFocusedApp=ActivityRecord{1a2b3c4 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t7}',
].join('\n');

test('真机原文：只有 topResumedActivity 两行 → 解析出应用包名（Android 14 主路径）', () => {
  const r = parseResumedActivity(REAL_ACTIVITIES_DUMP);
  assert(!!r, '不能返回 null —— 这是 6c3f9dfe 的线上回归');
  assertEqual(r.package, 'com.simplemobiletools.flashlight');
  assertEqual(r.activity, '.activities.MainActivity');
  assertEqual(r.source, 'topResumedActivity', 'topResumedActivity 优先级最高');
});

test('真机原文：只有 topResumedActivity 一行 → 解析出应用包名', () => {
  const r = parseResumedActivity(REAL_ACTIVITIES_TOP_ONLY);
  assertEqual(r.package, 'com.simplemobiletools.flashlight');
  assertEqual(r.source, 'topResumedActivity');
});

test('真机原文：只有 ResumedActivity: 一行 → 解析出应用包名', () => {
  const r = parseResumedActivity(REAL_ACTIVITIES_RESUMED_ONLY);
  assertEqual(r.package, 'com.simplemobiletools.flashlight');
  assertEqual(r.source, 'ResumedActivity');
  assertEqual(r.activity, '.activities.MainActivity');
});

test('旧系统兼容：只有 mResumedActivity: 一行仍能解析（Android 9/10）', () => {
  const r = parseResumedActivity(LEGACY_M_RESUMED);
  assertEqual(r.package, 'com.simplemobiletools.flashlight');
  assertEqual(r.activity, '.MainActivity');
  assertEqual(r.source, 'mResumedActivity');
});

test('优先级：topResumedActivity 与 ResumedActivity 同时存在时取前者', () => {
  const dump = ['  ResumedActivity: ActivityRecord{aaa u0 com.foo.first/.A t1}',
    '  topResumedActivity=ActivityRecord{bbb u0 com.bar.second/.B t2}'].join('\n');
  const r = parseResumedActivity(dump);
  assertEqual(r.package, 'com.bar.second');
});

test('多用户：u10 这种两位数 user id 也要能解析', () => {
  const r = parseResumedActivity(REAL_U10);
  assertEqual(r.package, 'com.simplemobiletools.flashlight');
});

test('真机原文：mCurrentFocus=Window{...} → 解析出应用包名', () => {
  const r = parseCurrentFocus(REAL_FOCUS_CURRENT);
  assert(!!r, '应解析成功');
  assertEqual(r.package, 'com.simplemobiletools.flashlight');
  assertEqual(r.activity, 'com.simplemobiletools.flashlight.activities.MainActivity');
  assertEqual(r.source, 'mCurrentFocus');
});

test('真机原文：mFocusedApp=ActivityRecord{...} → 解析出应用包名', () => {
  const r = parseCurrentFocus(REAL_FOCUS_FOCUSEDAPP);
  assertEqual(r.package, 'com.simplemobiletools.flashlight');
  assertEqual(r.activity, '.activities.MainActivity');
  assertEqual(r.source, 'mFocusedApp');
});

test('真机原文：window dump 两行同时存在 → 取 mCurrentFocus（优先级更高）', () => {
  const r = parseCurrentFocus(REAL_WINDOW_DUMP);
  assertEqual(r.package, 'com.simplemobiletools.flashlight');
  assertEqual(r.source, 'mCurrentFocus');
});

test('空输入 / 只有无关行 → null，且不抛错', () => {
  assertEqual(parseResumedActivity(''), null);
  assertEqual(parseResumedActivity(null), null);
  assertEqual(parseResumedActivity('  mResumedActivity: null'), null);
  assertEqual(parseResumedActivity('No activities'), null);
  assertEqual(parseResumedActivity('    topResumedActivity=null'), null);
  assertEqual(parseCurrentFocus(''), null);
  assertEqual(parseCurrentFocus('  mCurrentFocus=null'), null);
  assertEqual(parseCurrentFocus('garbage'), null);
});

test('isSystemSurface 认得崩溃弹窗宿主与桌面', () => {
  assertEqual(isSystemSurface('com.android.bluetooth'), true, '蓝牙崩溃弹窗');
  assertEqual(isSystemSurface('com.android.nfc'), true);
  assertEqual(isSystemSurface('com.android.systemui'), true);
  assertEqual(isSystemSurface('com.android.settings'), true, '「App info / Close app」弹窗宿主');
  assertEqual(isSystemSurface('com.android.permissioncontroller'), true);
  assertEqual(isSystemSurface('android'), true);
  assertEqual(isSystemSurface('com.google.android.apps.nexuslauncher'), true, '桌面');
  assertEqual(isSystemSurface('com.miui.home.launcher'), true, '其他 launcher 也按系统界面处理');
});

test('isSystemSurface 对普通第三方应用为 false', () => {
  assertEqual(isSystemSurface('com.simplemobiletools.flashlight'), false);
  assertEqual(isSystemSurface('org.example.notlauncher'), false);
  assertEqual(isSystemSurface(''), false);
  assertEqual(isSystemSurface(null), false);
});

test('pickForeground 优先已恢复 Activity（真机原文）', () => {
  const fg = pickForeground({ resumed: REAL_ACTIVITIES_DUMP, focus: REAL_WINDOW_DUMP });
  assertEqual(fg.package, 'com.simplemobiletools.flashlight');
  assertEqual(fg.source, 'topResumedActivity');
  assertEqual(fg.systemSurface, false);
});

test('pickForeground 退化到窗口焦点（resumed 为空，真机原文）', () => {
  const fg = pickForeground({ resumed: '', focus: REAL_WINDOW_DUMP });
  assertEqual(fg.package, 'com.simplemobiletools.flashlight');
  assertEqual(fg.source, 'mCurrentFocus');
});

test('pickForeground 两者都无 → null（宁可报空也不谎报应用在前台）', () => {
  assertEqual(pickForeground({}), null);
  assertEqual(pickForeground(null), null);
});

test('蓝牙崩溃弹窗抢焦点时：如实报前台是 com.android.bluetooth 且标记 systemSurface', () => {
  const fg = pickForeground({ resumed: REAL_BT_ACTIVITIES });
  assertEqual(fg.package, 'com.android.bluetooth');
  assertEqual(fg.systemSurface, true, '必须能识别出这是系统弹窗，调用方据此判定「应用不在前台」');
});

test('桌面占前台时如实返回 launcher 且标记 systemSurface', () => {
  const fg = pickForeground({ resumed: REAL_LAUNCHER_ACTIVITIES });
  assertEqual(fg.package, 'com.google.android.apps.nexuslauncher');
  assertEqual(fg.systemSurface, true);
});

/* ------------------------------------------------------------------ */
console.log('\n[foreground.js / ANR 与崩溃弹窗]');

test('真机原文：`Application Not Responding: com.android.systemui` → 识别为弹窗', () => {
  const d = parseSystemDialog(REAL_FOCUS_ANR_SYSTEMUI);
  assert(!!d, '必须能解析 —— 旧版正则要求 pkg/act，这行一条都匹配不上（偏差 11）');
  assertEqual(d.package, 'com.android.systemui');
  assertEqual(d.activity, '', '弹窗窗口没有 activity');
  assertEqual(d.source, 'dialog');
  assertEqual(d.systemSurface, true);
});

test('真机原文：`Application Not Responding: system` → 包名归一成 android', () => {
  const d = parseSystemDialog(REAL_FOCUS_ANR_SYSTEM);
  assert(!!d, '`system` 不是合法包名但必须被识别');
  assertEqual(d.package, 'android', 'system / system_server 归一成 android');
  assertEqual(d.source, 'dialog');
  assertEqual(d.systemSurface, true, 'android 恒为系统界面，调用方据此判定「应用不在前台」');
});

test('`Application Error:`（应用崩溃弹窗）同样能识别', () => {
  const d = parseSystemDialog('  mCurrentFocus=Window{abc1234 u0 Application Error: com.example.boom}');
  assertEqual(d.package, 'com.example.boom', '崩的包名照实返回');
  assertEqual(d.source, 'dialog');
  // 弹窗本身是系统窗口，systemSurface 恒为 true —— 即使用户看到的
  // 「Application Error: com.example.boom」属于第三方 app，它也不是可交互的应用界面。
  assertEqual(d.systemSurface, true);
});

test('普通焦点窗口不会被误判成弹窗', () => {
  assertEqual(parseSystemDialog(REAL_FOCUS_CURRENT), null);
  assertEqual(parseSystemDialog(REAL_FOCUS_FOCUSEDAPP), null);
  assertEqual(parseSystemDialog(''), null);
  assertEqual(parseSystemDialog(null), null);
});

test('弹窗优先级高于 resumed：resumed 仍是 launcher 时也如实报弹窗', () => {
  // 真机行为：弹窗弹出时 topResumedActivity 依旧是底下那个 Activity
  const fg = pickForeground({ resumed: REAL_LAUNCHER_ACTIVITIES, focus: REAL_WINDOW_DUMP_ANR });
  assertEqual(fg.package, 'com.android.systemui', '绝不能因为 resumed 能解析就报 launcher');
  assertEqual(fg.source, 'dialog');
  assertEqual(fg.systemSurface, true);
});

/* ------------------------------------------------------------------ */
console.log('\n[foreground.js / waitForPackage 轮询]');

/**
 * 构造一个按脚本返回 dumpsys 的假 adb（纯内存，不碰真机）。
 *
 * `current()` 的采样顺序是「先窗口焦点、后 Activity 栈」（偏差 11），所以这里
 * 必须按命令分别返回：focus 默认空串（模拟「窗口焦点里没有 pkg/act」，这是没有
 * 弹窗时的常态）；resumed 按序列每次取一条。`samples` 记录真正采了几轮。
 */
function fakeAdb(resumedSequence, focusSequence = []) {
  let i = 0;
  const adb = {
    samples: 0,
    async shell(cmd) {
      if (cmd === CMD_FOCUS) {
        if (!focusSequence.length) return '';
        return focusSequence[Math.min(i, focusSequence.length - 1)];
      }
      const text = resumedSequence[Math.min(i, resumedSequence.length - 1)];
      i += 1;
      adb.samples += 1;
      return text;
    },
  };
  return adb;
}

test('启动后首次采样是桌面、第二次才是应用 → 轮询能等到应用', async () => {
  const adb = fakeAdb([REAL_LAUNCHER_ACTIVITIES, REAL_ACTIVITIES_DUMP]);
  const fg = await waitForPackage(adb, 'com.simplemobiletools.flashlight', { timeoutMs: 2000, intervalMs: 10 });
  assertEqual(fg.package, 'com.simplemobiletools.flashlight');
  assertEqual(fg.systemSurface, false);
  assertEqual(adb.samples, 2, '应在第 2 次采样时命中并停止轮询');
});

test('弹窗一直占据前台 → 超时后返回真实结果（弹窗包名），不返回期望包名', async () => {
  const adb = fakeAdb([REAL_BT_ACTIVITIES]);
  const fg = await waitForPackage(adb, 'com.simplemobiletools.flashlight', { timeoutMs: 50, intervalMs: 10 });
  assert(!!fg, '应有采样结果');
  assertEqual(fg.package, 'com.android.bluetooth', '绝不能把期望包名当结果返回');
  assertEqual(fg.systemSurface, true);
  assert(adb.samples >= 2, '超时前应轮询多次');
});

test('一次都采不到（adb 报错）→ 返回 null，不抛错', async () => {
  const adb = {
    async shell() { throw new Error('device offline'); },
  };
  const fg = await waitForPackage(adb, 'com.foo', { timeoutMs: 20, intervalMs: 5 });
  assertEqual(fg, null);
});

test('waitForPackage 默认窗口 ≥ 10s（偏差 11 / P1：4s 会把刚启动的应用报成桌面）', async () => {
  // 不真等 12s：用一个永远返回 launcher 的 sample，检查它在 400ms 内**没有**放弃
  const adb = fakeAdb([REAL_LAUNCHER_ACTIVITIES]);
  const t0 = Date.now();
  const fg = await waitForPackage(adb, 'com.simplemobiletools.flashlight', { intervalMs: 200, timeoutMs: 400 });
  assertEqual(fg.package, 'com.google.android.apps.nexuslauncher');
  const elapsed = Date.now() - t0;
  assert(elapsed >= 380, `显式传 400ms 时应跑满窗口（实际 ${elapsed}ms）`);
  assert(adb.samples >= 2, '窗口内应多次采样');
});

/* ------------------------------------------------------------------ */
console.log('\n[foreground.js / current() 采样命令]');

test('采样命令必须 grep topResumedActivity（只 grep mResumedActivity 就是 6c3f9dfe 的回归）', () => {
  assert(CMD_RESUMED.includes('topResumedActivity'), `命令里必须含 topResumedActivity：${CMD_RESUMED}`);
  assert(CMD_RESUMED.includes('ResumedActivity'), '命令里还要覆盖 ResumedActivity / mResumedActivity');
  assert(/dumpsys activity activities/.test(CMD_RESUMED), '取 Activity 栈');
  assert(/-i/.test(CMD_RESUMED), '必须大小写不敏感（首字母 m 的有无只差一个字符）');
});

test('窗口采样命令覆盖 mCurrentFocus 与 mFocusedApp', () => {
  assert(CMD_FOCUS.includes('mCurrentFocus'));
  assert(CMD_FOCUS.includes('mFocusedApp'));
  assert(/dumpsys window/.test(CMD_FOCUS));
});

test('current() 用真机原文端到端采样 → 返回应用包名（不返回 null）', async () => {
  const adb = {
    cmds: [],
    async shell(cmd) {
      this.cmds.push(cmd);
      if (cmd === CMD_RESUMED) return REAL_ACTIVITIES_DUMP;
      if (cmd === CMD_FOCUS) return REAL_WINDOW_DUMP;
      return '';
    },
  };
  const fg = await current(adb);
  assert(!!fg, 'current() 不能返回 null —— 真机上应用确实在前台');
  assertEqual(fg.package, 'com.simplemobiletools.flashlight');
  assertEqual(fg.systemSurface, false);
});

test('current() 在 Activity 栈采不到时退化到窗口焦点（真机原文）', async () => {
  const adb = {
    async shell(cmd) {
      if (cmd === CMD_RESUMED) return ''; // 例如 grep 无匹配
      if (cmd === CMD_FOCUS) return REAL_WINDOW_DUMP;
      return '';
    },
  };
  const fg = await current(adb);
  assertEqual(fg.package, 'com.simplemobiletools.flashlight');
  assertEqual(fg.source, 'mCurrentFocus');
});

test('current() 必须先采窗口焦点（弹窗只有在 focus 里才看得见）', async () => {
  const adb = {
    cmds: [],
    async shell(cmd) {
      this.cmds.push(cmd);
      if (cmd === CMD_FOCUS) return REAL_WINDOW_DUMP_ANR;
      if (cmd === CMD_RESUMED) return REAL_LAUNCHER_ACTIVITIES;
      return '';
    },
  };
  const fg = await current(adb);
  assertEqual(adb.cmds[0], CMD_FOCUS, '第一次采样必须是 window 焦点（偏差 11）');
  assertEqual(fg.package, 'com.android.systemui', 'ANR 弹窗时必须报弹窗，不能报底下的 launcher');
  assertEqual(fg.source, 'dialog');
  assertEqual(fg.systemSurface, true);
});

test('current() 命中弹窗后不再多打一次 dumpsys（命中即返回）', async () => {
  const adb = {
    cmds: [],
    async shell(cmd) {
      this.cmds.push(cmd);
      if (cmd === CMD_FOCUS) return REAL_FOCUS_ANR_SYSTEM;
      return REAL_LAUNCHER_ACTIVITIES;
    },
  };
  const fg = await current(adb);
  assertEqual(fg.package, 'android');
  assertEqual(adb.cmds.length, 1, '弹窗命中后应立刻返回，省掉一次 adb round-trip');
});

test('current() 焦点采样失败（adb 抛错）→ 兜住，仍用 Activity 栈返回应用', async () => {
  const adb = {
    async shell(cmd) {
      if (cmd === CMD_FOCUS) throw new Error('dumpsys window 超时');
      return REAL_ACTIVITIES_DUMP;
    },
  };
  const fg = await current(adb);
  assertEqual(fg.package, 'com.simplemobiletools.flashlight', '一条命令失败不能拖垮整个采样');
  assertEqual(fg.systemSurface, false);
});

/* ------------------------------------------------------------------ */
console.log('\n[xserver.js / 硬件 3D X display]');

test('命令行必须带 -interface 127.0.0.1（缺它 websocketPort 绑定失败报 98）', () => {
  const args = buildXserverArgs({ display: ':9' });
  const i = args.indexOf('-interface');
  assert(i >= 0, '缺少 -interface');
  assertEqual(args[i + 1], '127.0.0.1', '-interface 必须是回环');
});

test('命令行带 -hw3d -drinode（否则只是普通 VNC，拿不到 GPU）', () => {
  const args = buildXserverArgs({ display: ':9' });
  assert(args.includes('-hw3d'), '缺少 -hw3d');
  const i = args.indexOf('-drinode');
  assertEqual(args[i + 1], '/dev/dri/renderD128');
});

test('-SecurityTypes None 必须同时只绑回环（避免无鉴权 VNC 暴露到局域网）', () => {
  const args = buildXserverArgs({ display: ':9' });
  const i = args.indexOf('-SecurityTypes');
  assertEqual(args[i + 1], 'None');
  assertEqual(args[args.indexOf('-interface') + 1], '127.0.0.1');
});

test('display 放在首个参数位（X server 的位置参数约定）', () => {
  assertEqual(buildXserverArgs({ display: ':11' })[0], ':11');
  assertEqual(buildXserverArgs({})[0], ':9', '默认 :9');
});

test('parseDisplayNum 解析 :N，拒绝非法值', () => {
  assertEqual(parseDisplayNum(':9'), 9);
  assertEqual(parseDisplayNum(' :12 '), 12);
  assertEqual(parseDisplayNum(':9.0'), 9);
  assert(Number.isNaN(parseDisplayNum('9')), '缺冒号应视为非法');
  assert(Number.isNaN(parseDisplayNum('')), '空串应视为非法');
});

test('socketPathFor 指向 /tmp/.X11-unix/XN', () => {
  assertEqual(socketPathFor(':9'), '/tmp/.X11-unix/X9');
  assertEqual(socketPathFor('bad'), null);
});

test('就绪判定认 vncext 两行（真机原文）', () => {
  assert(parseReadyLog('vncext: Listening for VNC connections on all interface(s), port 5996'), 'VNC 行');
  assert(parseReadyLog('vncext: Listening for websocket connections on 127.0.0.1 interface(s), port 6996'), 'ws 行');
  assert(!parseReadyLog('vncExtInit: failed to bind socket'), '失败行不能判就绪');
});

test('端口冲突判定认「Address already in use」→ 换槽位重试', () => {
  // 真机原文（简写版会截掉 "websocketPort"，判据必须落在 Address already in use 上）
  const real = 'vncExtInit: failed to bind socket, is someone else on our -websocketPort?: Address already in use (98)';
  assert(parseBindConflict(real), '必须识别端口冲突');
  assert(!parseBindConflict('Could not init font path element'), '字体路径问题不算冲突');
});

test('传 -xkbdir（缺它时 X server 会 XKB fatal 退出，真机踩过）', () => {
  const args = buildXserverArgs({ display: ':9', xkbDir: '/usr/share/X11/xkb' });
  const i = args.indexOf('-xkbdir');
  assert(i >= 0, '缺少 -xkbdir');
  assertEqual(args[i + 1], '/usr/share/X11/xkb');
  assert(!buildXserverArgs({ display: ':9' }).includes('-xkbdir'), '无 xkb 目录时不该硬塞');
});

test('pickXkbDir 优先二进制自带树，其次宿主 /usr/share/X11/xkb', () => {
  const bin = '/opt/app/usr/bin/Xkasmvnc';
  const own = '/opt/app/usr/share/X11/xkb';
  assertEqual(pickXkbDir(bin, (p) => p === own), own, '自带树优先');
  assertEqual(pickXkbDir(bin, (p) => p === '/usr/share/X11/xkb'), '/usr/share/X11/xkb', '回退宿主');
  assertEqual(pickXkbDir(bin, () => false), '', '都没有则留空');
});

test('pickXkbBinCwd 能找到相对 .xkbbin/xkbcomp 的打包根（否则 X 起来 1 秒就死）', () => {
  const bin = '/opt/app/vendor/runtime/usr/bin/Xkasmvnc';
  const root = '/opt/app/vendor/runtime';
  assertEqual(pickXkbBinCwd(bin, (p) => p === `${root}/.xkbbin/xkbcomp`), root);
  assertEqual(pickXkbBinCwd(bin, () => false), '', '没有 .xkbbin 就用默认 cwd');
});

test('fatal 判定认「Fatal server error」（xkb/gpu 初始化失败要立刻失败，别等满 10s）', () => {
  assert(parseFatalError('(EE) Fatal server error:\n(EE) Failed to activate virtual core keyboard: 2'));
  assert(!parseFatalError('vncext: Listening for websocket connections'), '正常就绪行不是 fatal');
});

test('findXkbcompBin 优先二进制同前缀的 bin，其次 /usr/bin', () => {
  const bin = '/opt/app/usr/bin/Xkasmvnc';
  assertEqual(findXkbcompBin(bin, (p) => p === '/opt/app/usr/bin/xkbcomp'), '/opt/app/usr/bin/xkbcomp');
  assertEqual(findXkbcompBin(bin, (p) => p === '/usr/bin/xkbcomp'), '/usr/bin/xkbcomp');
});

test('只有裸二进制时造 .xkbbin/xkbcomp 软链 shim（否则 -xkbdir 也救不了，X 直接 fatal）', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xkbshim-'));
  const bin = '/nonexistent/usr/bin/Xkasmvnc';
  const root = ensureXkbRoot(bin, tmp, (p) => p === '/usr/bin/xkbcomp');
  // 实现内部用 path.posix 拼（这些是 Linux 路径），所以期望值也要 posix：
  // Windows 上 tmp 是 `C:\...\xkbshim-x`，posix.join 得到 `C:\...\xkbshim-x/xkbroot`。
  const expectedRoot = path.posix.join(tmp, 'xkbroot');
  assertEqual(root, expectedRoot, '返回可直接当 cwd 的目录');
  // 目标在 macOS 上不存在，属悬空软链，只能 lstat（existsSync 对悬空链接返回 false）
  assert(fs.lstatSync(path.join(root, '.xkbbin', 'xkbcomp')).isSymbolicLink(), '软链必须落在 <cwd>/.xkbbin/xkbcomp');
  // Windows 创建软链时会把目标规范化为「盘符 + 反斜杠」形式（/usr/bin/xkbcomp →
  // D:\usr\bin\xkbcomp），所以比前缀、比反斜杠都会挂。归一化到 POSIX 再比：
  // 这里验的是「链到哪一个文件」，不是「文件系统怎么存这个字符串」。
  const linked = fs.readlinkSync(path.join(root, '.xkbbin', 'xkbcomp'))
    .replace(/^[A-Za-z]:/, '')
    .replace(/\\/g, '/');
  assertEqual(linked, '/usr/bin/xkbcomp', '软链指向宿主 xkbcomp');
  // 幂等：再调一次不该抛错
  assertEqual(ensureXkbRoot(bin, tmp, (p) => p === '/usr/bin/xkbcomp'), root);
  // 连 xkbcomp 都没有时返回空串（保持原 cwd，让 fatal 暴露而不是假装成功）
  assertEqual(ensureXkbRoot(bin, tmp, () => false), '');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('cleanStaleDisplay 把死掉的 lock 当垃圾清掉（否则一次异常退出就永久 Cannot establish any listening sockets）', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const n = 9700 + (process.pid % 100); // 避开真机真实槽位
  // 生产里 lock 固定在 /tmp，但 Windows runner 没有 D:\tmp，用可注入的 tmpDir 换到
  // os.tmpdir() 才能真实落盘；被测逻辑（读 pid → 判活 → 删 lock/socket）完全一致。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlock-'));
  const lock = path.join(tmpDir, `.X${n}-lock`);
  // 用一个必然不存在的 pid 模拟「X 被 SIGKILL 后留下的 lock」
  fs.writeFileSync(lock, '999999\n');
  assertEqual(cleanStaleDisplay(`:${n}`, { tmpDir }), 'cleaned', 'pid 不存在 → 清掉');
  assert(!fs.existsSync(lock), 'lock 已删除');
  // 没 lock 没 socket → absent（不谎报 cleaned）
  assertEqual(cleanStaleDisplay(`:${n}`, { tmpDir }), 'absent');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('cleanStaleDisplay 不因 pid 复用永久占住槽位（pid 活着但不是 X server → 仍清理）', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  // 判定依赖 /proc/<pid>/cmdline，仅 Linux 有意义（真机 fnOS 就是 Linux）。
  if (!fs.existsSync('/proc/self/cmdline')) return;
  const n = 9800 + (process.pid % 100);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlock-'));
  const lock = path.join(tmpDir, `.X${n}-lock`);
  fs.writeFileSync(lock, `${process.pid}\n`); // 我们自己活着，但命令行不是 X
  assertEqual(cleanStaleDisplay(`:${n}`, { tmpDir }), 'cleaned');
  assert(!fs.existsSync(lock));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
console.log('\n[gpu.js / -gpu 模式裁决]');

test('gpu=off → off（不看任何前提）', () => {
  const r = resolveGpuMode({ want: 'off', hasDisplay: true, renderNodeUsable: true });
  assertEqual(r.mode, 'off');
  assertEqual(r.reason, 'configured-off');
});

test('gpu=auto + 有 X + 有 render node → host（拿到 ~3.3s 收益）', () => {
  const r = resolveGpuMode({ want: 'auto', hasDisplay: true, renderNodeUsable: true });
  assertEqual(r.mode, 'host');
  assertEqual(r.reason, 'auto-host');
});

test('gpu=auto + 无 X → off（不是所有 fnOS 都有 Xkasmvnc）', () => {
  const r = resolveGpuMode({ want: 'auto', hasDisplay: false, renderNodeUsable: true });
  assertEqual(r.mode, 'off');
  assertEqual(r.reason, 'no-xserver');
});

test('gpu=auto + 无 render node → off', () => {
  const r = resolveGpuMode({ want: 'auto', hasDisplay: true, renderNodeUsable: false });
  assertEqual(r.mode, 'off');
  assertEqual(r.reason, 'no-render-node');
});

test('显式 host 但无 X display → 降级 off（旧实现漏这条，用户一改设置就 2s 静默崩溃）', () => {
  const r = resolveGpuMode({ want: 'host', hasDisplay: false, renderNodeUsable: true });
  assertEqual(r.mode, 'off');
  assertEqual(r.reason, 'no-xserver');
  assert(/X server/.test(r.message), '要给得出原因');
});

test('显式 swiftshader_indirect 但无 X → 也降级 off（纯软件渲染同样需要 windowing system）', () => {
  const r = resolveGpuMode({ want: 'swiftshader_indirect', hasDisplay: false, renderNodeUsable: true });
  assertEqual(r.mode, 'off');
});

test('显式 host + X 齐全 → 尊重配置', () => {
  const r = resolveGpuMode({ want: 'host', hasDisplay: true, renderNodeUsable: true });
  assertEqual(r.mode, 'host');
  assertEqual(r.reason, 'configured');
});

test('gpuAutoEnable=false 时 auto 不自动开（用户显式关掉自动加速）', () => {
  const r = resolveGpuMode({ want: 'auto', hasDisplay: true, renderNodeUsable: true, autoEnabled: false });
  assertEqual(r.mode, 'off');
});

test('未知模式一律回落 off（不让拼写错误变成 2 秒崩溃）', () => {
  assertEqual(resolveGpuMode({ want: 'nonsense', hasDisplay: true, renderNodeUsable: true }).mode, 'off');
});

/* ------------------------------------------------------------------ */
/* wizard 契约（0.2.0 真机安装失败的回归护栏）                          */
/*   wizard 顶层必须是数组（[]trimpkg.WizardPage），给对象会报：        */
/*   "json: cannot unmarshal object into Go value of type              */
/*    []trimpkg.WizardPage"，且报错文案伪装成 "is not exist: 100610"。 */
/* ------------------------------------------------------------------ */

test('仓库内 fnos/wizard/* 全部通过契约校验（顶层数组 + 已知 item 类型）', () => {
  const path = require('path');
  const { validateDir } = require('../build/validate-wizard');
  const res = validateDir(path.join(__dirname, '..', 'fnos', 'wizard'));
  assertEqual(res.errors.length, 0, 'wizard 校验失败：\n      ' + res.errors.join('\n      '));
  assertEqual(res.files, 2, 'install 与 uninstall 两个文件都要在');
  assert(res.pages >= 2, '每个文件至少一页');
});

test('校验器能抓住 0.2.0 的对象格式（顶层对象 → 必须报错）', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { validateFile } = require('../build/validate-wizard');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-'));
  try {
    const bad = path.join(tmp, 'install');
    fs.writeFileSync(bad, '{"title":"x","description":"y","fields":[{"key":"purge","type":"boolean"}]}');
    const r = validateFile(bad);
    assert(r.errors.length > 0, '顶层对象必须被拒绝（否则真机上一定是 wizard invalid）');
    assert(/顶层必须是数组/.test(r.errors[0]), '错误信息要指出顶层类型问题');

    // 非法 JSON 也要报错，而不是抛异常
    const broken = path.join(tmp, 'uninstall');
    fs.writeFileSync(broken, '[{"stepTitle":');
    assert(validateFile(broken).errors.length > 0, '非法 JSON 必须被拒绝');

    // 缺 stepTitle / 未知 item type 也要被拒绝
    const noTitle = path.join(tmp, 'install2');
    fs.writeFileSync(noTitle, JSON.stringify([{ items: [{ type: 'tips', helpText: 'x' }] }]));
    assert(validateFile(noTitle).errors.length > 0, '缺 stepTitle 必须被拒绝');

    const badType = path.join(tmp, 'uninstall2');
    fs.writeFileSync(badType, JSON.stringify([{ stepTitle: 't', items: [{ type: 'checkbox' }] }]));
    assert(validateFile(badType).errors.length > 0, '未知 item type 必须被拒绝');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('wizard item 的 field 不进脚本：uninstall_callback 只认 TRIM_UNINSTALL_PURGE', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'fnos', 'cmd', 'uninstall_callback'), 'utf8');
  assert(/TRIM_UNINSTALL_PURGE/.test(src), '脚本侧应只读环境变量');
  const wiz = fs.readFileSync(path.join(__dirname, '..', 'fnos', 'wizard', 'uninstall'), 'utf8');
  assert(!/"field"/.test(wiz), 'uninstall 向导不应放 field 开关（值传不到脚本，等于假开关）');
});

/* ------------------------------------------------------------------ */
/* fpk 包结构（0.2.1 真机安装失败的回归护栏）                           */
/*   App Center 只认根级 app.tgz，不认 app/ 目录；给目录时报：          */
/*   "failed to decompress app.tgz: … open …/app.tgz:                  */
/*    no such file or directory (code 10107)"                          */
/* ------------------------------------------------------------------ */

test('包结构校验器能抓住 0.2.1 的 app/ 目录形态（缺根级 app.tgz）', () => {
  const { checkListing } = require('../build/validate-package');

  // 0.2.1 的真实形态（真机日志原文）：
  //   dirs="[app cmd config wizard]" files="[ICON.PNG ICON_256.PNG manifest]"
  const bad = checkListing(
    [
      'apkstart-fnos/',
      'apkstart-fnos/app/',
      'apkstart-fnos/app/server/index.js',
      'apkstart-fnos/cmd/',
      'apkstart-fnos/cmd/main',
      'apkstart-fnos/config/',
      'apkstart-fnos/config/privilege',
      'apkstart-fnos/wizard/',
      'apkstart-fnos/wizard/install',
      'apkstart-fnos/ICON.PNG',
      'apkstart-fnos/ICON_256.PNG',
      'apkstart-fnos/manifest',
    ],
    null,
  );
  assert(bad.length > 0, '0.2.1 形态必须被判失败（否则又会发一个装不上的包）');
  assert(
    bad.some((e) => /缺少根级 app\.tgz/.test(e)),
    '必须指出缺少根级 app.tgz：' + bad.join(' | '),
  );
  assert(bad.some((e) => /10107/.test(e)), '错误信息要带上真机错误码 10107，方便对日志');
  assert(bad.some((e) => /不应出现 app\/ 目录/.test(e)), '必须指出根目录不该有 app/');
});

test('包结构校验器放行正确形态（根级 app.tgz + 内层 server/core/ui）', () => {
  const { checkListing } = require('../build/validate-package');
  const ok = checkListing(
    [
      'apkstart-fnos/',
      'apkstart-fnos/app.tgz',
      'apkstart-fnos/cmd/',
      'apkstart-fnos/cmd/main',
      'apkstart-fnos/config/',
      'apkstart-fnos/config/privilege',
      'apkstart-fnos/wizard/',
      'apkstart-fnos/wizard/install',
      'apkstart-fnos/ICON.PNG',
      'apkstart-fnos/ICON_256.PNG',
      'apkstart-fnos/manifest',
    ],
    [
      'server',
      'server/index.js',
      'server/config.js',
      'core',
      'core/adb.js',
      'ui',
      'ui/config',
      'ui/index.html',
    ],
  );
  assertEqual(ok.length, 0, '正确形态不该报错：' + ok.join(' | '));
});

test('包结构校验器能抓住 app.tgz 套壳（顶层多一层 appname 目录）', () => {
  const { checkListing } = require('../build/validate-package');
  const rootList = [
    'apkstart-fnos/app.tgz',
    'apkstart-fnos/cmd/main',
    'apkstart-fnos/config/privilege',
    'apkstart-fnos/wizard/install',
    'apkstart-fnos/ICON.PNG',
    'apkstart-fnos/ICON_256.PNG',
    'apkstart-fnos/manifest',
  ];
  const wrapped = checkListing(rootList, ['apkstart-fnos', 'apkstart-fnos/server/index.js']);
  assert(wrapped.some((e) => /多裹了一层/.test(e)), '套壳必须被指出：' + wrapped.join(' | '));

  const empty = checkListing(rootList, []);
  assert(empty.some((e) => /空包/.test(e)), '空 app.tgz 必须被指出');
});

test('pack.sh 走 app.tgz 而不是 app/ 目录，且构建后就地校验包结构', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'pack.sh'), 'utf8');
  assert(/app\.tgz/.test(src), 'pack.sh 必须生成根级 app.tgz');
  assert(!/PKGROOT\/app\//.test(src), 'pack.sh 不应再往 fpk 根塞 app/ 目录');
  assert(/validate-package\.js/.test(src), 'pack.sh 必须调用包结构校验（否则坏包照样能发出去）');
});

test('macOS 打包关掉 xattr：只写 --no-mac-metadata 不够（实测仍出 PAX 头）', () => {
  // bsdtar 3.5.3 实测：--no-mac-metadata 之后包里照样有 LIBARCHIVE.xattr 头，
  // 必须 --no-xattrs。0.2.2 只加了前者，真机解包逐文件报「忽略未知的扩展头关键字」。
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'pack.sh'), 'utf8');
  assert(/--no-xattrs/.test(src), 'pack.sh 的 REPRO_FLAGS 必须含 --no-xattrs');
  assert(/LIBARCHIVE\\?\.xattr/.test(src), 'pack.sh 应保留 PAX 头兜底检查');
});

test('cmd 脚本按 $APPDEST 取路径时，只取 adb 之外的代码根语义', () => {
  // 这两处是 0.2.1 同期修掉的路径假设：
  //   ① main 里 adb 在数据根 runtime/ 下，不在代码根
  //   ② install_init 用 $0 反推 cmd 目录，不用 $APPDEST/../cmd
  // 只看非注释行，避免注释里提到旧写法就把测试带偏。
  const fs = require('fs');
  const path = require('path');
  const code = (f) => fs
    .readFileSync(path.join(__dirname, '..', 'fnos', 'cmd', f), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  const main = code('main');
  assert(!/"\$APPDEST\/runtime"/.test(main), 'adb 不该从 $APPDEST/runtime 取（那是代码根）');
  assert(/"\$DATA_ROOT\/runtime\/platform-tools\/adb"/.test(main), 'adb 应从 $DATA_ROOT/runtime 取');

  const init = code('install_init');
  assert(!/\$APPDEST\/\.\.\/cmd/.test(init), 'install_init 不该用 $APPDEST/../cmd（父目录里没有 cmd/）');
  assert(/dirname "\$0"/.test(init), 'install_init 应用 $0 反推 cmd 目录');
});

// --- 端口：默认值必须同源，且不能被 8890 钉死（IMPL 偏差 15）---

test('默认端口五处同源，且不再写死 8890（目标机被 uvicorn 占用）', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  const pack = read('build/pack.sh');
  const m = pack.match(/PORT="\$\{PORT:-(\d+)\}"/);
  assert(m, 'pack.sh 必须有 PORT 默认值');
  const packDefault = m[1];

  assertEqual(packDefault, '18990', 'pack.sh 的默认端口应为 18990');
  assert(
    packDefault !== '8890',
    '默认端口不能是 8890：目标机 8890 被 Docker 里的 uvicorn 长期占用，服务 bind 不上'
  );

  assert(
    new RegExp(`DEFAULT_PORT = ${packDefault};`).test(read('server/config.js')),
    'server/config.js 的 DEFAULT_PORT 必须与 pack.sh 一致'
  );
  assert(
    new RegExp(`DEFAULT_PORT=${packDefault}\\b`).test(read('fnos/cmd/main')),
    'cmd/main 的 DEFAULT_PORT 必须与 pack.sh 一致'
  );
  assert(
    new RegExp(`service_port: '${packDefault}'`).test(read('build/gen-fnpack.js')),
    'gen-fnpack.js 的 service_port 必须与 pack.sh 一致（否则 fnDepot 声明与实际不符）'
  );
  assert(
    new RegExp(`args\\.port \\|\\| '${packDefault}'`).test(read('build/gen-manifest.js')),
    'gen-manifest.js 的 port 兜底值必须与 pack.sh 一致'
  );
  const resource = JSON.parse(read('fnos/config/resource'));
  assertEqual(
    String(resource.port),
    packDefault,
    'fnos/config/resource 的 port 必须与 pack.sh 一致'
  );
});

test('pack.sh 把同一个 $PORT 同时注入 ui/config 与 config/resource', () => {
  // 只注入一处会留下「图标指 A、服务听 B」的分叉。两者同源是这条的唯一目的。
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'pack.sh'), 'utf8');
  assert(/"port":"\$PORT"/.test(src), 'ui/config 的 port 应由 $PORT 注入');
  assert(/PKGROOT\/config\/resource/.test(src), 'pack.sh 必须改写 config/resource');
  assert(/obj\.port = Number\(port\)/.test(src), 'resource 的 port 应被写成数字');

  // 两处注入都必须在 gen-manifest 算 checksum 之前，否则 checksum 与包内容不符
  const manifestIdx = src.indexOf('gen-manifest.js"');
  assert(manifestIdx > 0, 'pack.sh 应调用 gen-manifest');
  assert(src.indexOf('"port":"$PORT"') < manifestIdx, 'ui/config 注入必须在 checksum 之前');
  assert(src.indexOf('PKGROOT/config/resource') < manifestIdx, 'resource 端口注入必须在 checksum 之前');
});

test('cmd/main 的端口来源按 TRIM_SERVICE_PORT → ui/config → 默认值降级', () => {
  // ui/config 是「图标点开的端口」，服务跟着它走，避免人工改过 ui/config 后两边漂移。
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { execFileSync } = require('child_process');

  const mainPath = path.join(__dirname, '..', 'fnos', 'cmd', 'main');
  const txt = fs.readFileSync(mainPath, 'utf8');
  const fn = (name) => {
    const m = txt.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
    assert(m, `cmd/main 里应有 ${name}()`);
    return m[0];
  };

  const run = (script, args) =>
    execFileSync('sh', ['-c', script, 'x', ...(args || [])], { encoding: 'utf8' }).trim();

  // 造一个只有 ui/config 的假 APPDEST
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-port-'));
  fs.mkdirSync(path.join(tmp, 'ui'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'ui', 'config'),
    '{"url":{"x.main":{"type":"url","protocol":"http","port":"17777","url":"/"}}}',
    'utf8'
  );

  const fromUi = run(`${fn('port_from_uiconfig')}\nAPPDEST="$1"; port_from_uiconfig`, [tmp]);
  assertEqual(fromUi, '17777', 'ui/config 里的 port 应被解析出来');

  // 没有 ui/config 时返回非零（走默认值分支）
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-nouiconfig-'));
  const noUi = run(`${fn('port_from_uiconfig')}\nAPPDEST="$1"; port_from_uiconfig || echo NONE`, [empty]);
  assertEqual(noUi, 'NONE', '缺 ui/config 时应走默认值');

  // resolve_port 依赖 port_from_uiconfig，两个都要带上（否则「命令不存在」会被当成走默认值）
  const portFns = `${fn('port_from_uiconfig')}\n${fn('resolve_port')}`;
  const resolved = run(`${portFns}\nDEFAULT_PORT=18990; APPDEST="$1"; PORT=""; resolve_port`, [tmp]);
  assertEqual(resolved, '17777', 'resolve_port 应优先采信 ui/config');

  const envWins = run(
    `${portFns}\nDEFAULT_PORT=18990; APPDEST="$1"; PORT="19999"; resolve_port`,
    [tmp]
  );
  assertEqual(envWins, '19999', 'TRIM_SERVICE_PORT 应压过 ui/config（平台说了算）');
});

test('cmd/main 在拉起 node 之前探测端口占用，并说明占用者与改法', () => {
  // 与其让 node 抛 EADDRINUSE 秒退、安装器只回显日志尾部，不如先探测再报错。
  const fs = require('fs');
  const path = require('path');
  const { execFileSync, spawn } = require('child_process');

  const txt = fs.readFileSync(path.join(__dirname, '..', 'fnos', 'cmd', 'main'), 'utf8');
  const busyFn = txt.match(/^port_busy\(\) \{[\s\S]*?^\}/m);
  assert(busyFn, 'cmd/main 里应有 port_busy()');

  const probe = (p) =>
    execFileSync('sh', ['-c', `${busyFn[0]}\nport_busy "$1" && echo BUSY || echo FREE`, 'x', String(p)], {
      encoding: 'utf8',
    }).trim();

  // 真起一个监听口再探，避免「语法对但字段名写错」这种假绿。
  // 同步等它 LISTEN：用 sleep 子进程阻塞主线程，测试仍是同步风格。
  const port = 32000 + Math.floor(Math.random() * 2000);
  const child = spawn(
    process.execPath,
    ['-e', `const s=require('net').createServer(()=>{});s.listen(${port},'127.0.0.1');setTimeout(()=>process.exit(0),30000);`],
    { stdio: 'ignore' }
  );
  let busy = false;
  try {
    for (let i = 0; i < 40 && !busy; i += 1) {
      busy = probe(port) === 'BUSY';
      if (!busy) execFileSync('sleep', ['0.05']);
    }
    assertEqual(busy, true, `端口 ${port} 已监听，port_busy 应判为占用`);
  } finally {
    child.kill();
  }

  // 顺序：探测必须在 nohup 拉起之前，否则等于没探
  const startAt = txt.indexOf('do_start()');
  const busyIdx = txt.indexOf('port_busy "$PORT"');
  const spawnIdx = txt.indexOf('nohup "$NODE" "$SERVER_JS"');
  assert(busyIdx > startAt, 'do_start 里应有 port_busy 检查');
  assert(spawnIdx > busyIdx, 'port_busy 必须发生在拉起 node 之前');
  assert(/ui\/config/.test(txt.slice(busyIdx, busyIdx + 900)), '报错文案应指出改 ui/config 的 port');
});

/* ------------------------------------------------------------------ */
(async () => {
  for (const { name, fn } of pending) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}\n    ${e.message}`);
    }
  }
  console.log(`\n[fnos-unit] 结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();

// --- 同一 AVD 的遗留模拟器（IMPL 偏差 16）---

test('scanAvdEmulators 只认 qemu-system，且 -avd 必须整词匹配', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-'));
  const mk = (pid, cmd) => {
    const d = path.join(root, String(pid));
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'cmdline'), `${cmd.split(' ').join('\0')}\0`);
  };
  mk(1001, '/x/qemu-system-x86_64-headless -avd apkstart -no-window');
  mk(1002, '/x/qemu-system-x86_64-headless -avd apkstart2 -no-window'); // 名字前缀相似，不能命中
  mk(1003, '/usr/bin/node /app/server/index.js -avd apkstart');         // 不是 qemu，不能命中
  mk(1004, '/x/qemu-system-x86_64 -avd apkstart');                      // 自己，跳过

  const hits = scanAvdEmulators('apkstart', { procRoot: root, selfPid: 1004 });
  assertEqual(hits.map((h) => h.pid).join(','), '1001', '只应命中真正占着该 AVD 的 qemu');
});

test('_releaseAvd 回收同 AVD 的遗留模拟器，并清掉陈旧锁文件', async () => {
  // 现场（10.31.0.4）：上一个实例的 qemu 还活着并持有 AVD，第二个 emulator 直接
  // FATAL「Running multiple emulators with the same AVD」。这里用真进程 + 伪造 /proc
  // 验证「先回收、再清锁」，而不是只断言源码里有几行。
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { spawn } = require('child_process');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-'));
  const procRoot = path.join(tmp, 'proc');
  fs.mkdirSync(procRoot);
  const avdRoot = path.join(tmp, 'avd');
  const avdDir = path.join(avdRoot, 'apkstart.avd');
  fs.mkdirSync(avdDir, { recursive: true });
  fs.writeFileSync(path.join(avdDir, 'hardware-qemu.ini.lock'), '1234');
  fs.writeFileSync(path.join(avdDir, 'multiinstance.lock'), '');

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const pd = path.join(procRoot, String(child.pid));
  fs.mkdirSync(pd);
  fs.writeFileSync(path.join(pd, 'cmdline'), 'qemu-system-x86_64-headless\0-avd\0apkstart\0');
  let dead = false;
  child.on('exit', () => {
    dead = true;
    try { fs.rmSync(pd, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  const mgr = new EmulatorManager({
    paths: { AVD: avdRoot, APPHOME: tmp, APPDATA: tmp },
    provision: {},
    settingsGetter: () => ({ emulator: {} }),
    xserver: {},
  });
  await mgr._releaseAvd('apkstart', { procRoot, termWaitMs: 5000 });

  assert(dead, '遗留模拟器进程应已被结束');
  assert(!fs.existsSync(path.join(avdDir, 'hardware-qemu.ini.lock')), 'hardware-qemu.ini.lock 应被清理');
  assert(!fs.existsSync(path.join(avdDir, 'multiinstance.lock')), 'multiinstance.lock 应被清理');
});

test('AVD 回收发生在 ensureAvd 之前；CONFLICT 不做无意义的 -gpu off 重试；HOME 指向可写目录', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'service', 'emulator.js'), 'utf8');

  const relIdx = src.indexOf('await this._releaseAvd(avdName)');
  const ensureIdx = src.indexOf('this.ensureAvd({ wipe, gpuMode })', relIdx);
  assert(relIdx > 0, '_startOnce 应调用 _releaseAvd');
  assert(ensureIdx > relIdx, '_releaseAvd 必须在 ensureAvd 之前（锁被占着时 ensureAvd 也白搭）');

  assert(/if \(e\.code === 'CONFLICT'\)/.test(src), 'start() 遇到 AVD 冲突应直接抛出，不降级重试');
  assert(/HOME: home/.test(src), '_spawnEnv 应把 HOME 指到可写目录（否则 shader cache 建不出来）');
});

test('adb 的 HOME 必须可写：包用户没有家目录时不能照抄 process.env.HOME', () => {
  // 真机：adb 一启动就 `mkdir /home/apkstart-fnos/.android` → No such file or directory → Aborted。
  // 表现是「模拟器开机成功但 adb devices 一直获取失败」，很容易误判成模拟器问题。
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { pickWritableHome, AdbClient } = require('../core/adb');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adbhome-'));
  const saved = { HOME: process.env.HOME, TRIM_PKGVAR: process.env.TRIM_PKGVAR };
  try {
    // 「建不出 `.android` 的 HOME」要跨平台造：父级放一个普通文件。
    // 早先写死 `/nonexistent-root-…/home`，Windows 会真把它建到当前盘根下（CI 就是
    // runner 管理员权限），`pickWritableHome()` 于是返回它 → 断言红。
    const blocker = path.join(tmp, 'homeblocker');
    fs.writeFileSync(blocker, 'x');
    process.env.HOME = path.join(blocker, 'home');
    process.env.TRIM_PKGVAR = path.join(tmp, 'var');
    assertEqual(pickWritableHome(), path.join(tmp, 'var'), 'HOME 不可用时应回落到 TRIM_PKGVAR');
    assert(fs.existsSync(path.join(tmp, 'var', '.android')), '.android 目录应被创建');

    const env = new AdbClient({ adbPath: 'adb', serial: '' })._adbEnv();
    assertEqual(env.HOME, path.join(tmp, 'var'), '_adbEnv 的 HOME 应指向可写目录');
    assertEqual(env.ANDROID_ADB_SERVER_PORT, '5044', 'adb server 端口应保持 5044');

    // HOME 本身可写时应优先沿用（保住已有 adbkey）
    const okHome = path.join(tmp, 'realhome');
    fs.mkdirSync(okHome, { recursive: true });
    process.env.HOME = okHome;
    assertEqual(pickWritableHome(), okHome, '可写 HOME 应被优先使用');
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.TRIM_PKGVAR === undefined) delete process.env.TRIM_PKGVAR; else process.env.TRIM_PKGVAR = saved.TRIM_PKGVAR;
  }
});

test('emulator 子进程必须显式给 cwd，不能继承服务进程的 cwd', () => {
  // 真机（10.31.0.4）：服务从 /root（0700）被 su 拉起 → cwd 继承 /root → 包用户读不了
  // → QEMU 2s 内静默退出（只有 `QEMU main loop exits abnormally with code 1`，无错误行）
  // → host 必降级 off。同一台机 cwd=/ 时 host 正常（vulkan_mode_selected:host）。
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-'));
  const temp = path.join(tmp, 'tmp');
  const mgr = new EmulatorManager({
    paths: { APPTEMP: temp, APPDATA: tmp },
    provision: {},
    settingsGetter: () => ({ emulator: {} }),
    xserver: {},
  });
  assertEqual(mgr._spawnCwd(), temp, '_spawnCwd 应返回 APPTEMP');
  assert(fs.existsSync(temp), 'APPTEMP 应被创建（不存在时 spawn 会直接失败）');

  // 建不出来的路径要退回 undefined（= 继承 cwd），不能抛错阻断启动。
  // 这里用「父级是一个普通文件」来造跨平台都不可能建成的路径：早先写死
  // `/proc/nonexistent-apkstart/tmp`，在 Windows 上会被当成 `C:\proc\…` 真建出来，
  // CI 的 Windows job 立刻红（而 macOS/Linux 上恰好 EACCES，本地看不出来）。
  const blocker = path.join(tmp, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const bad = new EmulatorManager({
    paths: { APPTEMP: path.join(blocker, 'tmp'), APPDATA: tmp },
    provision: {},
    settingsGetter: () => ({ emulator: {} }),
    xserver: {},
  });
  assertEqual(bad._spawnCwd(), undefined, '不可创建的 cwd 应退回 undefined');

  // 静态兜底：spawn 必须带上 cwd（否则上面的方法形同虚设）
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'service', 'emulator.js'), 'utf8');
  assert(/\{ env, cwd, stdio:/.test(src), 'spawn(emulator) 必须传 cwd');
});

// --- 画面输入（偏差 17：能看见画面但点不动 / 滑不动）-------------------

const ScreenView = require('../ui/screen.js');
const { classifyGesture } = ScreenView;

test('classifyGesture：没位移的点击 → tap', () => {
  const g = classifyGesture({ dx: 0, dy: 0, deviceDx: 0, deviceDy: 0, elapsed: 120 });
  assertEqual(g.kind, 'tap');
});

test('classifyGesture：3px 手抖的点击仍是 tap（真机实测 0 请求的那一例）', () => {
  // 真机现场（10.31.0.4，Edge 自动化）：img 344x612 CSS px 显示 1080x1920，
  // 1 CSS px ≈ 3.14 设备像素。移 (3,2) 个浏览器像素 = (9,6) 设备像素，
  // 旧逻辑按「8 设备像素」判 swipe → 发出 input swipe x y x+3 y 50 → 屏幕无反应。
  const g = classifyGesture({ dx: 3, dy: 2, deviceDx: 9, deviceDy: 6, elapsed: 90 });
  assertEqual(g.kind, 'tap', '手抖必须仍算点击，否则用户体感就是「点了没反应」');
});

test('classifyGesture：真拖拽 → swipe，时长取真实按住时长', () => {
  const g = classifyGesture({ dx: 0, dy: -400, deviceDx: 0, deviceDy: -1256, elapsed: 240 });
  assertEqual(g.kind, 'swipe');
  assertEqual(g.durationMs, 240);
});

test('classifyGesture：甩得再快 swipe 时长也不低于 100ms（太短会被 ROM 当 fling 丢掉）', () => {
  const g = classifyGesture({ dx: 0, dy: 300, deviceDx: 0, deviceDy: 940, elapsed: 12 });
  assertEqual(g.kind, 'swipe');
  assertEqual(g.durationMs, 100);
  assertEqual(classifyGesture({ dx: 0, dy: 300, deviceDx: 0, deviceDy: 940, elapsed: 99999 }).durationMs, 2000,
    '长拖也不能超过 2s');
});

test('classifyGesture：按住不动 900ms → hold（tap 触发不了长按菜单）', () => {
  const g = classifyGesture({ dx: 1, dy: 1, deviceDx: 3, deviceDy: 3, elapsed: 900 });
  assertEqual(g.kind, 'hold');
});

test('classifyGesture：画面缩得很小导致设备位移不足 6px 时仍按 tap（swipe 会变成空操作）', () => {
  const g = classifyGesture({ dx: 40, dy: 0, deviceDx: 3, deviceDy: 0, elapsed: 200 });
  assertEqual(g.kind, 'tap');
});

test('classifyGesture：缺字段/NaN 输入不抛错，退化成 tap', () => {
  assertEqual(classifyGesture({}).kind, 'tap');
  assertEqual(classifyGesture(undefined).kind, 'tap');
  assertEqual(classifyGesture({ dx: NaN, dy: NaN, elapsed: NaN }).kind, 'tap');
});

test('画面 <img> 必须显式关掉原生拖拽（HTML5 drag 会发 pointercancel，swipe 一条也发不出去）', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'screen.js'), 'utf8');
  assert(/el\.draggable = false/.test(src), '必须设 img.draggable = false');
  assert(/addEventListener\('dragstart'/.test(src), '还应有 dragstart 兜底（个别浏览器只认这个）');
  const idx = src.indexOf("addEventListener('pointerdown'");
  assert(idx > 0, '应有 pointerdown 处理');
  const seg = src.slice(idx, idx + 700);
  assert(/ev\.preventDefault\(\)/.test(seg), 'pointerdown 里必须 preventDefault，否则默认拖拽照样启动');

  const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'style.css'), 'utf8');
  assert(/-webkit-user-drag: none/.test(css), 'CSS 侧也要 -webkit-user-drag: none');
});

test('手势判定用 CSS 像素而不是设备像素（容差要跟屏幕缩放无关）', () => {
  assertEqual(ScreenView.GESTURE.TAP_SLOP_CSS, 10);
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'screen.js'), 'utf8');
  // 记录起点时必须同时记 clientX/clientY，否则只能用设备像素判位移（就是旧 bug）
  assert(/cx: ev\.clientX/.test(src) && /cy: ev\.clientY/.test(src), '起点要记浏览器坐标');
  assert(!/dx < 8 && dy < 8/.test(src), '旧的「8 设备像素」判定必须移除');
});

function fakeScreenCtx() {
  const cmds = [];
  const adb = {
    input: async (c) => { cmds.push(c); },
    shell: async (c) => { cmds.push(`shell:${c}`); },
  };
  return { cmds, ctx: { emulator: { state: 'running', adb: () => adb } } };
}

function fakeRes() {
  // 形状对齐 server/http 的 helper：sendJson(res, code, body)
  return { code: 0, body: null, json: null, sendJson: (r, code, body) => { r.code = code; r.body = body; } };
}

test('screen/swipe：起点=终点时按长按处理，时长下限抬到 300ms', async () => {
  const { swipe } = require('../server/api/screen');
  const { cmds, ctx } = fakeScreenCtx();
  const res = fakeRes();
  await swipe(ctx, null, res, null, {
    readJson: async () => ({ x1: 540, y1: 960, x2: 540, y2: 960, durationMs: 10 }),
    sendJson: res.sendJson,
  });
  assertEqual(cmds[0], 'input swipe 540 960 540 960 300', '原地按住不能被压成 50ms（那样长按不会触发）');
  assertEqual(res.code, 200);
});

test('screen/swipe：普通滑动保留真实时长，且超时按滑动时长放宽', async () => {
  const { swipe } = require('../server/api/screen');
  const cmds = [];
  let seenOpts = null;
  const adb = { input: async (c, o) => { cmds.push(c); seenOpts = o; }, shell: async () => {} };
  const ctx = { emulator: { state: 'running', adb: () => adb } };
  const res = fakeRes();
  await swipe(ctx, null, res, null, {
    readJson: async () => ({ x1: 540, y1: 1400, x2: 540, y2: 500, durationMs: 2500 }),
    sendJson: res.sendJson,
  });
  assertEqual(cmds[0], 'input swipe 540 1400 540 500 2500');
  // 常驻通道默认 4s：2.5s 的滑动一旦算上 adb 开销就会假超时
  assert(seenOpts && seenOpts.timeout >= 8500, `2.5s 滑动的通道超时必须放宽，实际 ${seenOpts && seenOpts.timeout}`);
});

test('_inject：常驻输入通道断了要退回一次性 adb shell，不能把这次点击丢掉', async () => {
  const { _inject } = require('../server/api/screen');
  const cmds = [];
  const adb = {
    input: async () => { throw new Error('adb shell 已退出'); },
    shell: async (c) => { cmds.push(c); },
  };
  await _inject(adb, 'input tap 540 960');
  assertEqual(cmds.join('|'), 'input tap 540 960', '必须用一次性 adb 重发同一条命令');
});

test('_inject：两条路都失败时才抛错（不能静默吞掉）', async () => {
  const { _inject } = require('../server/api/screen');
  const adb = {
    input: async () => { throw new Error('input 命令超时'); },
    shell: async () => { throw new Error('device offline'); },
  };
  let threw = false;
  try { await _inject(adb, 'input tap 1 1'); } catch (_) { threw = true; }
  assert(threw, '都失败必须抛错，让前端能提示');
});

test('输入后立刻补一帧（2fps 轮询下点完要等 500ms，会被当成「点了没反应」）', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'screen.js'), 'utf8');
  const i = src.indexOf('finally {', src.indexOf('async _dispatch'));
  assert(i > 0, '_dispatch 应有 finally 补帧');
  assert(/_grab\(\)/.test(src.slice(i, i + 400)), 'finally 里必须触发 _grab()');
  assert(/if \(this\._grabbing\) return/.test(src), '补帧与轮询不能并发（否则会打出两倍帧率）');
});
