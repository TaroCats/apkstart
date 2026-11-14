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

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      // 异步用例（waitForPackage 轮询）单独收集，最后串行跑
      pending.push({ name, fn });
      return;
    }
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
