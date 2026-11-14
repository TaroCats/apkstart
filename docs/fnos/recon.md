# ApkStart → fnOS（fpk）改造 · 共享技术上下文

> 本文件由主理人在勘察阶段产出，供产品/架构/工程/QA 共同使用，避免重复探索。

## 1. 上游项目事实

- 仓库：https://github.com/TaroCats/apkstart（上游 RoutineMiku/apkstart），版本 0.2.7，MIT。
- 形态：Electron 33 桌面应用，`main: src/main.js`，`os: ["win32"]`，唯一运行依赖 `@napi-rs/lzma`。
- 规模：src 约 10.4k 行 JS（main.js 1176、ui/app.js 1049、provision.js 952、engine.js 933、adb.js 815、emulator.js 635、installer.js 488、doctor.js 413）。
- 职责链：解析 APK（自带 ZIP/AXML/ARSC 解析）→ 部署 Android 运行时（adb + emulator + system image）→ adb 安装/启动应用 → 作为窗口展示。

### 模块清单与可移植性

| 模块 | 行数 | 作用 | Linux 可移植性 |
|---|---|---|---|
| core/zip.js | 236 | 零依赖 ZIP 读取 | ✅ 纯 JS |
| core/axml.js | 167 | 二进制 AndroidManifest 解析 | ✅ 纯 JS |
| core/arsc.js | 233 | resources.arsc 解析（应用名/图标） | ✅ 纯 JS |
| core/apk.js | 190 | 包名/版本/launcher/图标/ABI 汇总 | ✅ 纯 JS |
| core/png.js | 132 | PNG 编码 + 图标绘制 | ✅ 纯 JS（ICO 部分不用） |
| core/adb.js | 815 | adb 客户端（install/launch/screencap/input/权限） | ⚠️ 仅 `resolveAdb` 硬编码 `adb.exe`，其余纯进程调用 |
| core/engine.js | 933 | 运行时编排：启动/停止/空闲回收/健康检查 | ⚠️ 依赖 emulator/provision 的 Windows 路径 |
| core/emulator.js | 635 | emulator 进程托管、端口/参数 | ❌ 硬编码 `emulator.exe`、`tasklist`、powercfg |
| core/provision.js | 952 | 下载 adb/emulator/系统镜像、AEHD 驱动 | ❌ Windows 专用下载源与 exe 解包 |
| core/installer.js | 488 | 安装流水线 + .lnk 快捷方式 + ICO | ⚠️ 快捷方式部分不可用，安装主流程可复用 |
| core/store.js | 170 | apps.json / settings.json | ⚠️ 依赖 `%APPDATA%`，需改为 fnOS 数据目录 |
| core/doctor.js | 413 | 内存/核心/GPU 策略推导 | ⚠️ 含 Windows 加速探测（AEHD/WHPX） |
| core/win/*.ps1, windowctl.js, agent.js, appwin.js, pointer.js, display.js, notify.js, assoc.js, shortcut.js, container.js, layers.js | — | Win32 窗口 SetParent / 低层鼠标钩子 / 托盘 / 文件关联 / 桌面图标 | ❌ 全部 Windows 专属，fnOS 侧不适用 |
| main.js | 1176 | 窗口/托盘/单实例/CLI 分发/IPC（~60 个 handler） | ❌ 以 Electron 为中心 |
| preload.js + ui/ | 110 + 1049 + 479 | 渲染层，全部通过 `window.apkstart.*` 走 IPC | ⚠️ 改造成 HTTP 桥即可最大复用 |

结论：**解析层可直接复用，运行引擎层需重写 Windows 相关部分，展示层需从「Win32 窗口」改为「浏览器 + adb screencap」**。

## 2. 目标环境（已实测）

- 主机 `10.31.0.4`，hostname EVO4，Debian 12 (bookworm)，内核 `6.18.18.c1186-trim`，x86_64。
- fnOS 版本 `1.2.1010`；`/dev/kvm` 存在且可访问（支持硬件加速）；内存 15 GiB；已有 Node v22.23.4、Docker。
- SSH：`root@10.31.0.4` 免密可用。
- 应用安装路径 `/var/apps/<appname>/`，数据软链到 `/vol2/@appconf|@apphome|@appcenter|@appdata|@appmeta|@apptemp/<appname>`。
- 应用中心为 `trim_app_center`（Go 守护进程，HTTP 仅监听 5666/5667，经 nginx 认证）；本机 `app install-fpk` 需 OAuth 会话，**当前无凭据，无法自动化真机应用中心安装** → 采用「按 fpk 契约手动安装」验证 + 交付后由用户在应用中心点装核验。

## 3. fpk 打包规范（以机上真实包为证）

```
<appname>/
├── manifest              # key = value；含 appname/version/display_name/desc/platform/os_min_version/
│                         # desktop_uidir/desktop_applaunchname/changelog/source/maintainer/ctl_stop/checksum
├── ICON.PNG              # 64x64
├── ICON_256.PNG          # 256x256
├── app/                  # → 安装后 target/ (TRIM_APPDEST)，UI 在 app/ui/
│   └── ui/{config,images/icon_{64,256}.png}
├── cmd/                  # main(start|stop|status) + install_init/install_callback/
│                         # uninstall_init/uninstall_callback/upgrade_init/upgrade_callback/
│                         # config_init/config_callback（需 chmod +x）
├── config/{privilege,resource}   # JSON
├── wizard/{install,uninstall,upgrade,config}  # 可选 JSON
└── 最终 tar.gz 重命名为 <appname>_<version>_<arch>.fpk
```

- `cmd/main` 约定：`start`/`stop` 成功返回 0；`status` 运行中 0、未运行 3（机上 wechat-on-cloud 实例即此约定）。
- `ui/config` 形如 `{".url": {"<appname>.<entry>": {title, icon, type: "url"|"iframe", protocol: "http", port: "${PORT}", url: "/", allUsers: true}}}`。
- `config/privilege` 示例：`{"defaults":{"run-as":"package"},"username":"<app>","groupname":"<app>","join-groups":["docker"]}`。
- 版本/校验：`manifest` 内 `checksum` 为包校验；`os_min_version` 建议 ≥ 1.2.0。

## 4. fnDepot 发布规范（V2）

- 仓库名必须为 `FnDepot`（大小写敏感、Public、默认分支 main）。
- 根目录唯一索引 `fnpack.json`：`schema_version:"2"`、`source_info{name,author,homepage,description}`、`apps{<appname>:{display_name,desc,platform:[...],categories,icon_url,readme_url,preview_urls,maintainer,distributor,run_as,install_type,is_docker,service_port,releases{<version>:{changelog,updated_at,packages{<arch>:{download_url,sha256,size}}}}}}`。
- 应用目录 `<appname>/`：`ICON.PNG`（全大写）+ `<appname>_<version>_<arch>.fpk` + 可选 `README.md`、`Preview/`。
- `categories` 取值受限：影音娱乐/系统工具/编程开发/AI赋能/生活服务/智能智控/教育学习/游戏地带/硬件驱动 → 本应用取「系统工具」。

## 5. 关键约束

- 目标机 fnOS 只跑 Linux，Android 运行时改为 **Linux 版 emulator（qemu）+ KVM**，`-no-window` 无头运行，画面通过 `adb exec-out screencap -p` 输出，交互通过 `adb shell input`。
- 原项目「每个应用一个 Windows 桌面图标/窗口」改为「Web 控制台 + 单应用页面」，符合 NAS 使用场景。
- 服务须以非 root 用户运行（`run-as: package`），端口在 manifest/ui config 中声明。
