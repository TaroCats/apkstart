#!/usr/bin/env node
// =============================================================================
// 校验 fpk 包结构（build/pack.sh 与 test/fnos-unit.js 共用）
//
// 背景（0.2.1 踩过的坑）：
//   我们曾把应用代码放在 fpk 根下的 `app/` 目录里。App Center 装到一半就报
//     ApkStart 安装状态失败 (code 10107):
//     failed to decompress app.tgz: failed to open tgz file:
//     open /vol2/appcenter-downloads/apkstart-fnos-0.2.1-tpk/app.tgz:
//     no such file or directory
//   真因：App Center 只认**根级 `app.tgz`（嵌套压缩包）**，不认识 `app/` 目录。
//   它不会去遍历目录，直接 open("<pkgdir>/app.tgz") → ENOENT。
//
// 真机取证（/var/log/trim_app_center/*.log 的 security 模块逐包记账）：
//   平台已装的 9 个第三方应用无一例外都是
//     dirs="[cmd config wizard]" files="[ICON.PNG ICON_256.PNG app.tgz manifest]"
//   而我们的 0.2.1 是
//     dirs="[app cmd config wizard]" files="[ICON.PNG ICON_256.PNG manifest]"
//   → 紧跟一行 "failed to decompress app.tgz"。
//
// 解包语义（从已装应用 /vol2/@appcenter/fnmusic-hub 反向确认）：
//   app.tgz 的**内容原样解包进 TRIM_APPDEST**（形如 /volX/@appcenter/<appname>，
//   /var/apps/<appname>/target 是它的软链），没有前缀剥离、没有外层目录套壳。
//   fnmusic-hub 的 app.tgz 顶层是 app/ bin/ config/ ui/，装完就是
//   $APPDEST/{app,bin,config,ui}。所以我们的 app.tgz 顶层应当是
//   server/ core/ ui/（对应 cmd/main 里的 $APPDEST/server/index.js）。
//
// 用法：node build/validate-package.js <dist/xxx.fpk>
//      通过打印 "包结构校验通过: …"；失败逐条打印并以 1 退出。
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** fpk 根下必须存在的普通文件。 */
const ROOT_FILES = ['manifest', 'ICON.PNG', 'ICON_256.PNG', 'app.tgz'];
/** fpk 根下必须存在的目录。 */
const ROOT_DIRS = ['cmd', 'config', 'wizard'];
/** app.tgz 解包后（= TRIM_APPDEST）必须存在的目录。 */
const APP_TOP_DIRS = ['core', 'server', 'ui'];
/** app.tgz 里必须存在的具体文件（证明不是空气包 / 套错壳）。 */
const APP_MUST_FILES = ['server/index.js', 'server/config.js', 'ui/config', 'ui/index.html'];

/**
 * 剥掉 fpk tar 那层公共顶层目录（`apkstart-fnos/`），得到真正的「包根」条目。
 * fpk 本身是 `tar -C stage apkstart-fnos` 打出来的，所以每条都带这个前缀；
 * App Center 解包后进的是这个目录内部，判断「根级有没有 app.tgz」必须在这层看。
 * @param {string[]} list
 * @returns {string[]}
 */
