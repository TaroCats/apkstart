'use strict';
/**
 * 配置：解析 TRIM_* 环境变量 → PATHS + 默认端口/参数，并提供 ensureDirs。
 * 只依赖 paths.js 与 Node 内置模块，供所有 service 依赖注入，避免循环依赖。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PATHS, buildPaths, ensureDirs } = require('./service/paths');

/** 应用版本（打包时可由 APKSTART_VERSION 覆盖）。 */
const VERSION = process.env.APKSTART_VERSION || '0.1.0';

/** Web 控制台默认端口（PRD §4.1）。 */
const DEFAULT_PORT = 18990;

/** 服务监听地址：默认 0.0.0.0（局域网可访问）；P1 可切 unix socket。 */
const DEFAULT_HOST = '0.0.0.0';

/** settings.json 默认值（ARCH §3.2）。 */
const DEFAULT_SETTINGS = {
  port: DEFAULT_PORT,
  screen: { fps: 2, maxWidth: 720 }, // fps 默认 2；maxWidth=0 表原图
  emulator: {
    name: 'apkstart',
    apiLevel: 34,
    imageTag: 'google_apis',
    abi: 'x86_64',
    memoryMB: 2048, // 0=自动（按机器内存，cap 4096）
    cores: 2, // 0=自动（min(4, 物理核/2)）
    // GPU 模式：'auto' | 'off' | 'host' | 'swiftshader_indirect' | ...
    //   auto（默认）= 宿主有「带 -hw3d 的 X server」且能读写 renderD128 时用 host，
    //   否则 off。裁决逻辑见 server/service/gpu.js，前提与实测见 IMPL 偏差 5 更正。
    //   实测收益：off 中位 30960ms → host 中位 27666ms（-3.3s / -10.6%）。
    //   注意：任何非 off 模式都必须有 X display，否则 QEMU 2s 内崩（旧实现漏校验）。
    gpu: 'auto',
    // 是否允许 auto 模式自动启用加速（关掉则等价于 gpu:'off'，但保留配置）
    gpuAutoEnable: true,
    // 显式指定 Xkasmvnc 路径（留空则按 RUNTIME/xserver/Xkasmvnc → PATH 探测）。
    // 本包**不自带**该二进制：KasmVNC 是 GPL-2.0，且依赖 libxfont2/libpixman/
    // libunwind/libwebp/libxshmfence 等独立包，随包分发不划算（详见 xserver.js 头注）。
    xserverPath: '',
    idleShutdownMinutes: 0, // 0=不自动关机
    // 开机后禁用蓝牙子系统（IMPL 偏差 9）。无头模拟器没有 netsim/蓝牙后端，
    // com.android.bluetooth 会反复崩溃并弹「Bluetooth keeps stopping」，
    // 抢走前台焦点、把弹窗画进截图。禁用后弹窗消失、前台稳定。
    // 需要 adb root + pm disable 才会持久（disable-user 重启模拟器后复发）。
    // 若将来要做蓝牙相关调试，可在设置里改成 false。
    disableBluetooth: true,
  },
  runtime: { baseUrl: 'https://dl.google.com/android/repository' },
};

/**
 * 系统镜像元信息（P0 固定为 google_apis 镜像）。
 *
 * 为何不用 google_apis_playstore（§9-A2 原定值，已被真机实测推翻）：
 *   Play 镜像在无头模式（-no-window）下 adb 授权弹窗无法确认，`adb devices`
 *   会永久停留在 unauthorized；若强行加 `-prop ro.adb.secure=0`，emulator
 *   会直接段错误崩溃（真机复现两次）。改用 google_apis 后 adb 直接授权
 *   （ro.adb.secure=0），虚拟机可正常 boot。
 *
 * 注意：google_apis **不含 ARM 翻译层**（libndk_translation / libhoudini），
 *   因此无法运行 arm64-only 应用，installer 需对其显式返回 UNSUPPORTED。
 * 三者须与下载清单、AVD config.ini 的 image.sysdir.1 完全一致。
 */
const SYSTEM_IMAGE = { apiLevel: 34, tag: 'google_apis', abi: 'x86_64' };
const SYSTEM_IMAGE_DIR = `system-images/android-${SYSTEM_IMAGE.apiLevel}/${SYSTEM_IMAGE.tag}/${SYSTEM_IMAGE.abi}`;

/**
 * 运行时组件下载清单（ARCH §5.5 / §9-A2）。sha256 为空则只校验 size。
 * extractDir：解压目标（相对 $TRIM_PKGVAR/runtime）。平台产物顶层结构各异，
 *   platform-tools/emulator 的 zip 顶层即为目录名 → 解压到 runtime 根；
 *   system-image 的 zip 顶层是 `x86_64/`，需解到 .../google_apis 下，
 *   才能得到 system-images/android-34/google_apis/x86_64/ 的标准布局。
 * sha256 均为实测下载产物值（ARCH §9-A2 表格）。
 */
const PROVISION_MANIFEST = {
  'platform-tools': {
    name: 'platform-tools',
    fileName: 'platform-tools-latest-linux.zip',
    relPath: 'platform-tools-latest-linux.zip',
    // platform-tools-latest-linux.zip (~8.7MB)，实测 sha256
    sha256: 'd230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1',
    extractDir: '',
    marker: 'platform-tools/adb',
  },
  emulator: {
    name: 'emulator',
    fileName: 'emulator-linux_x64-16847572.zip',
    relPath: 'emulator-linux_x64-16847572.zip',
    // emulator-linux_x64-16847572.zip (~339MB)，实测 sha256
    sha256: '0127e7c763f8db1915095cc761cfb6504b94cc8846b618c9faf973fd04780426',
    extractDir: '',
    marker: 'emulator/emulator',
  },
  'system-image': {
    name: 'system-image',
    fileName: 'x86_64-34_r14.zip',
    relPath: 'sys-img/google_apis/x86_64-34_r14.zip',
    // google_apis x86_64-34_r14.zip (1563721130 B)，实测 sha256
    sha256: '783a40134baf4f3012d4464fbe1571b1612a0dbd2e7a44d14bd8328923443833',
    extractDir: `system-images/android-${SYSTEM_IMAGE.apiLevel}/${SYSTEM_IMAGE.tag}`,
    marker: `${SYSTEM_IMAGE_DIR}/system.img`,
  },
};

/** 深合并（patch 覆盖 base；仅普通对象递归，数组整体替换）。 */
function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (
      v && typeof v === 'object' && !Array.isArray(v)
      && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 物理内存（MB），供 emulator 自动内存推导。 */
function totalMemMB() {
  try {
    const t = os.totalmem();
    return Math.round(t / (1024 * 1024));
  } catch (_) {
    return 2048;
  }
}

/** 物理核数。 */
function cpuCount() {
  try { return os.cpus().length || 2; } catch (_) { return 2; }
}

/** 确保目录存在（透明转发，便于 index.js 只 require config）。 */
function ensureAllDirs() {
  ensureDirs(PATHS);
}

module.exports = {
  VERSION,
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_SETTINGS,
  PROVISION_MANIFEST,
  SYSTEM_IMAGE,
  SYSTEM_IMAGE_DIR,
  PATHS,
  buildPaths,
  ensureDirs,
  ensureAllDirs,
  deepMerge,
  totalMemMB,
  cpuCount,
  path,
  fs,
};
