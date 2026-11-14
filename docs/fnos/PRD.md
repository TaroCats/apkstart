# ApkStart for fnOS · 产品需求文档（PRD）

## 0. 项目信息

- **Language**：中文
- **Programming Language**：Node.js 22 + 原生 HTML/CSS/JS（零第三方运行时依赖，沿用上游约定）。
  > 不采用 Vite + React + MUI + Tailwind：本应用运行在无图形界面的 NAS 上，无构建期前端框架收益；上游 `src/ui/` 已是原生 JS，改造成 HTTP 桥即可最大复用，且 fpk 体积与依赖安装时间敏感。
- **Project Name**：`apkstart-fnos`
- **原始需求复述**
  1. 克隆并读懂 `https://github.com/TaroCats/apkstart`，输出核心功能 / 模块结构 / 执行逻辑分析总结。
  2. 改造为适配飞牛 fnOS 的 fpk 应用：调整目录结构、配置文件、启动/停止脚本、依赖项。
  3. 通过 SSH 部署到 `10.31.0.4`（fnOS 1.2.1010 / Debian 12 / x86_64 / 有 `/dev/kvm` / Node 22 / Docker）安装并验证可正常运行。
  4. 编写 GitHub Actions 工作流自动打包 fpk，产物可在 fnDepot 仓库发布。

### 方案约束（主理人已裁决，不在本 PRD 内重开）

- 平台由 Windows 桌面 → fnOS（Linux，无图形界面）。Electron 窗口 / 托盘 / 桌面快捷方式 / `.lnk` / ICO / `.apk` 文件关联 / Win32 鼠标钩子 **全部不迁移**。
- 运行时改为 **Linux 版 Android Emulator（QEMU）+ KVM**，`-no-window` 无头运行；画面用 `adb exec-out screencap -p` 拉取，交互用 `adb shell input`。
- 交互形态为 **Web 控制台**（浏览器访问 NAS 端口）；应用中心桌面入口用 `ui/config` 的 `type=url` 指向该端口。
- 解析层（zip / axml / arsc / apk / png）**原样复用**；运行引擎层重写 Windows 相关部分。
- 服务以 `run-as: package` 非 root 运行；端口取一个默认值并在 manifest / ui config 中声明。
- 真机「应用中心点装」无法自动化（应用中心 HTTP 需 OAuth，无凭据）→ 验证方式为「按 fpk 契约手动安装 + 启停脚本 + Web/API 功能验证」，并由用户在应用中心点装做最终核验（风险项见 §3）。

---

## 1. 产品目标

把 ApkStart 的「解析 APK → 部署 Android 运行时 → adb 装应用 → 呈现并操作」这条链路，从 Windows 单机桌面软件改造成一台 fnOS NAS 上的常驻服务：NAS 管理员通过浏览器打开应用中心里的一个入口，上传 APK、一键部署基于 KVM 的无头 Android 模拟器、安装并启停安卓应用，在网页里看到实时画面并用鼠标完成点击/滑动/输入，全程不需要 SSH、不需要 root、不需要显示器；同时以标准 fpk 交付、由 GitHub Actions 自动打包、可直接发布到 fnDepot。核心价值是把「NAS 多出来的算力 + KVM」变成一个安卓应用的常驻托管环境，而非桌面上的一次性启动器。

### 1.1 与上游的差异表