function stripPackageWrapper(list) {
  const cleaned = list
    .map((s) => String(s).replace(/^\.\//, '').trim())
    .filter((s) => s && s !== './');
  if (!cleaned.length) return cleaned;
  const tops = new Set(cleaned.map((s) => s.split('/')[0]));
  if (tops.size !== 1) return cleaned; // 没有唯一顶层目录 → 已经是包根
  const only = [...tops][0];
  const hasNested = cleaned.some((s) => s.startsWith(`${only}/`));
  const isFileAtRoot = cleaned.includes(only) && !cleaned.includes(`${only}/`);
  if (isFileAtRoot || !hasNested) return cleaned;
  return cleaned.map((s) => (s === `${only}` ? '' : s.slice(only.length + 1))).filter(Boolean);
}

/**
 * 把 tar 条目列表收敛成「顶层名 → 是目录」的映射。
 * 兼容 `./xxx` 前缀与 `xxx/` 目录尾斜杠两种写法。
 * @param {string[]} list
 * @returns {Map<string, boolean>} value=true 表示目录
 */
function topEntries(list) {
  const map = new Map();
  for (const raw of list) {
    const e = String(raw).replace(/^\.\//, '').trim();
    if (!e || e === '.' || e === './') continue;
    const isDir = e.endsWith('/');
    const name = e.split('/')[0];
    if (!name) continue;
    // 目录只要出现一次就是目录；文件条目同名前缀也视为目录（如 `cmd/install_init`）
    const dirLike = isDir || e.includes('/');
    if (!map.has(name) || dirLike) map.set(name, dirLike ? true : map.get(name));
  }
  return map;
}

/**
 * 纯函数：给定 fpk 根条目与 app.tgz 内条目，返回错误清单。
 * 单独抽出来是为了让单测能直接喂人造数据（不用真打包）。
 * @param {string[]} rootList
 * @param {string[]|null} appList app.tgz 的条目（读不到时传 null）
 * @returns {string[]}
 */
function checkListing(rootList, appList) {
  const errors = [];
  const root = topEntries(stripPackageWrapper(rootList));

  // ① 根级 app.tgz（本次 10107 的根因）
  if (!root.has('app.tgz')) {
    errors.push(
      '缺少根级 app.tgz：App Center 只认嵌套压缩包，不认 app/ 目录。' +
        '否则安装时报 "failed to decompress app.tgz: … no such file or directory (code 10107)"'
    );
  } else if (root.get('app.tgz') === true) {
    errors.push('app.tgz 必须是普通文件，实际是目录');
  }

  // ② 根级不许有 app/ 目录（0.2.1 的错误形态）
  if (root.has('app')) {
    errors.push(
      '根目录不应出现 app/ 目录：应用负载必须打进 app.tgz。' +
        '平台记账为 dirs="[app cmd config wizard]"，App Center 会直接去找 app.tgz 并失败（10107）'
    );
  }

  // ③ 根级骨架
  for (const f of ROOT_FILES) {
    if (!root.has(f)) errors.push(`缺少根级文件: ${f}`);
  }
  for (const d of ROOT_DIRS) {
    if (!root.has(d)) errors.push(`缺少根级目录: ${d}/`);
    else if (root.get(d) !== true) errors.push(`根级 ${d} 必须是目录，实际是普通文件`);
  }

  // ④ app.tgz 内层
  if (appList === null) return errors; // 根级就错了，内层无从校验
  if (!Array.isArray(appList) || appList.length === 0) {
    errors.push('app.tgz 是空包（解包后 TRIM_APPDEST 里什么都没有）');
    return errors;
  }
  const app = topEntries(appList);
  for (const d of APP_TOP_DIRS) {
    if (!app.has(d)) errors.push(`app.tgz 内缺少顶层目录: ${d}/（cmd/main 按 $APPDEST/${d} 取路径）`);
    else if (app.get(d) !== true) errors.push(`app.tgz 内 ${d} 必须是目录`);
  }
  // 套壳检查：app.tgz 顶层出现 appname 目录说明多裹了一层，装完会变成 $APPDEST/<appname>/server
  if (app.size === 1 && app.get('apkstart-fnos') === true) {
    errors.push('app.tgz 多裹了一层 apkstart-fnos/：内容会落到 $APPDEST/apkstart-fnos/ 而不是 $APPDEST/');
  }
  const files = new Set(appList.map((e) => String(e).replace(/^\.\//, '').trim()));
  for (const f of APP_MUST_FILES) {
    if (!files.has(f)) errors.push(`app.tgz 内缺少文件: ${f}`);
  }

  return errors;
}

/** 用 tar 列出一个压缩包的条目（fpk 与 app.tgz 都是 tar.gz）。 */
function listTar(file) {
  const out = execFileSync('tar', ['-tzf', file], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'], // 忽略 "A lone zero block" 之类无害告警
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * 校验一个已建好的 .fpk。
 * @param {string} fpk
 * @returns {{errors: string[], rootCount: number, appCount: number}}
 */
function validateFpk(fpk) {
  if (!fs.existsSync(fpk)) return { errors: [`文件不存在: ${fpk}`], rootCount: 0, appCount: 0 };

  let rootList;
  try {
    rootList = listTar(fpk);
  } catch (e) {
    return { errors: [`不是有效的 tar.gz（fpk 必须是 gzip 压缩的 tar）: ${e.message}`], rootCount: 0, appCount: 0 };
  }

  // 把 app.tgz 抽到临时目录再列条目：tar 不能直接读「包里的包」。
  let appList = null;
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'validate-pkg-'));
  try {
    const root = topEntries(stripPackageWrapper(rootList));
    if (root.has('app.tgz') && root.get('app.tgz') !== true) {
      // 连同外层目录名一起抽（fpk 里它是 apkstart-fnos/app.tgz）
      const member = rootList
        .map((s) => String(s).replace(/^\.\//, ''))
        .find((s) => /^([^/]+\/)?app\.tgz$/.test(s));
      if (member) {
        execFileSync('tar', ['-xzf', fpk, '-C', tmpDir, member], { stdio: 'ignore' });
        const inner = path.join(tmpDir, ...member.split('/'));
        if (fs.existsSync(inner)) appList = listTar(inner);
      }
    }
  } catch (_) {
    appList = null; // 读不出来就交给 checkListing 报「空包/缺失」
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }

  return {
    errors: checkListing(rootList, appList),
    rootCount: rootList.length,
    appCount: Array.isArray(appList) ? appList.length : 0,
  };
}

module.exports = { checkListing, validateFpk, topEntries, stripPackageWrapper };

if (require.main === module) {
  const fpk = process.argv[2];
  if (!fpk) {
    console.error('用法: node build/validate-package.js <dist/xxx.fpk>');
    process.exit(2);
  }
  const res = validateFpk(path.resolve(fpk));
  if (res.errors.length) {
    console.error(`!! 包结构校验失败（${fpk}）`);
    for (const e of res.errors) console.error('   - ' + e);
    process.exit(1);
  }
  console.log(`包结构校验通过: 根 ${res.rootCount} 条目 / app.tgz ${res.appCount} 条目（${path.basename(fpk)}）`);
}
