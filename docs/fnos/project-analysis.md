# ApkStart 项目分析总结

> 分析对象：`https://github.com/TaroCats/apkstart`（上游 RoutineMiku/apkstart）v0.2.7，MIT。分析时间 2026-11-14。

## 一、TL;DR

ApkStart 是一个 **Windows 上的「APK → 原生应用」转换器**：它自己下载并托管一整套 Android 运行时（adb + Google Android Emulator + Android 14 系统镜像），把每个 APK 安装进这台虚拟机，再**把模拟器窗口改造成该应用的原生窗口**（改标题、换真图标、竖屏比例、全屏居中），同时生成桌面/开始菜单 `.lnk` 快捷方式。壳层零第三方依赖——ZIP、PNG/ICO、AXML、ARSC 全是手写解析器。

一句话概括其架构：**Electron 壳 + 自持 Android 运行时 + adb 作为唯一控制面 + Win32 窗口伪装层**。

## 二、核心功能

| 能力 | 实现要点 |
|---|---|
| 双击 APK 即装 | 注册 HKCU `.apk` 关联（免管理员），命令行 `ApkStart.exe <apk>` 分发到安装流水线 |
| 离线解析 APK | 自研 `zip/axml/arsc` 解析 `AndroidManifest.xml` 与 `resources.arsc`，取出包名、版本、launcher Activity、应用名、图标、ABI，无需 aapt |
| 真实图标 | 从 APK 提取最高分辨率图标 → 自研 PNG 解码/编码 → 生成多尺寸 ICO（16~256）→ `.lnk` |
| 运行时自持 | `provision.js` 按 SDK 索引（`repository2-3.xml` / `sys-img2-3.xml`）解析真实下载地址，8 线程分块 + 断点续传下载 emulator、platform-tools、system image |
| 会话复用 | `engine.ensure()` 先探测已在线设备 → 接管遗留模拟器（`adoptExisting`）→ 复用 `emulator-N` → 才冷启；空闲 15 分钟自动回收 |
| 每应用一窗口 | `appwin.js` / `windowctl.ps1` 用 Win32 `SetParent` 把模拟器窗口嵌进 Electron 子窗口，改标题/图标/尺寸，`F11` 全屏 |
| 启动可靠性 | 启动后观察 18 秒，闪退自动重试 → 重置数据 → 补权限；`doctor.js` 失败后按「渲染后端 → 加速方式 → 内存/冷启动」最多 4 组参数降级重试 |
| 输入映射 | 低级鼠标钩子：右键=返回、滚轮=平滑滑动（仅前台挂载，失焦卸载） |
| 数据互通 | `sharer.js` 双向同步 `%USERPROFILE%\ApkStartShared` ↔ `/sdcard/ApkStartShared` |
| 权限自动授予 | 安装后 `pm grant` 补齐运行时权限，避免卡在系统授权框 |

## 三、模块结构

```
src/
├─ main.js(1176)      主进程：窗口/托盘/单实例/CLI 分发/~60 个 IPC handler/启动编排
├─ preload.js(110)    contextBridge 暴露 window.apkstart.*
├─ ui/                原生 HTML/CSS/JS 渲染层（app.js 1049 行，无框架）
└─ core/
   【解析层·纯 JS，零依赖】
   zip.js(236) axml.js(167) arsc.js(233) apk.js(190) png.js(132)
   【资产层·Windows】
   shortcut.js(171) .lnk+ICO   assoc.js(68) 文件关联
   【运行层】
   adb.js(815)       adb 客户端：install/install-multiple/startApp(freeform)/screencap/input/pm grant
   engine.js(933)    运行时总编排：ensure/boot/stop/空闲回收/健康检查/诊断
   emulator.js(635)  emulator 进程托管、动态端口、AVD 锁清理、参数降级
   provision.js(952) 组件下载与校验、镜像解压（xz/LZMA2）、环境自检
   doctor.js(413)    按物理内存推导 vCPU/内存/GPU 后端，加速能力探测（AEHD/WHPX）
   container.js(163) 纯计算层：应用级「容器」裁剪策略（可裁剪包白名单/黑名单）
   【编排/持久化】
   installer.js(488) 解析→安装→落库→建快捷方式 流水线
   store.js(170)     apps.json / settings.json（%APPDATA%\apkstart）
   【Win32 表现层】
   appwin.js windowctl.js agent.js pointer.js display.js notify.js
```

## 四、执行逻辑（关键路径）

**安装 APK**
```
CLI/双击 → main.js 分发 → installer.install()
  → parseApk()（zip→axml→arsc 三级解析）
  → 若 ABI 仅 arm：自动补 Play 镜像并切兼容模式
  → runtime.ensure()：在线?→复用；否则 adoptExisting→孤儿清理→emulator.boot()
  → adb.install()（.apks/.xapk 走 install-multiple）
  → pm grant 补权限 → store 落库 → shortcut 生成 ICO + .lnk
```

**启动应用（桌面图标）**
```
ApkStart.exe --launch <pkg>
  → runtime.ensure()（已常驻则秒开）
  → adb.resolveLauncher(pkg)（用系统解析的 LAUNCHER，而不是 APK 里写死的主 Activity）
  → am start --windowingMode freeform + 指定 bounds
  → waitAppAlive(18s) 观察存活 → 失败则重试/重置数据/补权限
  → AppWindow 把模拟器窗口 SetParent 嵌入 → 状态同步到渲染层
```

**设计取舍（值得借鉴的三点）**
1. **控制面统一到 adb**：引擎可替换（emulator / QEMU / 外部 WSA 都能挂），这是本项目最关键的抽象。
2. **无头模式反而不可用**：Windows 上无窗口时 SurfaceFlinger 不出 VSYNC，应用活着但屏幕空白 → 必须带窗口再「伪装」成应用窗口。
3. **失败即降级**：所有启动参数都有多级回退，并把失败原因翻译成中文 + 修复建议。

## 五、移植到 fnOS 的结论

| 层 | 处理方式 |
|---|---|
| 解析层（zip/axml/arsc/apk/png） | **原样复用**，纯 JS 无平台耦合 |
| adb 客户端 | 复用，仅改 `resolveAdb` 的可执行文件名（`adb.exe` → `adb`） |
| 运行层（engine/emulator/provision/doctor） | **重写平台适配**：Linux emulator 二进制、`/dev/kvm` 加速、无头 `-no-window`、Linux 下载源 |
| Win32 表现层（appwin/windowctl/pointer/assoc/shortcut/notify/display） | **全部不迁移**（NAS 无桌面），改为 Web 控制台 + `adb screencap` 画面回传 + `input` 注入 |
| 壳层（Electron main/preload） | 换成 **Node HTTP 服务 + REST 桥**，前端 UI 通过 `window.apkstart` 的 fetch 垫片复用 |
| 分发 | 由 Electron NSIS/portable 改为 **fpk 包 + GitHub Actions + fnDepot 索引** |

详细规范与实测数据见 `docs/fnos/recon.md`。