| 上游功能 | 处置 | 说明 |
|---|---|---|
| APK 解析（zip/axml/arsc/apk/png） | **保留** | 纯 JS，零改动复用 |
| 应用图标生成（PNG） | **保留** | 输出 PNG 供 Web 控制台展示 |
| ICO 多尺寸生成 / `.lnk` 快捷方式 / `.apk` 文件关联 | **裁剪** | Windows 专属，Linux 无对应语义 |
| Electron 主进程（窗口/托盘/单实例/IPC ~60 handler） | **重写** | 改为 Node HTTP 服务 + JSON API；IPC 一一映射为 HTTP 路由 |
| 渲染层 `src/ui/` | **重写（结构复用）** | 去掉 `window.apkstart.*` 桥，改 `fetch` 调 API；视觉与交互流程尽量保留 |
| 画面呈现（Win32 SetParent 窗口 / display.js / pointer.js） | **重写** | 改为浏览器内 `<img>` 拉流 + 坐标换算回 `adb shell input` |
| adb 客户端（install/launch/screencap/input/权限） | **保留（小改）** | 仅 `resolveAdb` 由硬编码 `adb.exe` 改为从 `$TRIM_APPDATA/runtime/platform-tools/adb` 解析 |
| emulator 进程托管 | **重写** | Linux `emulator` 二进制、`-no-window -no-audio -gpu swiftshader_indirect`、`-accel on`（KVM）；去掉 `tasklist` / `powercfg` |
| provision 运行时下载 | **重写** | 改 Linux 官方源产物；去掉 AEHD 驱动；新增 `/dev/kvm` 可用性检测 |
| doctor 硬件策略 | **重写** | 删除 AEHD / WHPX 探测；改为「KVM 可用？可用 → 硬件加速；不可用 → 明确报错并给降级建议」 |
| installer 安装流水线 | **保留主流程 / 裁剪副作用** | 安装→启动→存活观察→闪退重试保留；去掉快捷方式与图标落盘 |
| 共享目录双向同步（`ApkStartShared`） | **保留（P1）** | 目录由 `%USERPROFILE%` 改为 `$TRIM_APPDATA/shared` |
| store（`%APPDATA%` 下 apps/settings） | **重写（仅路径）** | 落盘到 `$TRIM_APPDATA` |
| 开机自启 / 常驻托盘 | **重写** | 由 fpk `cmd/main start|stop` + 应用中心托管生命周期 |
| 打包分发（electron-builder / NSIS / 便携版） | **重写** | fpk（`tar.gz` 改名）+ GitHub Actions + fnDepot `fnpack.json` |
| 多应用隔离 / 快照 quickboot / `.apks` `.xapk` 安装 | **保留（P1）** | 上游已有，路径适配即可 |

---

## 2. 用户故事（NAS 管理员视角）

1. 作为 NAS 管理员，我想把 APK 拖到网页里就能看到解析出的包名/版本/ABI/权限/图标，以便在装之前确认这是对的包、能不能在 x86_64 上跑。
2. 作为 NAS 管理员，我第一次打开应用时希望页面直接告诉我运行时还没部署，并给一个「一键部署」按钮显示下载进度，以便不用登 SSH 手动拉 adb 和系统镜像。
3. 作为 NAS 管理员，我想在页面上看到模拟器的真实状态（未部署/未运行/启动中/运行中/异常）与启动耗时、内存占用，并能一键启停，以便出问题时不依赖命令行。
4. 作为 NAS 管理员，我想在浏览器的画面里直接点击、滑动、返回、输入文字，以便像用手机一样操作这个安卓应用。
5. 作为 NAS 管理员，我想看到已安装安卓应用的列表（图标/名称/包名/版本/运行状态），并支持安装、启动、停止、卸载，以便长期把它当成一个托管环境管理。
6. 作为 NAS 管理员，我想卸载 fpk 时后台服务被正确停止、模拟器进程被回收、数据目录按我的选择保留或清理，以便不在 NAS 上留下僵尸进程和几十 GB 垃圾。
7. 作为 NAS 管理员，我想在应用中心的桌面上看到一个应用图标，点开就是 Web 控制台，以便不用记 IP 和端口。
8. 作为维护者，我想打一个 tag 就由 GitHub Actions 打出 fpk 并生成 fnDepot 索引，以便发布不依赖本地 Windows 环境。

---

## 3. 需求池

> 优先级：**P0 = 必须**（缺一不可上线）、**P1 = 应该有**、**P2 = 可以有**。每条均给可测验收标准。

### P0（必须）

**P0-1 fpk 交付骨架**
产出 `manifest`、`ICON.PNG`(64) / `ICON_256.PNG`(256)、`app/`（含 `app/ui/{config,images/icon_64.png,icon_256.png}`）、`cmd/` 共 **9 个**脚本（`main` + `install_init`/`install_callback`/`uninstall_init`/`uninstall_callback`/`upgrade_init`/`upgrade_callback`/`config_init`/`config_callback`，可执行位 +x）、`config/privilege`（`run-as: package`）、`config/resource`；最终产物名 `<appname>_<version>_x86.fpk`。
- 验收：`tar -tzf` 能列出上述全部条目；`cmd/*` 9 个脚本权限均为 0755；`manifest` 含 `appname/version/display_name/desc/platform/os_min_version(≥1.2.0)/maintainer/checksum`，其中 `platform` 取 fnOS **平台词表** `x86`（同 `arm` / `all`，不是内核架构 `x86_64`）；`ui/config` 中入口 `type: "url"`、`protocol: "http"`、`url: "/"`、`port` 为约定值（§4）。

**P0-2 APK 上传与解析**
Web 端支持选择或拖拽上传 `.apk`（单文件 ≤ 500 MB），服务端解析并返回包名、版本名/版本号、launcher Activity、ABI 列表、targetSdk、权限列表、应用名与图标（data URI）。
- 验收：上传上游 README 提到的 `com.phoenix.read`（arm64-v8a only）与一个 x86_64 APK，两者返回的 `packageName` 与 `aapt`/系统显示一致；图标能渲染出非空白 PNG；非法文件返回 4xx 与中文原因；`.apks`/`.xapk` 在 P0 阶段明确返回「暂不支持，见 P1-3」而不是崩溃。

**P0-3 运行时部署**
一键部署：下载 `platform-tools`（adb）、Linux `emulator`、x86_64 系统镜像到 `$TRIM_APPDATA/runtime`，带进度百分比、断点续传、SHA 校验、解压；启动前检测 `/dev/kvm`，不可用时给出明确中文说明。
- 验收：在 `10.31.0.4` 从零部署一次可在 Web 上看到 0→100% 进度并最终得到可执行 `$TRIM_APPDATA/runtime/platform-tools/adb`（`adb version` 输出正常）与 emulator 二进制；断网续传测试：中断后重试从已下载字节继续；`/dev/kvm` 不可用的模拟环境（可用 `-accel off` 或临时改权限模拟）下错误提示含「KVM 不可用」与建议。

**P0-4 模拟器启停、状态与日志**
提供 `start / stop / status / logs`：无头启动（`-no-window`），启动成功判定为 `adb wait-for-device` + `getprop sys.boot_completed == 1`；停止为优雅关机（`adb emu kill`），超时后强杀；至少保留最近 N 行模拟器 stdout/stderr。
- 验收：冷启动后 180 秒内 `status` 返回 `running`；`stop` 后 30 秒内进程消失、`status` 返回 `stopped`；连点两次 start 不会起第二个实例（幂等）；logs 接口能取到启动过程输出。

**P0-5 adb 连接与健康检查**
服务启动时确保 adb server 可用、`adb devices` 能列出模拟器；`screencap` 连续失败时自动判定运行时异常并置状态为 `error` + 原因。
- 验收：`status` 返回体包含 `adbConnected: true/false`；手动 `kill` 掉 emulator 进程后，30 秒内 `status` 变为 `error/stopped` 且错误文案为中文。

**P0-6 安卓应用安装 / 启动 / 卸载**
基于 adb `install -r`、按解析出的 launcher Activity `am start`、`pm uninstall`；保留闪退重试与「存活观察」逻辑；安装后写入 `apps.json`（包名/名称/版本/图标/安装时间）。
- 验收：装一个 APK → 列表出现该应用且图标正确 → 启动后 10 秒内 `dumpsys` 显示该包在前台 → 卸载后列表消失、`pm list packages` 不再含该包；重复安装同包名走升级不报错；启动失败返回中文原因而非 500。

**P0-7 Web 画面查看**
页面以固定帧率（默认 2 fps，可配置）拉取 `adb exec-out screencap -p` 输出并渲染；无画面时显示明确占位与「重新获取」按钮。
- 验收：应用启动后在浏览器看到画面内容随应用操作变化；连续 5 分钟拉流不出现内存持续增长（后台 RSS 波动 < 50 MB）；断流后自动恢复。

**P0-8 Web 输入（点击 / 滑动 / 文字）**
浏览器内点击 → `adb shell input tap x y`；拖拽 → `input swipe`；提供返回/Home；文本框输入 → `input text`（含中文需走可用的输入路径，如 base64/广播，实现由架构定）。
- 验收：点击画面上的按钮能触发对应 UI 变化（用设置页开关验证）；从 (x1,y1) 拖到 (x2,y2) 能滚动列表；输入 ASCII 文本成功显示在输入框；屏幕分辨率变化后坐标换算仍正确（比例换算以 `wm size` 为基准）。

**P0-9 Web 控制台 API + 页面**
单页控制台：运行时状态卡（P0-3/4/5）、上传解析区（P0-2）、应用列表与操作（P0-6）、画面与输入区（P0-7/8）、日志抽屉。API 为 JSON，错误统一 `{code, message}`。
- 验收：页面在 Chrome/Safari 最新版可直接打开无 console error；每个 API 有对应的页面可达操作路径；所有错误提示为中文。

**P0-10 fpk 安装 / 启动 / 停止 / 卸载脚本语义**
`cmd/main start` 拉起服务（后台/守护）、`stop` 停止服务与模拟器、`status` 运行中返回 0 / 未运行返回 3；`install_init` 依据 `TRIM_*` 创建数据目录与软链、`uninstall_init` 停止服务。
- 验收：在 `10.31.0.4` 上 `bash cmd/main start` 后 `curl http://127.0.0.1:<port>/api/health` 返回 200；`cmd/main status; echo $?` 为 0；`stop` 后为 3；重复 start 不产生多进程；`install_init` 后 `$TRIM_APPDATA` 下目录结构存在且属主为 package 用户。

**P0-11 GitHub Actions 自动打包**
`push tag v*` / `workflow_dispatch` 触发：装 Node → 拷贝 `app/` → 生成 `manifest`（注入版本号与 checksum）→ `tar.gz` → 改名 `.fpk` → 上传 artifact + 计算 sha256。
- 验收：在 fork 上打 tag，Actions 绿；下载 artifact 得到 `<appname>_<version>_x86.fpk`，`tar -tzf` 通过，sha256 与 workflow 输出一致；同一 tag 重跑产物 sha256 稳定（打包可复现的元数据已固定）。

**P0-12 fnDepot 索引生成**
在源仓库根目录生成符合 V2 的 `fnpack.json`（字段契约按目标机实测 schema）：
- `schema_version` = `"2"`；`source_info{name,author,homepage,description}`；
- `apps.apkstart-fnos` 含 `display_name` / `desc` / `platform: ["x86"]` / `categories: ["系统工具"]` / `icon_url` / `readme_url` / `maintainer` / `maintainer_url` / `distributor` / `distributor_url` / `run_as: "package"` / `install_type: ""`（空字符串） / `is_docker: false` / `service_port: "8890"`（**字符串**）；
- `releases.<version>` 含 `changelog` / `updated_at` / `packages.x86{download_url, sha256, size}`（packages 的 key 同为平台词表 `x86`）；
- **不含** `preview_urls` 键（真实源中不存在，不要写成空数组）；
- `download_url` 指向 **GitHub Release 资产**：`https://github.com/TaroCats/apkstart/releases/download/v<version>/apkstart-fnos_<version>_x86.fpk` —— 安装包放 Release，不进仓库。
- 验收：`jq . fnpack.json` 通过；上述字段逐项与实测 schema 对齐（`platform`/`packages` key 为 `x86`、`service_port` 为字符串、`install_type` 为空串、无 `preview_urls`）；`sha256`/`size` 与实际 fpk 产物一致；仓库根目录有合规 `fnpack.json` 且 Release 里有对应 fpk 资产后，fnDepot 添加该仓库为源能正确读取（**仓库名不必叫 `FnDepot`**，任意普通仓库根目录放 `fnpack.json` 即可被添加为源；此为当前唯一无法本地验证的环节——需真实推到 GitHub Public 仓库后在客户端添加源，若无法验证须在交付说明中标注未验证项）。

**P0-13 真机部署与验证**
按 fpk 契约在 `10.31.0.4` 手动安装（解包到 `/var/apps/apkstart-fnos/` 并对齐数据软链）→ 启停 → Web 功能全链路验证。
- 验收（按序执行并留痕）：① `cmd/main start` 后浏览器 `http://10.31.0.4:<port>/` 打开控制台；② 部署运行时成功；③ 启动模拟器到 `running`；④ 安装并启动一个 APK，画面可见、点击有效；⑤ `cmd/main stop` 后进程与模拟器全部退出；⑥ 记录每一步耗时与实测日志到交付文档。

### P1（应该有）

- **P1-1 共享目录同步**：`$TRIM_APPDATA/shared` ↔ 安卓 `/sdcard/ApkStartShared` 双向同步。验收：本机放入文件 5 秒内在安卓侧可见（截图验证），反向亦然。
- **P1-2 单实例多 AVD 与多应用隔离**：不同应用可分配不同 AVD 或共享实例（见待确认 Q3）。验收：两应用各自数据不串。
- **P1-3 `.apks` / `.xapk` 拆分包**：走 `install-multiple`。验收：一个 `.apks` 安装成功。
- **P1-4 quickboot 快照**：冷启动慢的机器保存快照，二次启动 < 10 秒。验收：二次启动实测。
- **P1-5 应用列表持久化与图标缓存**：重启服务后列表与图标不丢。验收：重启后列表一致。
- **P1-6 诊断导出**：一键导出日志 + 环境信息（KVM、内存、CPU、版本）zip。验收：可下载并解压出关键文件。
- **P1-7 端口占用自动回退**：默认端口被占用时递增探测并在页面显示实际端口。验收：先占住默认端口，服务仍能启动。
- **P1-8 离线完整包变体**：提供内置运行时的 fpk（体积大）与在线包（体积小）两个 release。验收：离线包断网可用。
- **P1-9 卸载清理选项**：卸载时可选保留/删除 `runtime`、`avd`、`shared`。验收：wizard 选择生效。
  > **已修正（IMPL 偏差 13）**：fnOS 的 wizard `field` 值不会传到 `cmd/*` 脚本，此项验收标准在当前平台上不可达。落地形态改为「默认保留数据 + 向导 `tips` 告知保留内容与手动清理路径」，脚本侧仅认外部传入的 `TRIM_UNINSTALL_PURGE=1`。
- **P1-10 错误中文化与重试策略**：模拟器启动失败按「渲染后端 → 加速方式 → 内存/冷启动」最多 4 组参数重试（沿用上游策略）。

### P2（可以有）

- **P2-1 访问控制**：控制台登录/token（见待确认 Q1）。
- **P2-2 屏幕录制/截图下载**：导出 mp4 或单帧 PNG。
- **P2-3 资源限额**：可配置模拟器 vCPU/内存上限、空闲超时自动关机。
- **P2-4 文件上传到安卓**：网页直接向 `/sdcard` 传文件。
- **P2-5 arm64 fpk**：为 arm64 NAS 出包（当前目标机为 x86_64）。
- **P2-6 日志级别与轮转**：按天轮转，保留 7 天。

---

## 4. 端口与目录约定

### 4.1 端口

- **Web 控制台默认端口 `8890`**（避开应用中心 5666/5667、8080/8443 等常用端口）。
- 声明位置：`manifest` 侧（供 fnDepot `service_port`）+ `app/ui/config` 的 `port` 字段 + 服务自身默认值。三者必须同源生成（由打包脚本注入），不允许三处手写不一致。
- `ui/config` 入口示例语义：`{".url": {"apkstart-fnos.main": {title:"ApkStart", icon:"images/icon_64.png", type:"url", protocol:"http", port:"8890", url:"/", allUsers:true}}}`。
- 服务监听 `0.0.0.0:8890`（需局域网访问），但 **adb server 与 emulator console 端口不得对外**：adb server 仅本机，emulator 走 `127.0.0.1` 端口段（5554+）。
- 端口冲突处理见 P1-7（P2 前允许启动失败并给中文提示）。

### 4.2 TRIM_* 环境变量使用

路径**只从环境变量取**，数据根按 **`TRIM_PKGVAR`（首选）→ `TRIM_APPDATA`（兼容兜底）→ `$HOME/.apkstart`（本地开发兜底）** 依次回退，与目标机真实应用用法一致（`grep -rho "TRIM_[A-Z_]*" /var/apps/*/cmd /var/apps/*/config` 统计：`TRIM_PKGVAR` 325 次为绝对主流，`TRIM_APPDATA` 仅 8 次为少数派）：

| 变量 | 用途 | 关键子路径 |
|---|---|---|
| `TRIM_PKGVAR` | **唯一持久数据根（首选）** | `runtime/`、`avd/`、`apps.json`、`settings.json`、`shared/`、`logs/` |
| `TRIM_APPDEST` | 安装后代码根（原 `app/`） | 服务入口、`ui/` |
| `TRIM_TEMP_LOGFILE` | 日志文件绝对路径 | 服务日志、生命周期脚本日志 |
| `TRIM_PKGTMP` | 可丢弃：下载缓存与上传暂存 | `downloads/`、`uploads/` |
| `TRIM_PKGHOME` | 进程 HOME；作为 `ANDROID_AVD_HOME` / `ANDROID_SDK_HOME` 基址 | `avd/` |
| `TRIM_PKGMETA` / `TRIM_APPNAME` | 元信息 / 应用名 | — |
| `TRIM_SERVICE_PORT` | 服务端口（由平台下发时可覆盖默认 8890） | — |

约束：`runtime/` 只读共享、`avd/` 按实例分目录、`$TRIM_PKGTMP` 允许被系统清空（**不得**放任何必需状态）。

### 4.3 数据目录划分

```
$TRIM_APPDEST/                 代码（服务 + Web 静态资源）
$TRIM_PKGVAR/
├── runtime/
│   ├── platform-tools/adb     adb（+x）
│   ├── emulator/              Linux emulator
│   └── system-images/         解压后的系统镜像（只读、全应用共享）
├── avd/<instance>/            AVD 实例（可写层 + 快照）
├── shared/                    与安卓 /sdcard/ApkStartShared 同步
├── logs/                      服务与生命周期日志（TRIM_TEMP_LOGFILE 优先）
├── apps.json                  已装应用清单
└── settings.json              全局设置
$TRIM_PKGTMP/
├── downloads/                 运行时下载分片（可清）
└── uploads/                   上传 APK 暂存（可清）
```

### 4.4 进程与权限（实测硬约束）

- 服务以 `run-as: package` 的 package 用户运行，**不要求 root**。
- **硬件加速依赖**：`/dev/kvm` 属组为 `all.editor`（`crw-rw---- root all.editor`），由 `config/privilege` 的 `join-groups:["all.editor"]` 授予；进组后 `KVM_WRITABLE` 通过、`-accel on` 生效。目标机 `kvm:x:104` 组存在但为空、与设备无关，**不要加 `kvm` 组**。运行时仍需检测，未生效则降级 `-accel off`（TCG）。
- **图形栈依赖**：默认 `gpu: 'auto'`——检测到「支持 `-hw3d` 的 X server + `renderD128` 可读写」就用 `-gpu host`（实测 −2.86s / −12.0%），否则纯软件 `-gpu off`（开机 ~23.8s）。**权限早已不是瓶颈**（`join-groups` 已含 `render`/`video`），唯一门槛是宿主有没有带硬件 3D 的 X display：唯一支持 `-hw3d` 的是 KasmVNC 的 `Xkasmvnc`，因 GPL-2.0 与 deb 依赖**不随包携带**，由运维投放到 `$TRIM_PKGVAR/runtime/xserver/`。无 `DISPLAY` 时 `-gpu host` / `swiftshader_indirect` 会 2s 内 `QEMU main loop exits abnormally with code 1`，故裁决层强制校验 `DISPLAY`。详见 IMPL「偏差 5 改造方案（已实施）」。
- 停止语义：`cmd/main stop` → 停服务 → `adb emu kill` → 等 30 秒 → 强杀残留 emulator/qemu 进程。

---

## 5. 待确认问题（需主理人裁决）

1. **控制台鉴权**：`ui/config` 打开的页面虽经应用中心入口，但端口直连是裸的。是否在 P0 就要求最少鉴权（固定 token / 简单密码），还是按「仅内网可信」先不做？
2. **运行时交付形态**：默认发布「在线包」（fpk 内不含 emulator + 系统镜像，首次启动联网下载约 1.1–1.5 GB），还是「离线完整包」（fpk 约 1.5 GB 以上）？影响 P0-3 验收基准与 P1-8 优先级。
3. **模拟器实例模型**：默认「单实例共享一台模拟器跑多应用」（省内存，符合 15 GiB NAS），还是「每应用一个 AVD」（隔离好、内存吃不消）？请在 P0 定基线，另一个进 P1-2。
4. **`/dev/kvm` 权限**：package 用户是否已在 `kvm` 组？若不在，`config/privilege` 的 `join-groups` 能否加 `kvm`（或需要 `install_init` 以 root 处理）——这决定 P0-3 的失败提示与 P0-10 脚本形态，需要目标机实测结论。
5. **fnDepot 源仓库与署名**：技术侧已由实测收敛——**不需要专门的 `FnDepot` 仓库**，用 `TaroCats/apkstart` 本身做源仓库即可（根目录放 `fnpack.json`，fpk 作为 GitHub Release 资产，不进仓库）。仍需你裁决的是两件非技术事项：① 发布所需 GitHub PAT（或 GHA 内置 token）由哪个账号持有、是否有写 Release 的权限；② `manifest.maintainer` 与 `source_info.author` 如何署名（保留上游 RoutineMiku 并注明 fork，还是改为本项目维护者）。若你认为这两项超出团队决策范围，请转给用户确认。
