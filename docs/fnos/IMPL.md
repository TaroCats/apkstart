# ApkStart fnOS 移植 — 实现说明（P0）

> 实现者：寇豆码（Engineer）· 团队 `software-apkstart-fnos`
> 依据：`docs/fnos/ARCH.md`（v1.1，§10 优先）、`docs/fnos/PRD.md`、`docs/fnos/decisions.md`、`docs/fnos/fnos-runtime-patterns.md`
> 交付形态：fnOS fpk（`tar.gz` 改名）+ Node.js 单进程 HTTP 服务 + 纯静态 Web 控制台
> 运行时依赖：**零第三方 npm 包**（仅 Node 内置 `http/https/fs/path/os/child_process/crypto/zlib/stream/url`）

---

## 1. 已实现清单（对照 ARCH §2）

### 1.1 复用解析层 `core/`（7 个文件）

| 文件 | 处置 | 说明 |
|---|---|---|
| `core/zip.js` | R 原样 | 零依赖 ZIP 中央目录读取 |
| `core/axml.js` | R 原样 | 二进制 AndroidManifest 解析 |
| `core/arsc.js` | R 原样 | `resources.arsc` 资源表解析 |
| `core/apk.js` | R 原样 | `parseApk` / `quickCheck` 汇总 |
| `core/png.js` | R 原样 | `encodePng` / `drawAppIcon(size)` |
| `core/adb.js` | R\* **仅两处改动** | ① `resolveAdb(explicit, appRoot)` 候选改为 `[explicit, appRoot/runtime/platform-tools/adb, '/usr/local/bin/adb', 'adb']`，删除全部 `adb.exe`；② `require('./pointer')` → `require('./inputguard')`。其余逻辑未动。 |
| `core/inputguard.js` | **N** | 从上游 `pointer.js` 抽出 `isInputCommand(cmd)` 白名单（`input tap/swipe/text/keyevent`），供 `adb.input()` 做命令注入防护。 |

### 1.2 后端 `server/`（19 个文件）

| 文件 | 职责 |
|---|---|
| `server/index.js` | 进程入口：`buildContext()` 组装单例 → `buildRouter()` 注册 22 条路由 → `listen(port)`（或 `LISTEN_SOCKET`）→ SIGTERM/SIGINT 优雅退出 |
| `server/config.js` | `TRIM_*` → `PATHS`；`DEFAULT_SETTINGS`；`PROVISION_MANIFEST`；`SYSTEM_IMAGE`；`deepMerge` |
| `server/service/paths.js` | `buildPaths(env)`：`TRIM_PKGVAR`（数据根，权威）→ `TRIM_APPDATA` → `$HOME/.apkstart`；`ensureDirs` |
| `server/http/router.js` | `:param` 参数化路由（先转义元字符再替换占位，避免正则注入） |
| `server/http/server.js` | 静态资源（SPA 回落 + 目录穿越防护）、`sendJson/sendError/sendPng`、2MB JSON body、500MB 单文件 multipart 落盘 |
| `server/api/health.js` | `GET /api/health`、`GET /api/status` |
| `server/api/settings.js` | `GET/PUT /api/settings`（深合并） |
| `server/api/runtime.js` | `GET /api/runtime/status`、`POST /api/runtime/deploy`、`GET /api/runtime/deploy/progress` |
| `server/api/emulator.js` | `POST /api/emulator/start|stop`、`GET /api/emulator/logs` |
| `server/api/apk.js` | `POST /api/apk/parse`；`.apks/.xapk` → `UNSUPPORTED`；上传暂存 30min TTL + 定期清扫 |
| `server/api/apps.js` | 应用列表 / 安装 / 启动 / 停止 / 卸载 |
| `server/api/screen.js` | 帧、`wm size`、`tap/swipe/text/key`，文本注入白名单转义 |
| `server/service/store.js` | `apps.json` / `settings.json` 原子读写、图标落盘与 `data:` URI |
| `server/service/kvm.js` | `checkKvmAccess('/dev/kvm')` → `{available, writable, group}` |
| `server/service/provision.js` | 三组件下载（Range 续传 + sha256/尺寸校验 + 安全解压）、`status()/progress()/deploy()` |
| `server/service/emulator.js` | 手写 AVD、`buildArgs`、spawn + `boot_completed` 等待（180s）、`_postBootHardening()` 开机后加固（禁蓝牙，见偏差 9）、`stop()`、`/proc/<pid>/status` RSS、环形日志 |
| `server/service/engine.js` | `ensureAdb()`、10s 健康巡检（连续 3 次截屏失败 → `emulator.state='error'`）、`StatusVO` 聚合（前台包来自 `foreground.js`） |
| `server/service/foreground.js` | **新增**：按优先级解析 `topResumedActivity` / `ResumedActivity` / `mResumedActivity` / `mCurrentFocus` / `mFocusedApp` 五字段得真实前台包名，`isSystemSurface()` 识别弹窗/桌面，`waitForPackage()` 轮询等待 resume（偏差 9 / 9b） |
| `server/service/installer.js` | `install → resolveLauncher → 保存图标 → am start → 写 store`；arm64-only 显式 `UNSUPPORTED` |

### 1.3 Web 控制台 `ui/`（7 个文件）

`index.html`（深色 NAS 面板：顶栏/连接指示/KVM 警告条/三栏/日志抽屉/toast）、`style.css`、`app.js`（2s 状态轮询、部署进度、拖拽上传、画面开关）、`api.js`（统一 `{code,message}` 错误）、`screen.js`（`<img>` 帧轮询 + 坐标换算 + 点击/滑动）、`images/icon_64.png`、`images/icon_256.png`。

### 1.4 fpk 骨架 `fnos/`

`manifest.in`、`ICON.PNG`(64)、`ICON_256.PNG`(256)、`cmd/` **9 个**生命周期脚本（`main`、`install_init`、`install_callback`、`uninstall_init`、`uninstall_callback`、`upgrade_init`、`upgrade_callback`、`config_init`、`config_callback`，**全部 0755**）、`config/privilege`、`config/resource`、`wizard/install`、`wizard/uninstall`。

manifest 最终字段（与目标机 6 个真实包逐字段对齐，见 §2 偏差 3）：

```
appname=apkstart-fnos
version=@VERSION@
display_name=ApkStart
desc=...
changelog=...
platform=x86
source=thirdparty
maintainer / maintainer_url / distributor / distributor_url
desktop_uidir=ui
desktop_applaunchname=apkstart-fnos.main
ctl_stop=true
checksum=@CHECKSUM@
checkport=false
disable_authorization_path=true
```

### 1.5 构建与 CI

`build/pack.sh`（图标 → stage → **wizard 契约校验** → ui/config → 版本注入 → **应用负载打成根级 `app.tgz`** → manifest → tar.gz→fpk → **包结构校验** → sha256 → fnpack 片段）、`build/gen-icons.js`、`build/gen-manifest.js`、`build/gen-fnpack.js`、`build/validate-wizard.js`、`build/validate-package.js`、`.github/workflows/release.yml`。
> `validate-wizard.js` 是 0.2.0「App Center 装不上」事故的护栏（IMPL 偏差 13）：校验的是 **stage 里那份**（真正进包的那份），顶层不是数组就不许打包；同一份逻辑被 `test/fnos-unit.js` 复用，所以 Linux CI job 会红在 PR 上。
> `validate-package.js` 是 0.2.1「10107 找不到 app.tgz」事故的护栏（IMPL 偏差 14）：校验的是**建好的 .fpk 产物**，不是源码——因为这个 bug 的形态恰好是「本地构建全绿、真机装到一半才炸」，只看源码拦不住。它解出 fpk 与内层 `app.tgz` 的条目，断言根级有 `app.tgz`、根目录没有 `app/`、`app.tgz` 顶层是 `server/ core/ ui/`，并把 0.2.1 的真实日志形态做成了回归用例。
> `build/` 下仍保留上游 Electron 版遗留脚本（`pack.js`、`prepare-runtime.js`、`render-logo.js` 等），**不参与** fnOS 打包链路，未删除以免破坏上游仓库。旧 Windows/Electron 发布流水线文本存档于 `docs/fnos/legacy-release-electron.yml.txt`。

---

## 2. 与 ARCH 的偏差（全部为真机实测推翻原设计，均已落地）

### 偏差 1 — 系统镜像由 `google_apis_playstore` 改为 `google_apis`（推翻 ARCH §9-A2 原定值）

**原设计**：使用 `google_apis_playstore`（Play）镜像，理由是其内置 native bridge / ARM 翻译层，可跑 arm64-only 应用。

**真机实测结论（目标机 fnOS + QEMU/KVM，`-no-window` 无头）**：
- Play 镜像无头启动后，adb 首次授权弹窗无窗口可点 → `adb devices` **永久 `unauthorized`**，整个安装/启动链路不可用。
- 试图用 `-prop ro.adb.secure=0` 绕过授权 → emulator **直接段错误崩溃**（复现两次）。
- 改 `google_apis`（x86_64, API 34, r14）后：adb 直接授权（`ro.adb.secure=0`），`sys.boot_completed=1` 于 **65s** 达成，`wm size` = `1080x1920`。
- 全链路 E2E 通过：`install -r -g` Success → `resolve-activity` → `am start -W` COLD 7638ms → `screencap` 42269 B 合法 PNG → `input tap` rc=0。

**落地改动**：
| 位置 | 原值 | 现值 |
|---|---|---|
| `server/config.js` `SYSTEM_IMAGE.tag` | `google_apis_playstore` | **`google_apis`** |
| `server/config.js` `DEFAULT_SETTINGS.emulator.imageTag` | `google_apis_playstore` | **`google_apis`** |
| `server/config.js` `PROVISION_MANIFEST['system-image'].relPath` | `sys-img/google_apis_playstore/x86_64-34_r14.zip` | **`sys-img/google_apis/x86_64-34_r14.zip`** |
| `server/config.js` `SYSTEM_IMAGE` 注释 | 「带 ARM 翻译层，可跑 arm64-only 应用」 | **已删除，改写为「google_apis 不含 ARM 翻译层」及 Play 镜像无头不可用的原因说明** |
| `server/service/emulator.js` AVD `config.ini` | `tag.display=Google Play` | **`tag.display=Google APIs` + `PlayStore.enabled=no`** |
| `fnos/cmd/install_init` 默认 `settings.json` | `imageTag: google_apis_playstore` | **`google_apis`** |
| `server/service/emulator.js` `ensureAvd()` | 已有 AVD 仅重写 config | **检测 `tag.id` 与目标镜像不一致时自动 `wipe` 重建**（避免旧 userdata 与新系统镜像不兼容导致 boot 失败） |

派生路径自动跟随（无需硬编码，已实测）：
`SYSTEM_IMAGE_DIR` = `system-images/android-34/google_apis/x86_64`；
`extractDir` = `system-images/android-34/google_apis`（zip 顶层为 `x86_64/`，解压后得到标准布局）；
`marker` = `system-images/android-34/google_apis/x86_64/system.img`。
下载地址实测 HTTP 200，`Content-Length` = **1563721130 B**（与给定 sha256 记录一致）。

### 偏差 2 — arm64-only 应用改为显式 `UNSUPPORTED`（不再尝试兼容镜像）

由于 `google_apis` **不含** ARM 翻译层（`libndk_translation` / `libhoudini` 均无），arm64-only 应用在该镜像下必然无法运行。原设计中「Play 镜像 ARM 翻译层兜底」的前提已不成立。

**落地改动**（`server/service/installer.js`）：
- 新增常量 `ARM_ONLY_MESSAGE = '当前运行时镜像不含 ARM 翻译层，暂不支持 arm64-only 应用（P1 将支持可切换镜像）'`。
- `install()` 在 **调用 `adb.install` 之前**用 `isArmOnly(parsed.abis)` 预判，命中则清理上传暂存并抛 `UNSUPPORTED`（**无静默失败，不下载任何兼容镜像**）。
- 保留 `NO_MATCHING_ABIS` 兜底映射到同一 `UNSUPPORTED` 文案（针对清单未声明 ABI 但设备仍拒绝的场景）。
- UI 侧：`ui/app.js` 的 APK 预览对 `armOnly` 显示同等中文警告，并置灰「安装到模拟器」按钮。
- `server/api/apk.js` 仍返回 `armOnly` 字段供前端判断。

### 偏差 3 — manifest 字段与 `cmd/` 生命周期脚本对齐真实包惯例（推翻 ARCH §2.4 / §7.3 原稿）

**证据**：在目标机 `/var/apps/*/manifest` 实读 6 个已装真实包（fndepot、wechat-on-cloud、fygo-browser、huitai、lemon-music、dpanel、fn-scheduler）逐字段比对。

| 项 | ARCH 原稿 | 真实包事实 | 现取值 |
|---|---|---|---|
| `platform` | `x86_64` | 6/6 只有 `all` / `x86`，**无任何包用 `x86_64`**（目标机 `uname -m=x86_64` 是内核架构，不是 manifest 词表） | **`x86`** |
| `os_min_version` | `1.2.0` | 取值形态为 `1.1.3100` / `1.2.0401` / `0.9.27` 这类平台构建号，`1.2.0` 与之不同构可能被判「不满足」；fn-scheduler 干脆不写（可选） | **删除该字段** |
| `depend` | `depend=nodejs` | 6/6 均无 `depend`；fnOS 的 Node 包名是 `nodejs_v22` 而非 `nodejs`，写错包名会在依赖解析阶段直接装不上 | **删除该字段**（`cmd/main` 的 `resolve_node()` 已能自行定位 `/usr/local/bin/node` 与 `/var/apps/nodejs*/target/bin/node`；找不到时给中文错误，不影响「装得上」） |
| `checkport` | 无 | 真实包普遍写 | **`false`**（端口冲突由服务自身处理） |
| `disable_authorization_path` | 无 | 真实包普遍写 | **`true`**（服务监听 `0.0.0.0:8890` 且 P0 无鉴权，见决策 Q1；否则 fnOS 网关可能给 8890 加登录跳转，Web 控制台行为不可预期） |
| `micro_app` | — | 仅 fndepot 这类内嵌型应用使用 | **不加** |

**`cmd/` 生命周期脚本补齐**：真实包 `cmd/` 为 `common main install_init install_callback uninstall_init uninstall_callback upgrade_init upgrade_callback config_init config_callback`。原实现缺 4 个，已补齐（全部 0755）：

- `upgrade_init`：服务在跑则 `cmd/main stop`（含 `adb emu kill` + 模拟器残留清理）→ 备份 `settings.json` 为 `settings.json.bak` → 清残留 `service.pid`、`uploads/`、`downloads/*.part`、`*.tmp`；**不动 `runtime/` 与 `runtime/.deployed`**（约 1.9GB，重下代价过高，且丢标记会被判为未部署而重下）。
- `upgrade_callback`：调 `cmd/main start`（复用 20s `/api/health` 健康轮询）；成功 → 删 bak 并 `exit 0`；失败 → 还原 `settings.json.bak` 后重试一次，仍失败则 `exit 1`（让升级流程报错，而非留「装好起不来」的静默故障）。
- `config_init` / `config_callback`：P0 无平台配置项（全部参数由自带 Web 控制台的 `/api/settings` 管理），实现为**幂等空操作 + `exit 0`**，文件头注释写明「P0 无平台配置项，保留脚本以满足生命周期契约，P1 接入平台配置时在此实现」。

> 说明：真实包还有 `cmd/common`（多脚本共享函数库）。我们的 9 个脚本各自独立、无共享逻辑需求，故未引入 `common`；若后续脚本出现重复逻辑再抽取。

### 偏差 4 — 健康检查必须校验「身份」，只看 200 会造成假成功（真机 P0 缺陷）

**事故**：目标机 8890 被一个无关的 `uvicorn`（pid 1268089）占用，它的 `/api/health` 同样返回 200。于是 `cmd/main start` 判为启动成功并 `exit 0`、`status` 也 `exit 0`，但我们的进程其实早已死在 `listen EADDRINUSE`。

**根因**：旧实现只判断「HTTP 200」，无法区分「自己的服务」与「别人的服务」。

**修复（4 处）**：

1. `server/api/health.js` 返回可识别身份：`{ app:'apkstart-fnos', status:'ok', version, pid: process.pid, uptimeSec, node }`。
2. `server/index.js`：`server.on('error')` 移到 `listen()` **之前**注册；`EADDRINUSE` 打印中文可执行建议「端口 N 已被占用，请在 Web 控制台的设置里改用其他端口，或释放该端口后重启 ApkStart。」（socket 模式为 socket 变体），其它错误打印 `code + message`；同时写日志与 `TRIM_TEMP_LOGFILE`，并**必定 `process.exit(1)`**（绝不带病常驻，避免被误判为启动成功）。
3. `fnos/cmd/main` 的 `health_ok()` 解析响应体（64KB 上限），要求 `statusCode===200` **且** `body.app==='apkstart-fnos'` **且** `body.pid === $(read_pid)`（同时防上一次残留实例被误认）。任一不满足 → 返回 1。
4. `do_start()` 轮询循环里，若进程在健康检查通过前就退出 → 立即判失败并 `tail -n 20` 回显日志尾部到 stderr（第一屏就能看到真正的失败原因），`return 1`；不再继续空等 20s，也不再打印误导性的「超时」文案。

### 偏差 5 — GPU 加速：默认 `auto`（有「硬件 3D 的 X server」就开，没有就回落 `off`）；软件 CPU 模拟仍不可用

> **本节结论经两轮更正。** 初版「包用户拿不到 renderD128，所以必然 `-gpu off`」是错的（权限已通过 `join-groups: render,video` 解决，且根因其实是宿主缺一个带硬件 3D 的 X display）。第二轮把 ~3s 收益做成了可选能力：**默认 `gpu: 'auto'`**，检测到支持 `-hw3d` 的 X server 且 `renderD128` 可读写就上 `-gpu host`，否则安静回落 `off`（与旧版行为一致）。完整实测矩阵、实施方案与两个真机坑见下方「偏差 5 更正」与「偏差 5 改造方案（已实施）」。

**真机证据（初版）**：

- `/dev/dri/renderD128` 权限是 `root:render 0660`，出厂态包用户 `apkstart-fnos` 不在 `render` 组。
- 用 `-gpu swiftshader_indirect` 时 QEMU 直接 `main loop exits abnormally with code 1` 退出（模拟器活不过几秒）。
- 改 `-gpu off` 后，同一包用户、同一 AVD、同一参数：`Boot completed in 33272 ms`（另一次 31794 ms），稳定可开机。

**落地**：`DEFAULT_SETTINGS.emulator.gpu = 'off'`；`ensureAvd()` 写入的 `config.ini` 也同步为 `hw.gpu.enabled=no` / `hw.gpu.mode=off`（此前写死 `swiftshader_indirect`，与命令行自相矛盾）。设置项仍允许用户改回；另加运行期兜底 `_effectiveGpu()`：配置为 `swiftshader_indirect` 但 `/dev/dri/renderD128` 不可读写时自动降级为 `off` 并写日志，避免旧 `settings.json` 里残留的旧默认值把启动卡死。

#### 偏差 5 更正 — 真正的门槛是「硬件 3D 的 X display」，不是 render 组

早先把 `QEMU main loop exits abnormally with code 1` 归因为「包用户拿不到 render node」，这个归因**不成立**。逐项排除后得到完整矩阵（目标机 10.31.0.4，Android 34 google_apis x86_64，`-accel on`）：

| # | 身份 | DISPLAY | 附加条件 | 结果 |
|---|---|---|---|---|
| 1 | package | 无 | 默认无 `render` 组 | `-gpu host` / `swiftshader_indirect` 均 2s 内 `QEMU main loop exits abnormally with code 1` |
| 2 | package | `:99`（宿主 `Xvnc`，TigerVNC，**不支持 `-hw3d`**） | 在 `render` 组 | GL 起来但是 llvmpipe 软件光栅，`Boot 29553 ms`，无收益 |
| 3 | **package** | **`:9`（`Xkasmvnc -hw3d -drinode /dev/dri/renderD128`）** | 在 `render`+`video` 组 | **`Graphics Adapter … (Mesa Intel(R) Graphics (ADL-N))`，`bootMs` 27604 / 27652 / 27680 / 28621**，qemu 进程持有 6 个 `renderD128` fd |
| 4 | root | `:1` / `:9`（同为 `Xkasmvnc -hw3d`） | — | 同 3（`Boot 21785 ms` 一次），证明与身份无关 |
| 5 | package | 无 `DISPLAY`，`EGL_PLATFORM=surfaceless` | 在 `render` 组 | `Failed to get EGL display` / `Failed to initialize GL emulation` —— **headless 无 X 的路径走不通** |

**三条硬结论**：

1. **不是占用问题，也不是单纯的 render 组权限**。DRM render node 天然多客户端共享（`fuser` 无独占，`Xvnc` 与 qemu 可同时持有 `renderD128`）；包用户进 `render` 组后设备可正常 `open`。
2. **必须有「带硬件 3D 的 X display」**：emugl 只在有 X 时走 EGL_X11；`surfaceless` 无 X 直接失败。而宿主 `/usr/bin/Xvnc`（TigerVNC 1.12）与 `/usr/bin/Xvfb` **都不支持 `-hw3d`**，整个系统里唯一支持的是 KasmVNC 的 `Xkasmvnc`（5.5MB），且目标机上它只存在于别的应用的 mount namespace 里（`/proc/<pid>/root/usr/bin/Xkasmvnc`）。其 40 个动态依赖在宿主 `/lib/x86_64-linux-gnu/` **全部存在**（缺失 0），libc 同版本，可直接搬运。
3. **`Xkasmvnc` 必须显式 `-interface 127.0.0.1`**，否则启动即 `vncExtInit: failed to bind socket, is someone else on our -websocketPort?: Address already in use (98)`（该报错与 rfbport 无关，端口本身是空的；照同机 `fygo-browser` 的可用命令行补 `-interface` 即成功）。

**收益（走应用自己的 Node → spawn 路径实测，非手工命令行）**：

| gpu | 采样（bootMs） | 中位数 | renderD128 fd | 客户机适配器 |
|---|---|---|---|---|
| `off` | 31267 / 30908 / 30960 | **30960** | 0 | ANGLE (Google, Vulkan 1.2.0 SwiftShader) |
| `host` | 28621 / 27680 / 27652 / 27604 | **27666** | 6 | **Mesa Intel(R) Graphics (ADL-N)** |

即 **约 -3.3s（-10.6%）**。早期「root 22s vs off 34s」的 12s 差值含大量噪声与冷启动差异，可复现的净收益只有 ~3s——开机时间主要花在 Android framework/zygote，不在 GL 初始化。

**方法论教训（花了最多时间的一条）**：用 `setsid … &` 把模拟器丢后台后再测，包用户下**必崩**；同一条命令前台跑 / 由 Node `spawn()` 拉起则**正常**。初版结论「包用户下 `-gpu host` 必崩」是这个测试形态造成的假象。**结论：验收必须走产品真实启动路径（服务 → spawn），手工命令行只能用于单点排查。**

> **补充（0.2.4，见偏差 16.3）**：上面「有 X + render node 就能 host」还差一条**运行期**前提——emulator 子进程的 cwd 必须对包用户可读。cwd 继承成 `/root`（0700）时，同样的 X、同样的 render node、同样的 QEMU 参数，host 依然 2s 静默失败（只有一句 `QEMU main loop exits abnormally`），而 `-gpu off` 正常。所以上表第 3 行的成立条件里，还应加上「cwd 可读」（现在由 `_spawnCwd()` 强制指定，不再依赖继承）。

**是否随包自带 X server**：结论是**不自带，只探测**。两个硬理由：① `Xkasmvnc` 是 KasmVNC 1.4.0 / **GPL-2.0**（强 copyleft），随 MIT 包分发需附源码或书面要约；② 它 `ldd` 依赖 `libxfont2`/`libpixman-1-0`/`libunwind8`/`libwebp7`/`libxshmfence1` 等独立 deb，干净 fnOS 未必齐备。改为由运维把二进制投放到 `$TRIM_PKGVAR/runtime/xserver/`（升级不丢），包体积零增量。默认 `gpu: 'auto'`：投放了就自动吃到 ~2.9s 收益，没投放就回落 `off`。详见「偏差 5 改造方案（已实施）」。

**附带结论（不改进代码，仅记录）**：此版本 emulator **拒绝 `-accel off`**，需 `ANDROID_I_WANT_MY_TCG=yes` 才允许纯软件 CPU 模拟。因此本移植版**强依赖 `/dev/kvm` 可读写**（即包用户属于 `kvm` 组，且安装时 `all.editor` 权限授予到位）。无 KVM 时 `-accel off` 会立即失败，前端 `kvm.writable=false` 的红条警告依旧有效。

#### 偏差 5 改造方案（已实施，v0.2 起默认 `gpu: 'auto'`）

把 ~3s 的 GPU 收益做成了**可选能力**：默认 `auto`（能自动检测就开），检测不到就静默回落 `off`，行为与旧版一致。

**实测收益（10.31.0.4，同一 AVD、冷启动、交替 4 组配对）**：

| 组 | `-gpu off` bootMs | `-gpu host` bootMs | 差值 |
|----|------------------|--------------------|------|
| 1 | 24744 | 21453 | −3291 |
| 2 | 22872 | 20575 | −2297 |
| 3 | 23835 | 20505 | −3330 |
| 4 | 23851 | 21503 | −2348 |

中位数 off `23843ms` → host `20979ms`，**−2864ms（−12.0%）**；均值 −11.8%。qemu 稳定持有 6 个 `renderD128` fd，适配器 `Mesa Intel(R) Graphics (ADL-N)`，`OpenGL ES 3.0 (4.6 Core Profile Mesa 26.1.6)`，日志 `Ok: Hardware GPU requirements ... are passed`。

**落地形态与最初设想的 4 处偏差**：

1. **不自带二进制（原方案第 1 步推翻）**。`Xkasmvnc` 是 **KasmVNC 1.4.0 / GPL-2.0**（强 copyleft），随 MIT 包分发需附源码或书面要约；且 `ldd` 显示依赖 `libxfont2` / `libpixman-1-0` / `libunwind8` / `libwebp7` / `libxshmfence1` 等独立 deb 包，干净 fnOS 未必齐备。**改为只探测、不携带**：二进制由运维投放到 `$TRIM_PKGVAR/runtime/xserver/Xkasmvnc`（升级不丢），`locate()` 按 `settings.xserverPath` → `APKSTART_XSERVER` → 数据根 → 代码根 → `PATH` 依次尝试，非显式来源必须是真支持 `-hw3d` 的二进制（`-help` 输出同时含 `-hw3d` 与 `-drinode`）。包体积**零增量**。
2. **不在 `cmd/main` 里起 X server（原方案第 2 步调整）**。改由 `server/service/xserver.js` 在 `start()` 内部按需拉起、`stop()` 收尾时 `SIGTERM`+`SIGKILL`，且**只在真要开 GPU 时才起**——`daemon` 常驻一个没人用的 X server 是纯浪费。
3. **权限**：`fnos/config/privilege` 的 `join-groups` 由 `["all.editor"]` 改为 `["all.editor","render","video"]`（`render` 供 `renderD128`，`video` 供 `card0`）。目标机实测用户组变为 `920,44(video),105(render),992`。
4. **降级逻辑补齐（原方案第 5 步）**：新增 `server/service/gpu.js` 做纯函数裁决，`NEEDS_DISPLAY` 覆盖 `host/angle_indirect/guest/mesa/swiftshader_indirect/swiftshader`——**旧 `_effectiveGpu()` 只校验 `renderD128`、不校验 `DISPLAY`** 的缺陷已修。另外补了「开了还起不来」的兜底：`-gpu <非 off>` 启动失败时 `stop()` + `xserver.stop()` 后用 `-gpu off` 重试一次，`gpu.reason` 记 `fallback-after-failure`。

**真机又踩出来的两个坑（原方案里完全没预料到，也是最花时间的部分）**：

- **坑 1：该二进制硬编码相对路径 `.xkbbin/xkbcomp`。** 它是被补丁过的 KasmVNC，键盘编译器从**相对路径**解析，不看 `PATH`——宿主 `/usr/bin/xkbcomp` 明明存在也没用，`-xkbdir` 也救不了：
  ```
  sh: 1: .xkbbin/xkbcomp: not found
  XKB: Failed to compile keymap
  (EE) Fatal server error: Failed to activate virtual core keyboard: 2
  ```
  表现是「X 起来 1 秒就死」，然后 qemu 报 `Failed to open display 0 / Failed to get EGL display`。
  我们只投放裸二进制（vendor 的 `.xkbbin/` 私有目录不适合分发），所以 `ensureXkbRoot()` 在 `$TRIM_PKGTMP/xkbroot/.xkbbin/xkbcomp` 造一个指向宿主真实 `xkbcomp` 的**软链**，并把 cwd 设到 `xkbroot`。实测有此软链时 X server 稳定存活。若二进制自带 `.xkbbin/`，`pickXkbBinCwd()` 优先用它的打包根。
- **坑 2：X 被信号杀掉会遗留 `/tmp/.XN-lock` + socket。** 一次异常退出后，后续**所有**启动都报
  `Fatal server error: Cannot establish any listening sockets - Make sure an X server isn't already running`，
  四个槽位（:9/:10/:11/:12）全部失败 → `auto` 永久退化成 `off`（第一轮 A/B 就是这样测出 `MODE=auto gpu=off` 的假数据）。
  `cleanStaleDisplay()` 按「lock 里的 pid 是否活着 **且** 命令行像不像 X server」判定：真占用 → 换槽位；否则删 lock+socket。`stop()` 收尾也会清自己那个 display。

**正确性细节（均为真机验证过的必要条件）**：

- 命令行**必须**带 `-interface 127.0.0.1`，否则 `vncExtInit: failed to bind socket ... Address already in use (98)`（卡的是 **websocketPort**，简写日志把前半句截掉了，极易误判成 display 编号冲突）。
- `-SecurityTypes None` 只在绑定回环时使用，避免把无鉴权 VNC 暴露到局域网。
- **就绪判定必须带存活复核**：socket 出现过 ≠ 就绪（XKB fatal 就是「起来后立刻死」）。实现为「`vncext: Listening` 出现 → `sleep(600)` → 复核 `!exited && isReady()`」，且 `isReady()` 额外校验 `child.exitCode === null`；`parseFatalError()` 让 fatal 立刻失败而不是傻等满 10s。
- 观测接口：`GET /api/status` 新增 `gpu: {mode, want, reason, message}` 与 `xserver: {available, bin, source, hw3d, display, running}`，让「我配了 host 为什么是 off」在接口里可解释；启动日志也保留 `[gpu]` / `[xserver]` 决策行（含「配置的 xserverPath 不可用，已改用 …」告警）。

**降级实测（10.31.0.4）**：

| 场景 | 结果 |
|------|------|
| `xserverPath` 指向不存在的文件 | 自动回退到数据根二进制，`reason=auto-host`，日志有「配置的 xserverPath 不可用」告警，正常 `-gpu host` |
| `xserverPath=/bin/true`（不支持 `-hw3d`） | `available=false`、`reason=no-xserver`、`mode=off`，模拟器正常启动（bootMs 25018） |
| `-gpu host` 已开但启动失败 | 自动 `-gpu off` 重试成功，`reason=fallback-after-failure`（bootMs 31862） |
| 无 `renderD128` 权限 / 无 X server | 直接 `off`，不再有 2 秒静默崩溃 |

**运维须知**：想开 GPU 只需把 `Xkasmvnc`（+x）放到 `$TRIM_PKGVAR/runtime/xserver/`（默认 `/vol2/@appdata/apkstart-fnos/runtime/xserver/`）；不投放则 `auto` 安静地回落 `off`，功能不受影响。`gpu: 'off'` 可显式关闭，`gpuAutoEnable: false` 可保留 `auto` 语义但禁止自动开启。

### 偏差 6 — 专用 adb server 端口 5044 + device serial 必须是 `emulator-5554`

**真机证据（同一 AVD、同一参数，以包用户手工执行）**：

```
adb connect 127.0.0.1:5554              → failed to connect: Connection refused
adb -s 127.0.0.1:5554 get-state         → error: device '127.0.0.1:5554' not found
adb devices（不带 ANDROID_ADB_SERVER_PORT）→ 空（模拟器注册到了宿主 5037 上 root 遗留的 adb server）
ANDROID_ADB_SERVER_PORT=5044 adb devices → emulator-5566  device
ANDROID_ADB_SERVER_PORT=5044 adb -s emulator-5554 get-state → device
getprop sys.boot_completed              → 1
```

**两个根因**：

1. **serial 写错**：`5554` 是 emulator 的 **console** 端口，adb 端口是 `5555`，而模拟器向 adb server 注册的设备名是 `emulator-<consolePort>` = `emulator-5554`。所以 `127.0.0.1:5554` 永远 `not found`。
2. **spawn 环境漏传 adb server 端口**：`core/adb.js` 客户端固定用 `ANDROID_ADB_SERVER_PORT || '5044'`，但 `emulator.js` 的 `_spawnEnv()` 没传该变量 → 模拟器去注册到默认 `5037`（目标机上被别的进程占着），两端不在同一个 adb server 上，永远看不到设备。

**落地**：

- `emulator.js`：`serial = \`emulator-${EMULATOR_PORT}\``；`_spawnEnv()` 增加 `ANDROID_ADB_SERVER_PORT: process.env.ANDROID_ADB_SERVER_PORT || '5044'`，**取值与 `core/adb.js` 的 `_adbEnv()` 完全一致**（已实测两端同值 5044）。
- `fnos/cmd/main` 的 `do_stop()`：`adb -s "emulator-5554" emu kill`（原写 `127.0.0.1:5554`）。
- 用 5044 而非默认 5037，是为了避开宿主上已有的 adb server（root 遗留 / 其他模拟器），否则本服务的设备注册会被反复踢掉。

### 偏差 7 — 模拟器进程提前退出时 `_waitBoot` 必须立即失败（不再空转 180s）

**真机证据**：`POST /api/emulator/start` 180s 后报「可能硬件加速不可用导致过慢」，而模拟器自己的日志写着 `Boot completed in 33272 ms` —— 即**已经开机成功**，是服务侧 adb 探测一直连不上（偏差 6），等到超时又把自启的模拟器 `SIGKILL` 了。

**根因**：`_waitBoot()` 的提前失败判断是 `if (this._child === null && this.state === 'error')`，但 `child.on('exit')` 在 `starting` 状态下把 `state` 置为 `'stopped'`，条件永不成立。

**落地**：

- 提前失败判断改为只看进程：`if (!this._child) throw new Error(this.error || '模拟器进程已退出');`
- 超时文案改为可诊断，先抓一次现场再抛：
  `模拟器启动超时（180s 内未完成开机）。进程存活=yes/no；adb devices: <原始输出或 "(获取失败)">；请检查 <数据根> 下的 emulator 日志`
  （不再把原因一概归为「硬件加速不可用」—— 那正是这次误导排查的元凶）

### 偏差 8 — `fnpack.json` 字段按 FnDepot 1.0.8 真实源校正（推翻 ARCH §7.7 原稿）

> 编号顺延为 8（偏差 5/6/7 已被模拟器三条占用）。

**证据来源**：目标机 `/vol2/@appdata/fndepot/fndepot.db` 的 `sources` 表，3 个真实外部源（均 `schema_version=2`）——`TaroCats/FN-AppHub`、`TaroCats/huitai`、`jia070310/lemon-muisc`——其 `fnpack.json` 原文逐字段比对。

| 项 | ARCH §7.7 原稿 / 旧实现 | 真实源事实 | 现取值 |
|---|---|---|---|
| `platform` | `["x86_64"]` | 词表只有 `x86` / `arm`：FN-AppHub `["x86"]`，huitai / lemon-music `["x86","arm"]` | **`["x86"]`** |
| `releases.<ver>.packages` 的 key | `x86_64` | **也是 `x86` / `arm`**（huitai：`packages.x86` / `packages.arm`，文件名 `huitai_2.1.1_x86.fpk`） | **`x86`** |
| `service_port` | 数字 `8890` | 三个源全是**字符串**：`"9080"` / `"7401"` / `"7983"` | **`"8890"`** |
| `install_type` | `"online"` | 三个源都是**空字符串** | **`""`** |
| `os_min_version` | 无 | 常见但可选（huitai `0.9.27`、apphub `1.1.3100`），取值是平台构建号 | **不写**（无可信值，不瞎填） |
| `download_url` | `raw.githubusercontent.com/TaroCats/FnDepot/main/...`（仓库内目录） | huitai 直接用 GitHub **Release 资产**：`https://github.com/TaroCats/huitai/releases/download/v2.1.1/huitai_2.1.1_x86.fpk` | **`https://github.com/TaroCats/apkstart/releases/download/v<ver>/apkstart-fnos_<ver>_x86.fpk`** |
| `icon_url` / `readme_url` | 指向 `FnDepot` 仓库 | 两种都行：`raw.githubusercontent.com` 绝对地址（huitai）或相对路径 `./icon.png`（lemon-music） | **`raw.githubusercontent.com/TaroCats/apkstart/main/{fnos/ICON_256.PNG, README.md}`**（仓库内真实存在的路径） |

**两条认知修正（原文写入文档，避免后续再走弯路）**：

- **A. 源仓库不必叫 `FnDepot`。** 真实外部源就是普通仓库（`TaroCats/FN-AppHub`、`TaroCats/huitai`），只要**仓库根目录有 `fnpack.json`**，就能被 FnDepot「添加外部源」。此前「仓库必须叫 FnDepot」的说法是错的。
- **B. 产物不必放进仓库的 arch 目录，用 GitHub Release 资产更好。** 我们的 release workflow 已 attach `dist/*.fpk` + `*.sha256`，`download_url` 直接指过去即可，`fnpack.json` 里不需要也不应该再维护一份 fpk 副本。

**产物命名同步调整**：`build/pack.sh` 的 `<appname>_<version>_x86_64.fpk` → **`_x86.fpk`**（fnOS 官方包的 arch 段就是 `x86`/`arm`，与 manifest `platform=x86` 对齐）。`gen-fnpack.js` 自动查找同名产物，`release.yml` 用 `dist/*.fpk` 通配，均无需改动。

### 偏差 9 — 无头模拟器没有蓝牙后端：崩溃弹窗抢前台，必须开机后加固

> 编号顺延为 9（偏差 8 已被 fnpack.json 占用）。
>
> **含 9b：`mResumedActivity` 在 Android 14 上不存在 —— 前台解析必须多字段兼容（真机回归，已修）。**

**现象（目标机 10.31.0.4，包 `ed23ee53` 实测）**：模拟器正常开机（`Boot completed in 33898 ms`，`adbConnected: true`），随后系统反复弹出对话框抢占前台：

```
"Bluetooth keeps stopping"  →  [App info] / [Close app]
```

- `POST /api/apps/com.simplemobiletools.flashlight/start` → `{"started":true,"foreground":true}`，
  但几秒后 `/api/status.foregroundPackage` 变回 `com.google.android.apps.nexuslauncher`；
- 弹窗叠在画面上，`/api/screen/frame` 截到的是带弹窗的脏图；
- 用户视角：点了启动，界面自己弹回桌面，还带一个崩溃框。

**根因**：emulator 自身日志

```
WARNING | Unable to connect to packet streamer, no bluetooth emulation available
WARNING | Failed to init netsim Wifi packet stream, fall back to previous network stack.
```

无头 + 无 netsim 后端 → 蓝牙 HAL 拿不到 packet streamer → `com.android.bluetooth` 进程反复崩溃 → 系统按「应用崩溃」策略弹框并把前台焦点交还桌面。这不是我们的代码 bug，是运行环境的必然结果，但**用户可感知**，所以要在服务侧根治。

**为什么必须 `adb root` + `pm disable`（只 `disable-user` 不够）**：

| 做法 | 当次会话 | 模拟器重启后 |
|---|---|---|
| `pm disable-user --user 0 com.android.bluetooth` | 有效 | **复发**（disable-user 只改当前用户状态，restart 后包被重新解析为启用） |
| `adb root` + `pm disable com.android.bluetooth` | 有效 | **持久**（写进 packages.xml 的 disabled 状态） |

`pm disable` 需要 root；模拟器默认镜像是 userdebug，`adb root` 可用。真机验证顺序：`adb root` → 等约 2s（adbd 以 root 重启）→ `pm disable` → `pm disable-user --user 0` → `am force-stop` → `settings put global bluetooth_on 0`，之后 `pm list packages -d | grep bluetooth` 得到 `package:com.android.bluetooth`，弹窗消失、前台稳定、截图干净。

**落地实现**：

1. `server/service/emulator.js`：
   - 新增纯函数 `buildHardeningPlan({disableBluetooth})`（命令序列）与 `parseDisabledPackages(text)`（解析 `pm list packages -d`），均可单测；
   - 新增 `_postBootHardening()`：在 `_waitBoot()` 成功之后、`state='running'` 之前调用；`adb root` 不可用时只跳过需 root 的步骤并记日志；**任何一步失败都只写日志，绝不让启动失败**（最差退化为「有弹窗」的旧行为，而不是把已开好机的模拟器判死）；结束时把 disabled 列表写进日志便于线上排查。
   - **不杀 systemUI**：那会把整个界面搞坏，只处理蓝牙。
2. `server/config.js`：新增 `DEFAULT_SETTINGS.emulator.disableBluetooth = true`（设置里可关，将来做蓝牙调试用）。
3. **前台包名改为「如实报告」**：新增 `server/service/foreground.js`，只认 `dumpsys activity activities` 的 `mResumedActivity`（退化 `mCurrentFocus`），不再拿 `runningPackages()[0]` 当前台——那只是「进程存活列表」的顺序，弹窗抢焦点时仍会返回应用包名，从而谎报 `foreground: true`。
   - `POST /api/apps/:pkg/start` 的返回从 `{started, activity, foreground: true}` 改为 `{started, activity, foregroundNow, foregroundIsApp}`：`started` = 已下发 `am start` 且未报错；`foregroundNow` = 事后轮询 `dumpsys` 得到的**真实**前台包名（窗口 4s，偏差 11 已放宽到 12s）；`foregroundIsApp` = 它是否为我们期望的应用。**宁可如实报告前台不是我们的应用，也不谎报。**
   - `/api/status` 增补 `foregroundDetail: {activity, source, systemSurface}`（`source` 取值 `topResumedActivity` / `ResumedActivity` / `mResumedActivity` / `mCurrentFocus` / `mFocusedApp` / `dialog`，见偏差 12）；`/api/apps` 的 `foreground` 在 `systemSurface=true`（前台是弹窗/桌面）时一律为 `false`。

**验证**：`test/fnos-unit.js` 新增纯函数用例（硬化计划顺序、`disableBluetooth=false` 空计划、`pm list packages -d` 解析、前台字段解析、`isSystemSurface`、弹窗抢焦点场景、`waitForPackage` 轮询与超时如实返回），当时 `npm test` 为 **39 + 20 = 59 通过 0 失败**；现已扩到 39 条（见偏差 9b / 12），不再只靠真机验证。

**A/B 复验（团队侧真机，10.31.0.4，包 `6c3f9dfe`）**：`pm enable com.android.bluetooth` 重新打开 → 弹窗如期复现（uiautomator 读到 `text="Bluetooth keeps stopping"`）；API stop/start 重启模拟器 → 加固日志 `[hardening] 完成，耗时 4834ms`，重启后 uiautomator 读到桌面（Camera/Chrome/Gmail…），`pm list packages -d` 含 `package:com.android.bluetooth`、`package:com.android.nfc`。加固链有效且持久。

### 偏差 9b — `mResumedActivity` 在 Android 14 上不存在，前台解析必须多字段兼容

**现象（包 `6c3f9dfe` 真机回归）**：模拟器 `bootMs=32178`、`adbConnected:true`，应用**实际就在前台**（截图正常、可点击），但

```json
{"started":true,"activity":"com.simplemobiletools.flashlight.activities.SplashActivity",
 "foregroundNow":null,"foregroundIsApp":null}
```

`/api/status` 同样 `foregroundPackage:null / foregroundDetail:null`。等于把一个原本可用的功能改坏了——因为首版 `foreground.js` **只认 `mResumedActivity`**。

**根因（真机 dump 原文，Android 14 / API 34 / google_apis x86_64 / emulator 37.3.8.0）**：

```
$ adb shell dumpsys activity activities | grep -iE "ResumedActivity"
    topResumedActivity=ActivityRecord{7394cdb u0 com.simplemobiletools.flashlight/.activities.MainActivity t14}
  ResumedActivity: ActivityRecord{7394cdb u0 com.simplemobiletools.flashlight/.activities.MainActivity t14}

$ adb shell dumpsys window | grep -iE "mCurrentFocus|mFocusedApp"
  mCurrentFocus=Window{97f20a7 u0 com.simplemobiletools.flashlight/com.simplemobiletools.flashlight.activities.MainActivity}
  mFocusedApp=ActivityRecord{7394cdb u0 com.simplemobiletools.flashlight/.activities.MainActivity t14}
```

**`mResumedActivity` 一行都没有**——那是 Android 9/10 的字段，Android 11+ 改成了 `topResumedActivity=` / `ResumedActivity:`。

**修复**：按优先级命中即停，5 种字段全兼容（并保留旧系统路径）：

| 优先级 | 字段 | 来源命令 | 出现版本 |
|---|---|---|---|
| 1 | `topResumedActivity=ActivityRecord{...}` | `dumpsys activity activities` | Android 11+ |
| 2 | `ResumedActivity: ActivityRecord{...}` | `dumpsys activity activities` | Android 11+ |
| 3 | `mResumedActivity: ActivityRecord{...}` | `dumpsys activity activities` | Android 9/10 |
| 4 | `mCurrentFocus=Window{...}`/`ActivityRecord{...}` | `dumpsys window` | 各版本通用 |
| 5 | `mFocusedApp=ActivityRecord{...}` | `dumpsys window` | 各版本通用 |

正则只在包裹体内抓一次，不对整段 dump 做贪婪匹配；`u\d+` 兼容 `u10` 这类两位数 user id；包名取 `/` 之前那段：

```js
/topResumedActivity=\s*ActivityRecord\{[^}]*?\su\d+\s+([A-Za-z0-9_.]+)\/([.\w$]+)/
/(?:^|\s)ResumedActivity:\s*ActivityRecord\{[^}]*?\su\d+\s+([A-Za-z0-9_.]+)\/([.\w$]+)/
/mResumedActivity:\s*ActivityRecord\{[^}]*?\su\d+\s+([A-Za-z0-9_.]+)\/([.\w$]+)/
/mCurrentFocus=(?:Window|ActivityRecord)\{[^}]*?\su\d+\s+([A-Za-z0-9_.]+)\/([.\w$]+)/
/mFocusedApp=(?:Window|ActivityRecord)\{[^}]*?\su\d+\s+([A-Za-z0-9_.]+)\/([.\w$]+)/
```

采样命令同步改为大小写不敏感、覆盖新旧字段：

```
dumpsys activity activities | grep -iE "topResumedActivity|ResumedActivity"
dumpsys window | grep -iE "mCurrentFocus|mFocusedApp"
```

（`(?:^|\s)ResumedActivity:` 刻意排除 `mResumedActivity:`，避免两条规则互相吃掉。）

**方法论教训（写进文档，避免重犯）**：上一版单测夹具是「凭记忆编的 dumpsys」，解析器自然只对编出来的形状成立，真机一跑就 null。**这类系统输出解析，夹具必须逐字取自真机原文**。现在 `test/fnos-unit.js` 的前台夹具全部是上面 4 行原文的逐字复制，并补了「采样命令必须含 `topResumedActivity`」的命令级断言（这条断言能在不连真机的情况下直接拦住本次回归）。

### 偏差 10 — fnpack 条目补齐 `maintainer_url` / `distributor_url`，删除空 `preview_urls`

**来源**：用程序逐键对比我方 `dist/fnpack.snippet.json` 与目标机上真实外部源（`TaroCats/huitai`）的 `fnpack.json` 原文：

```
我方缺字段: ['distributor_url', 'maintainer_url']
我方多字段: ['preview_urls']
platform: ['x86'] | ref: ['x86','arm']
service_port type: str | ref: str        ← 已一致
install_type: '' | ref: ''               ← 已一致
```

**处理**：

1. 补 `maintainer_url = "https://github.com/RoutineMiku"`（本地 `curl -L -o /dev/null -w %{http_code}` 实测 **200**，非编造）。
2. 补 `distributor_url = "https://github.com/TaroCats/apkstart"`（实测 **200**）。
3. **删掉 `preview_urls` 键**：真实源里只有确实有截图时才写（lemon-music 是 5 条相对路径，huitai / apphub 干脆没有该键）。空数组虽多半无害，但没必要保留空值，减少 FnDepot 各版本解析差异的风险。
4. `platform` 与 `releases.<ver>.packages` 的 key **保持单元素 `x86`**，不为对齐 huitai 而加 `arm`——我们只有 x86 产物，加了会让 arm 用户下到装不上的包（这条是**故意不跟随**参考源的地方）。
5. **字段顺序也按参考源排列**：`display_name,desc,platform,categories,icon_url,readme_url,bug_report_url,maintainer,maintainer_url,distributor,distributor_url,run_as,install_type,is_docker,service_port,releases`。JSON 对象本无序，但 FnDepot 各版本解析实现不一定都按 map 取值，顺序一致零成本、零风险。已用 node 断言 `JSON.stringify(Object.keys)===JSON.stringify(refKeys)` 为 true，缺 0 多 0。

`build/gen-fnpack.js` 用常量 `REPO_URL` 生成 `distributor_url`，避免两处地址漂移；`maintainer_url` 与 manifest 中的值同源同值。

### 偏差 11 — `waitForPackage` 采样窗口 4s 太窄，start 把刚启动的应用报成桌面

真机复验（10.31.0.4，v7 `8e4128bf…`）暴露此问题；前台解析主线（偏差 9b 的五字段）已验证通过。

**现象**：force-stop 后调 start → `{"started":true,"foregroundNow":"com.google.android.apps.nexuslauncher","foregroundIsApp":false}`；但 **4~10 秒后**应用确实到前台（`topResumedActivity=...flashlight/.activities.MainActivity`），`/api/status` 也随之正确。另一次 start 整体耗时 15.5s。

**根因**：`waitForPackage` 的 `timeoutMs` 默认 4000。目标机 `-gpu off` 软件渲染，`am start` 之后除了 `Displayed ... +2s101ms` 还有 splash → main 的切换，真实耗时 4~10s。4s 窗口太窄，最后一次采样正好落在 launcher 上，于是把「启动成功」报成「在桌面」。

**修复**：
- `foreground.waitForPackage` 默认 `timeoutMs` 4000 → **12000**（`intervalMs` 保持 500）。命中即返回，所以快机器上不会白等 12s。
- `installer.js` 两个调用点（`install()` L140、`startApp()` L177）**显式传 `{ timeoutMs: 12000 }`**，让默认值改动不影响其他潜在调用点的语义（显式优于隐式）。
- 注释里把「固定 500ms」「4s 窗口」的说明同步改掉，写明这台机器的实测数字。
- 单测加一条回归护栏：显式 `timeoutMs` 下会跑满窗口且窗口内多次采样，防止将来又被人改回 4s。

**真机验收（v8 `cee439f8…`，无弹窗条件）**：force-stop 后 `POST /api/apps/com.simplemobiletools.flashlight/start` →
`{"started":true,"activity":"...SplashActivity","foregroundNow":"com.simplemobiletools.flashlight","foregroundIsApp":true}`，耗时 **14793 ms**（轮询在 12s 采样窗口内等到了 Activity resume，符合预期）；随后 `/api/status` 返回 `foregroundPackage=com.simplemobiletools.flashlight, source=topResumedActivity, systemSurface=false`。

### 偏差 12 — ANR / `Application Error` 弹窗窗口没有 `<pkg>/<activity>`，焦点兜底直接失效

**真机原文 A（开机过程中 systemui / system 发生 ANR 时抓到）**：

```
  mCurrentFocus=Window{7061971 u0 Application Not Responding: com.android.systemui}
  mCurrentFocus=Window{626b07c u0 Application Not Responding: system}
```

窗口 token 之后是 `Application Not Responding: <name>`，**没有 `<pkg>/<activity>`**，所以 `RE_CURRENT_FOCUS` / `RE_FOCUSED_APP`（都要求 `\su\d+\s+pkg/act`）一条都匹配不上。

**真机原文 B（v8 验收时蓝牙 native crash 弹窗延迟弹出，抓到的完整现场）**：

```
mCurrentFocus=Window{33d43fa u0 Application Error: com.google.android.bluetooth}
mFocusedApp=ActivityRecord{42387ca u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t19}
topResumedActivity=ActivityRecord{42387ca u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t19}
```

这份现场把「为什么必须弹窗优先」讲得最清楚：`mFocusedApp` 与 `topResumedActivity` **都还是桌面 launcher**，只有 `mCurrentFocus` 是弹窗。旧实现的 `current()` 走在 resumed 分支就直接返回 launcher 了。修复后接口返回：

```json
{"foregroundPackage":"com.google.android.bluetooth","activity":"","source":"dialog","systemSurface":true}
```

`source='dialog'`、`activity` 空串、包名取到弹窗宿主，**没有再谎报桌面/应用在前台**。

**修复**：
1. 新增 `parseSystemDialog(focusDump)`，两条正则：

```js
/mCurrentFocus=Window\{[^}]*?\su\d+\s+Application Not Responding:\s+([A-Za-z0-9_.]+)\}/
/mCurrentFocus=Window\{[^}]*?\su\d+\s+Application Error:\s+([A-Za-z0-9_.]+)\}/
```

命中返回 `{ package, activity: '', source: 'dialog', systemSurface: true }`；`system` / `system_server` 不是合法包名，归一成 `android`（`isSystemSurface('android')` 恒为 true）。

2. `current()` 采样顺序**改为「先窗口焦点、后 Activity 栈」**：先取 focus dump，若弹窗命中**立即返回**（弹窗优先级高于 resumed）；否则再走原来的 resumed → focus 逻辑。两条 dumpsys 各自 try/catch，任一条失败都不影响另一条，最终仍可能返回 null（绝不抛错）。
   > 顺序调换的副作用：正常路径多一次 adb round-trip（先 window 再 activity）。因为原来的顺序是先 activity，只有在 resumed 采不到时才打 window。为「不谎报」付这点代价是值得的；而且弹窗命中时反而**少**一次 round-trip。
3. `pickForeground()` 同步改为「弹窗 > resumed 三兄弟 > focus 两兄弟」，并把 `systemSurface` 标记收敛到 `withSurface()` 一处，避免 `current()` 与 `pickForeground()` 两套逻辑漂移。
4. 单测夹具**逐字使用真机原文 A 的两行**（含前导两个空格与 `Window{7061971 u0 ` / `Window{626b07c u0 ` 的 token），并额外构造「focus 是弹窗 + mFocusedApp 仍是 launcher」的组合夹具（来源即原文 B 的结构），断言 `package === 'com.android.systemui'` / `'android'`、`source === 'dialog'`、`systemSurface === true`，且弹窗优先级高于 resumed。

**已知备注（不影响验收，本次不改代码）**：这版镜像的蓝牙包名是 Google 模块名 `com.google.android.bluetooth`，而 AOSP 是 `com.android.bluetooth`；`isSystemSurface()` 白名单里只有后者。当前不影响结果——`parseSystemDialog()` 命中时 `systemSurface` 直接置 `true`，不经过白名单。只有「该包名出现在 resumed/focus 的正常分支」时（例如蓝牙 Activity 自己跑到前台）才会漏判为「非系统界面」，届时把 `com.google.android.bluetooth` 加进白名单即可。

### 偏差 13 — wizard 顶层必须是数组 `[]trimpkg.WizardPage`；`field` 值不进脚本（0.2.0 装不上，0.2.1 修复）

**症状（用户报，0.2.0 首次走 App Center 安装）**：

```
获取安装信息失败: checkPackage installWizard
  /vol2/appcenter-downloads/apkstart-fnos-0.2.0-tpk/wizard/install is not exist: 100610
| wizard invalid: json: cannot unmarshal object into Go value of type []trimpkg.WizardPage
```

**排查路径（顺手排除了一个假线索）**：先怀疑"文件没进包"。SSH 上看目标机 `/var/apps/apkstart-fnos/wizard/install` 与解包目录 `/vol2/appcenter-downloads/apkstart-fnos-0.2.0-tpk/wizard/install` **都存在（473 B）**，`tar -tzf` 顶层结构也对（`app/ cmd/ config/ ICON* manifest wizard/`）。所以 **报错里的 "is not exist: 100610" 是误导文案**——fnOS 把"JSON 解析失败"也说成"不存在"，真正原因只看后半句 `cannot unmarshal object`。

**真因**：我们把 wizard 写成了对象

```json
{ "title": "ApkStart 安装向导", "description": "…", "steps": [{ "type": "info", … }] }
```

而 fnOS 的 Go 侧是 `json.Unmarshal(buf, &[]trimpkg.WizardPage{})`，顶层类型是**切片**，给对象必挂。
`0.1.0` 从没走过 App Center（是手工解包装的），所以这个错一直没暴露；`0.2.0` 是第一次真实 App Center 安装。

**契约（从目标机 3 个已装应用反向确认的 ground truth，非文档推测）**：

| 层级 | 结构 |
| --- | --- |
| 顶层 | `Array<WizardPage>`（**必须是数组**） |
| `WizardPage` | `{ stepTitle: string, items: WizardItem[] }` |
| `WizardItem` | `tips` → `{ type:'tips', helpText }`；`switch` → `{ type:'switch', field, label, rules? }`；`text` → `{ type:'text', field, label, rules? }` |
| `Rule` | `{ required?: boolean, pattern?: string, message?: string }` |

取证来源：`fn-scheduler`（tips）、`cloudlink-finder`（switch + rules.required）、`baidu.netdisk`（text + rules.pattern `^确认$`）。

**第二个结论（同样影响设计）：`field` 的值到不了 `cmd/*` 脚本。**

先纠正一个容易想当然的地方：字段值**并不是**完全没用——官方 CLI 的
`app install --custom-parameters '[{"key":"port","value":8080}]'` 就是喂给 wizard 字段的
（`trim_app_center` 里有 `req.CustomParameter` / `json:"customParameters"` /
`FilterCustomParameters`），所以值确实进了**安装任务的 `customParameters`**。

但对 shell 生命周期脚本不可见。三重证据：

1. 在 `cloudlink-finder`、`dpanel` 的 `cmd/*` 里 grep `TRIM_WIZARD` / `wizard` 零命中（只命中 wizard 文件自身）。
2. `strings /usr/trim/bin/trim_app_center | grep -oE 'TRIM_[A-Z_]+' | sort -u` 得到 app_center 注入给脚本的完整环境变量表——`TRIM_APPNAME`/`TRIM_APPVER`/`TRIM_PKGVAR`/`TRIM_PKGTMP`/`TRIM_PKGETC`/`TRIM_APPDEST`/`TRIM_RUN_UID`/`TRIM_SERVICE_PORT`/`INSTALL_VOLUME_ID`/`WIZARD_EXCEPTION`…… **没有任何 per-field 的 `TRIM_*`**。
3. 顺带发现：我们脚本里读的 `TRIM_UNINSTALL_PURGE` **不在这张表里**，fnOS 不会替我们设置它——所以 purge 分支实际是"仅当外部手动传入才生效"，不能算功能。

因此 `wizard/uninstall` 没有做成"勾了就删数据"的 `switch`——那会是个**假开关**。改成两段 `tips` 说明"数据会保留 + 怎么手动清"，脚本侧仍只认外部传入的 `TRIM_UNINSTALL_PURGE=1`。同时删掉 `uninstall_callback` 头注释里"或 wizard 传入 purge=true"这句不成立的承诺。

**顺带从二进制字符串表读到的校验规则**（比我们的校验器更细，可作为后续扩展参照）：校验函数是 `ParseInstallWizard` / `ParseUninstallWizard`，item 类型除 `tips`/`switch`/`text` 外还有 `select`/`checkbox`/`password`；逐项报错有 `wizard item type %s is invalid`、`wizard switch field is empty`、`wizard select options is empty`、`wizard required message is empty` 等。我们只用了 `tips`，不涉及这些必填项，但校验器已按白名单卡死（写错 type 会在打包时就失败）。

**修复与护栏**：

1. `fnos/wizard/install` / `uninstall` 全部改为顶层数组；`install` 用两个 `tips`（在线包说明、GPU 可选说明）。
2. 新增 `build/validate-wizard.js`：校验顶层是数组、`stepTitle` 非空、`items` 非空、`type` 在白名单内（`tips`/`switch`/`text`）、各类型必填键、`rules` 形状；并强制 `install`、`uninstall` 两个文件都在。
3. `build/pack.sh` 第 2.5 步校验**stage 里那份**（即真正进包的那份），不通过就不打包。
4. 单测 3 例（`test/fnos-unit.js`，64 → 67）：仓库内 wizard 全过校验；校验器能拒掉对象格式 / 非法 JSON / 缺 `stepTitle` / 未知 `type`；`uninstall` 里不许出现 `field`（防假开关回潮）。Linux CI job 直接跑这份单测，所以红会红在 PR 上。
5. **附带修掉一个连踩两次的发版基建坑**：`actions/checkout` 在 checkout tag 时会执行 `git fetch --no-tags … origin +<sha>:refs/tags/<tag>`，把 tag 引用**强制重置成指向 commit 的轻量引用**，先前 `+refs/tags/*:refs/tags/*` 拉下来的附注 tag 对象被覆盖 → `git tag --format='%(contents:subject)'` 退化成读 commit subject → changelog 变成 commit 首行（v0.2.0、v0.2.1 连续中招）。`fetch-depth: 0` + `fetch-tags: true` **救不了**，因为覆盖发生在 checkout 自己那一步。`release.yml` 的 Resolve 步骤改为 checkout 之后**重新强拉一次 tag**，并用 `git cat-file -t` 断言拿到的是 `tag` 而不是 `commit`，不符就 `::warning::`。

**版本处置**：`0.2.0` 的资产对 App Center 安装是坏的，**不覆盖**已有 Release（有用户可能已下载/做校验），直接发 `0.2.1`。

### 偏差 14 — fpk 根级必须是 `app.tgz`（嵌套压缩包），**不能**是 `app/` 目录（0.2.1 装不上，0.2.2 修复）

**症状（真机原文）**：

```
ApkStart 安装状态失败 (code 10107):
failed to decompress app.tgz: failed to open tgz file:
open /vol2/appcenter-downloads/apkstart-fnos-0.2.1-tpk/app.tgz: no such file or directory
```

报错非常直白，反而容易看漏：它不是"解压失败"，而是**根本没找到 `app.tgz` 这个文件**。
我们的 0.2.1 把应用代码放在 fpk 根下的 `app/` 目录里，平台不会去遍历目录找代码。

**这次最难的不是修，而是拿到不会说谎的证据。** 之前一版 IMPL 里写过"`app/` 目录与 `app.tgz`
两种都被接受"——**这个结论是错的，此处推翻**。真正的取证来自安全模块的逐包记账：

```bash
grep -h "app package contents" /var/log/trim_app_center/*.log
```

平台给**每一个**安装/升级过的包都记一行顶层内容：

| 应用 | dirs | files |
| --- | --- | --- |
| apphub / speedtest / wechat-on-cloud / nodejs_v22 / nodejs_v24 / tailscale / huitai / softbox / fnmusic-hub | `[cmd config]` `[cmd config i18n]` `[cmd config wizard]` … | `[ICON.PNG ICON_256.PNG **app.tgz** manifest]` |
| **apkstart-fnos 0.2.1** | `[**app** cmd config wizard]` | `[ICON.PNG ICON_256.PNG manifest]` |

9 个第三方应用**无一例外**都有 `app.tgz`、且都没有 `app` 目录；只有我们这行是反的，
紧跟着一行 `failed to decompress app.tgz`。这比"看别人的包猜"强得多——它是平台自己说的。

**解包语义（从已装应用反向确认）**：

- `TRIM_APPDEST` = `/volX/@appcenter/<appname>`，`/var/apps/<appname>/target` 是指向它的**软链**。
- `app.tgz` 的内容**原样解包进 `TRIM_APPDEST`**：不剥前缀、不套壳、不改名。
  对照 `fnmusic-hub`：`app.tgz` 顶层是 `app/ bin/ config/ ui/`，装完 `$APPDEST/` 下就是
  `app/ bin/ config/ ui/`（外加 `X.sock`），逐项一一对应。
- fpk 根下的 `cmd/ config/ wizard/ manifest ICON*` 则落到 `/var/apps/<appname>/`，与 `app.tgz` 互不相干。
- `ui/` **不生成、只解包**：`$APPDEST/ui/config`（桌面入口）和 `ui/images/icon_{64,256}.png`
  都在 `app.tgz` 里，平台不替我们造。

**修复**：

1. `build/pack.sh` 第 2 步改成两套目录：`$PKGROOT`（fpk 根）与 `$APPSTAGE`（`app.tgz` 内容根，
   `$STAGE/.app`，以 `.` 开头永不进包）。应用代码进 `$APPSTAGE`，不再进 `$PKGROOT/app`。
2. 新增第 3.8 步：`tar -czf "$PKGROOT/app.tgz" -C "$APPSTAGE" server core ui`——**显式列成员**，
   这样 tar 顶层就是 `server/ core/ ui/`，不会多出 `./` 或外层目录名。
   `ui/config` 写入与 `config.js` 版本注入都前移到这里之前，保证打进 `app.tgz`。
3. `manifest` 的 `checksum` 把 `app.tgz` 当**一个文件**算（不会解开算），生成顺序不变。
4. 新增 `build/validate-package.js`：解出 fpk 与其中的 `app.tgz` 条目，校验
   ① 根级有 `app.tgz` 且是普通文件；② 根目录**不许**有 `app/`；③ 根级骨架
   （`cmd/ config/ wizard/ manifest ICON.PNG ICON_256.PNG`）；④ `app.tgz` 非空、顶层是
   `server/ core/ ui/`、且含 `server/index.js`、`ui/config`、`ui/index.html`；⑤ 反套壳（顶层只有
   `apkstart-fnos/` 一律报错）。fpk 那层公共前缀 `apkstart-fnos/` 会先被剥掉，再按"包根"判断。
5. `build/pack.sh` 第 5.5 步在**建完 fpk 之后**立刻校验——0.2.1 的问题正是"本地构建全绿、
   只有真机装到一半才炸"，所以护栏必须卡在产物上，而不是卡在源码上。
6. 单测新增 5 例（67 → 72）：能吃住 0.2.1 形态、放行正确形态、抓套壳与空包、
   `pack.sh` 不再往包根塞 `app/` 且必须调校验、`cmd/*` 路径假设（见下）。

**同时修掉两处被这个 bug 掩盖的路径假设错误**（都是 `set -u` + `|| true` 兜住、静默假成功的类型）：

| 位置 | 旧写法 | 问题 | 新写法 |
| --- | --- | --- | --- |
| `cmd/main` `do_stop` | `ADB_BIN="$APPDEST/runtime/platform-tools/adb"` | adb 在**数据根** `runtime/` 下，不在代码根；`-x` 永远失败，`adb emu kill` 从未执行过，全靠后面的 `pkill` 兜底 | `ADB_BIN="$DATA_ROOT/runtime/platform-tools/adb"` |
| `cmd/install_init` | `chmod 0755 "$APPDEST/../cmd/"*` | `$APPDEST` 的父目录是 `@appcenter`，里面没有 `cmd/`；条件恒假，chmod 从未生效 | `CMD_DIR="$(cd "$(dirname "$0")" && pwd)"`（与 `upgrade_init` 同款写法，不依赖变量语义） |

**真机等价验证（不需要 OAuth，也不需要真装一遍）**：在目标机上按 App Center 的语义解包到临时
APPDEST，再用真是 node 直接拉服务——

```
$APPDEST 内容: core server ui
入口: server/index.js(5903B) ui/config(152B) ui/index.html(6581B)  ← cmd/main 期望的路径都在
TRIM_APPDEST=/tmp/apkverify/appdest TRIM_PKGVAR=/tmp/apkverify/var TRIM_SERVICE_PORT=28890 \
  /var/apps/nodejs_v22/target/bin/node .../server/index.js
→ 200 {"app":"apkstart-fnos","status":"ok","version":"0.2.2","pid":4132607,"node":"v22.23.4"}
```

版本报 `0.2.2`（构建期注入生效）、数据根落在 `TRIM_PKGVAR`（不是代码根）、SIGTERM 优雅退出
——新布局下的三条路径假设一次跑通。

**附带**：macOS 的 bsdtar 会把 Apple 扩展属性写成 PAX 头
（`LIBARCHIVE.xattr.com.apple.provenance`），fnOS 侧 GNU tar 解包时逐文件打印
"忽略未知的扩展头关键字"。无害但噪声大，也让本地包与 CI 包字节不一致。
0.2.2 当时在非 GNU tar 分支加了 `--no-mac-metadata`——**这个参数不够**（见偏差 15 末尾），
真正关掉的是 `--no-xattrs`。

**版本处置**：`0.2.0`（wizard 坏）、`0.2.1`（包结构坏）两个资产都**不覆盖**，发 `0.2.2`。

### 偏差 15 — 默认端口 8890 在目标机被 Docker 里的 uvicorn 占用；端口必须以 `ui/config` 为单一真源（0.2.3 修复）

**症状**：装完起不来，`cmd/main start` 报「服务进程已退出，健康检查未通过」，日志尾部是
`listen EADDRINUSE`。

**取证**（目标机 10.31.0.4）：

```console
# lsof -i:8890 / ss -ltnp "sport = :8890"
uvicorn 1268089 root  ... TCP *:8890 (LISTEN)
# tr '\0' ' ' < /proc/1268089/cmdline
/usr/local/bin/python3.12 /usr/local/bin/uvicorn app.main:app --host 0.0.0.0 --port 8890 --proxy-headers
# ls -l /proc/1268089/cwd
/proc/1268089/cwd -> /app          ← Docker 容器里的服务，不是宿主进程，动不了
```

同机另被占用：`8899`（docker-proxy）、`18080`，而 `8890` 是**长期占用**（不是偶发）。
平台侧也不给兜底：manifest 里我们写的是 `checkport=false`，App Center 不做端口自检；
`grep -r TRIM_SERVICE_PORT /var/apps/*/target/cmd/` **一个应用都没用到**，说明平台不注入这个变量，
`cmd/main` 只能落到自己的默认值。

**平台惯例**（9 个已装第三方应用的 `ui/config`）：

| 写法 | 例子 | 说明 |
|---|---|---|
| 写死端口 | `"port": "9080"` / `"7401"` / `"7983"` / `"8089"` / `"8899"` | 多数应用的选择，撞了就装不上，属于「应用自己的责任」 |
| 占位符 | OpenList `"${port}"`、dpanel `"${DP_APP_SERVER_PORT}"`、wechat-on-cloud `"${WOC_HTTP_PORT}"` | 由平台/应用自己的配置替换，语义未公开 |
| 空串 + 网关 socket | fygo-browser `"port": ""` + `gatewaySocket` / `gatewayPrefix` | 完全不占 TCP 端口，见下文「未采用的方案」 |

**根因**：端口在 `pack.sh` / `config.js` / `cmd/main` / `gen-fnpack` / `gen-manifest` / `config/resource`
六处各写一遍 `8890`，任何一处改不动就漂移；而且启动前不探测，撞上了只能靠 node 的 `EADDRINUSE`
让进程秒退，安装器再把日志尾部当作错误回显——**信息量最低的失败方式**。

**做法**（`0.2.3`）：

1. **默认端口改 `18990`**（目标机实测空闲，避开同机已占的 8890/8899/18080/18890）。
2. **端口来源按优先级降级**：`TRIM_SERVICE_PORT` → `ui/config` 的 `"port"` → `DEFAULT_PORT`。
   `ui/config` 是「图标点开的端口」，服务跟着它走，两者不可能出现「图标指 A、服务听 B」；
   平台真注入 `TRIM_SERVICE_PORT` 时仍以平台为准。解析用 `sed` 而不是 node——这步发生在
   `resolve_node` 之前，不能假设 node 可用。
3. **启动前探测端口**（`port_busy`）：有人在听就**拒绝启动**，并在 stderr 点名占用者与改法
   （「改 `${APPDEST}/ui/config` 的 port」）。有 `ss` 用 `ss`，否则退 `netstat -an`。
   > 写这块时被自己的单测抓到一次真错：`netstat -ltn` 在 macOS/BSD 上不认 `-l`（照样列出
   > ESTABLISHED），于是永远匹配不到 LISTEN。改成 `netstat -an | grep -E "[:.]PORT\s" | grep LISTEN`，
   > 两种实现的地址分隔符不同（Linux `0.0.0.0:PORT`、BSD `127.0.0.1.PORT`），所以用 `[:.]`。
4. **同一份 `$PORT` 注入两处**：`ui/config` 与 `config/resource`（`pack.sh` 新增 3.2 步），
   避免「声明 A、实际听 B」的分叉；`gen-manifest.js` 的兜底值、`gen-fnpack.js` 的
   `service_port` 同步改到 `18990`。
5. **保留「校验响应体而非状态码」的健康检查**：0.1.0 时期曾出现 uvicorn 的 `/api/health`
   也返回 200，被判成「我们的服务启动成功」（假成功）。端口换了不代表这个判据可以删——
   任何端口都可能被别人占，200 从来不等于「是我的服务」。

**真机验证**（等价安装，不走 App Center）：

```console
# 默认端口：不给 TRIM_SERVICE_PORT，让它从 ui/config 读
$ TRIM_APPDEST=/tmp/apk23/appdest TRIM_PKGVAR=/tmp/apk23/var sh .../cmd/main start
rc=0
$ ss -ltn "sport = :18990" | tail -1
LISTEN 0 511 0.0.0.0:18990 0.0.0.0:*
$ curl -s 127.0.0.1:18990/api/health
{"app":"apkstart-fnos","status":"ok","version":"0.2.3","pid":52084,"node":"v22.23.4"}

# 撞端口：显式指到被 uvicorn 占着的 8890
$ TRIM_SERVICE_PORT=8890 sh .../cmd/main start
ApkStart 无法启动：端口 8890 已被其他程序占用，占用者 users:(("uvicorn",pid=1268089,fd=12))。
  图标指向的端口来自 /tmp/apk23/appdest/ui/config，改这里的 "port" 即可换端口
rc=1
```

**顺带修掉的真错**：`pack.sh` 在非 GNU tar 分支写的 `--no-mac-metadata` **并不抑制 xattr PAX 头**。
实测（bsdtar 3.5.3 / libarchive 3.7.4）同一文件：不加参数 1 个头、`--no-mac-metadata` 仍 1 个、
`--no-xattrs` 才 0 个。0.2.2 那条「已修」是假的——包内仍有 43 个 `LIBARCHIVE.xattr` 头，
真机解包照样刷屏。0.2.3 改为 `--no-mac-metadata --no-xattrs`，并在打包末尾加兜底检查
（命中就告警），包内 PAX 头计数降为 0，真机解包噪声 0 行。

**未采用的方案：网关 socket（`port: ""` + `gatewaySocket`）**。平台支持得比我们想的干净：

```jsonc
// fygo-browser 的 ui/config
{"type": "iframe", "port": "", "gatewaySocket": "app.sock", "gatewayPrefix": "/app/fygo-browser"}
// fnmusic-hub（$APPDEST/fnmusic-hub.sock 是它自己监听的 unix socket）
{"type": "iframe", "protocol": "", "gatewaySocket": "fnmusic-hub.sock", "gatewayPrefix": "/app/fnmusic-hub"}
```

这条路**一个 TCP 端口都不占**，撞端口问题从根上消失，`server/http/server.js` 也早就预留了
`LISTEN_SOCKET` 分支。这轮没切换的原因是风险收益不划算：`ui/api.js` / `screen.js` 里所有请求
都写成绝对路径 `/api/...`，挂到 `/app/apkstart-fnos` 前缀下会全部 404，得先整体改成相对路径；
而网关的前缀剥离/透传行为**只能靠真实 App Center 验证**，本地无法复现。先把「撞端口」用
可验证的最小改动解决，网关化留作 P1（届时需要一次真机安装来验收）。

**版本处置**：`0.2.0` / `0.2.1` 不可用（wizard / 包结构），`0.2.2` 能装但端口可能撞，发 `0.2.3`。

### 偏差 16 — 「起不来」的三个链式真因：AVD 遗留占用 / `$HOME` 不可写 / emulator 继承的 `cwd`（0.2.4 修复）

用户装完 0.2.3 第一次点开模拟器就贴回一屏日志，里面两条 FATAL：

```
ERROR | Your GPU cannot be used for hardware rendering. Consider using software rendering.
FATAL | Running multiple emulators with the same AVD is an experimental feature.
        Please use -read-only flag to enable this feature.
[exit] code=1 signal=null
[boot-fail] 模拟器进程已退出（code=1）
[gpu] -gpu host 启动失败（模拟器进程已退出（code=1）），自动降级 off 重试
```

一眼看是「GPU 不行」，实际是三件互不相干的事叠在一起。逐层拆：

**16.1 同一 AVD 的遗留模拟器（用户报的这条 FATAL）**

emulator 用 `<AVD>/<name>.avd/hardware-qemu.ini.lock` + `multiinstance.lock` 保证单实例，
第二个实例直接 FATAL 退出。旧实现**没有任何回收**：只要是异常退出（崩溃 / 被 kill -9 /
我此前手工测试留下的孤儿进程），锁就留在盘上，下一次启动必然撞死；更糟的是 `start()`
还会把这条错误当成「host 不行」再降级 `-gpu off` 重试一次——重试同样撞锁，日志里出现
两段启动输出，真因被埋掉。

取证时踩到的一个坑值得记下来：`pgrep -f '-avd apkstart'` **会命中扫描者自己**（我们的
日志行里就抄着完整命令行），也会命中 `-avd apkstart2`。改成读 `/proc/<pid>/cmdline`、
要求 `qemu-system` 且 `-avd <name>` 整词匹配（`(?:^|\s)-avd\s+name(?:\s|$)`），不依赖
procps、也不会自我命中。

做法（`server/service/emulator.js`）：

- `scanAvdEmulators(avdName)`：扫 `/proc`，跳过自身 pid，返回所有占着该 AVD 的 qemu；
- `_releaseAvd(avdName)`：SIGTERM → 轮询等待（默认 6s）→ 仍在则 SIGKILL → 还在就抛
  `CONFLICT`（文案点名 pid 与处置办法）→ 清掉 `*.lock`；
- 顺序关键：`_releaseAvd` 必须在 `ensureAvd` **之前**（锁被占着时重写 `config.ini` 也白搭）；
- `start()` 遇到 `CONFLICT` **不做** `-gpu off` 重试（AVD 冲突与 GPU 无关），并把失败写进
  `state='error'`——早先漏了这一步，前端看到的是「一直在 starting」，转圈不停。

真机复验（用真实包用户 uid 926 起，故意留一个 root 属主的孤儿 qemu）：

```
[avd] 无权结束 pid=3796763（EPERM）
模拟器无法启动：另一个使用 AVD「apkstart」的模拟器还在运行（pid=3796763），
  它属于其他用户，当前身份（apkstart-fnos）无权结束它…
[gpu] AVD 冲突与 GPU 无关，不做 -gpu off 重试
```

给富有权限的进程时则正常回收、清锁、继续启动。

**16.2 adb 的 `$HOME` 不可写（更隐蔽，卡了两轮）**

16.1 修完后开机正常，但 `/api/status` 一直是 `adbConnected:false`，adb 侧原文：

```
F adb : adb_utils.cpp:315 Cannot mkdir '/home/apkstart-fnos/.android': No such file or directory
Aborted
```

包用户没有家目录：`/home/apkstart-fnos` 不存在，父目录 `/home` 是 root 属主，uid 926 建不出来。
`core/adb.js` 此前直接沿用 `process.env.HOME`（服务由平台拉起时为空或指向不存在目录）。
修法：`pickWritableHome()` 依次试 `$HOME` → `$TRIM_PKGVAR` → `$TRIM_APPDATA` → `$TMPDIR/apkstart-adb-home`，
**真的 mkdir + access(W_OK) 验一遍**再用；`_adbEnv()` 把 `HOME` 指过去。修后
`adb devices` → `emulator-5554  device`，`adbConnected:true`。

同一条命令手工跑仍会 Aborted（我 shell 里没设 HOME）——这恰好说明「编译时看着对、运行时
env 不对」才是这 bug 的本质，靠单点手工验证抓不住。

**16.3 `-gpu host` 静默失败 = emulator 继承了不可读的 `cwd`（GPU 加速真正跑通的最后一环）**

16.1/16.2 之后 emulator 能起、adb 能连，但 `gpu` 始终是
`{mode:'off', reason:'fallback-after-failure'}`，即用户长期关切的那句「GPU 加速没写对」。
这次的日志比用户贴的那份更干净——host 尝试**只有一行**，前后没有任何错误：

```
[start] ... -gpu host -accel on -port 5554 ...
[start] KVM available=true writable=true accel=on gpu=host display=:9
INFO  | emuglConfig_init: vulkan_mode_selected:host gles_mode_selected:host
DEBUG | Starting QEMU main loop
WARNING | QEMU main loop exits abnormally with code 1     ← 2.1s 内，无其他错误行
```

排查过程（这段方法论比结论更值钱）：

1. 把子进程 stdio 从 pipe 改成落盘文件、加 `-verbose`，确认 `QEMU main loop` 之前一切正常：
   `vulkan_mode_selected:host`、`Graphics Adapter … (Mesa Intel(R) Graphics (ADL-N))`、
   `hasSufficientHwGpu: Ok`——**显卡能力检查是通过的**，那条 `Your GPU cannot be used for
   hardware rendering` 是 gfxstream 早期打印的固定噪声，不是结论。
2. 对比同一次启动里 host/off 两次的 QEMU 参数（`Concatenated QEMU options`）：**完全一致**，
   只有 modem 的随机端口不同。所以不是 `-gpu` 改了 QEMU 的 device 拓扑。
3. 手工重放（Xvnc + emulator 前台跑）在 `cwd=/` 下 host **能开机**（`Boot completed 26684ms`）。
   注意：手工重放前必须把 `<AVD>/config.ini` 的 `hw.gpu.mode` 改成 `host`，否则 emulator 会
   按 AVD 里的 `off` 退回 lavapipe（`Your AVD has been configured with an in-guest renderer…Falling
   back to 'lavapipe' mode`），跑出「host 其实能用」的假阳性。
4. 逐步复刻产品侧的环境变量（`ANDROID_SDK_HOME` / `ANDROID_EMULATOR_USE_SYSTEM_LIBS=0` /
   `ANDROID_ADB_SERVER_PORT=5044` / `XDG_RUNTIME_DIR=/run/user/0`）→ 仍然能开机。
5. 唯一剩下的差异是 **cwd**：产品侧那次服务是 `su -c …` 从 `/root` 拉起的，cwd 继承成
   `/root`（0700 root），包用户连 `.` 都读不了。把服务改成从 `/` 拉起，同一份代码 host
   立刻跑通（`reason:'auto-host'`，boot 28735ms）。A/B 成立。

修法（最小、可验证）：`spawn(emulator)` **显式传 cwd**，指向 `$APPDATA/tmp`（包用户自己的
可写目录），不再继承服务进程的 cwd；建不出来时退回 `undefined`（不阻断启动），并把 cwd 打进
`[start]` 日志——下次一条日志就能排除这一类。另外在降级分支加一句提示：若只有「QEMU main
loop exits abnormally」且无其他错误，先看 `[start]` 的 cwd、再看 AVD 锁与 5554 端口。

修后真机（**故意**从 `/root` 启动服务，即原本必失败的那套环境）：

```
[gpu] 自动检测到硬件 3D X display 与 render node，启用 -gpu host（DISPLAY=:9）
[start] KVM available=true writable=true accel=on gpu=host display=:9 cwd=/vol2/@appdata/apkstart-fnos/tmp
[boot] boot_completed in 27614ms
status: emulator=running  gpu=host( auto-host )  adbConnected=true
```

至此「GPU 加速」不是配置项上的字样，而是真跑在 Intel ADL-N 的 Mesa/Vulkan 上
（`vulkan_mode_selected:host gles_mode_selected:host` + `Graphics Adapter … Mesa Intel(R) Graphics (ADL-N)`）。

顺带解释用户日志里那条 `Failed to create /home/apkstart-fnos for shader cache (Permission
denied)---disabling.`：它是 **Xvnc 进程里 Mesa** 打的（不是 emulator），同样因为 `HOME` 指到
不存在的家目录，Mesa 关掉了自己的磁盘 shader cache。`xserver` 的 spawn 已经给了
`HOME: APPHOME`，这条只在「Xvnc 由运维/旧版本用别的 env 拉起」时出现，不影响模拟器渲染。

**版本处置**：16.1 / 16.2 / 16.3 全在 `0.2.4`；三条都不需要改 fpk 结构，可直接覆盖安装。

### 偏差 17 — 「只有画面不能操作」：`<img>` 原生拖拽打断手势 + 点击容差用错单位（0.2.5 修复）

现象（用户原话）：「为什么只有画面不能操作？应该是可以操作的」。装上 0.2.4 后能看到模拟器
画面、每 500ms 刷新，但点在画面上没有任何反应，拖也拖不动。

**先说结论：后端没坏。** 直接打产品接口注入输入是通的：

```
A=288e5b9f4a39
--- POST /api/screen/swipe {x1:540,y1:1400,x2:540,y2:500,durationMs:300} → {"ok":true}
B=361b73042802        ← 画面真的变了
--- POST /api/screen/tap {x:540,y:960} → {"ok":true}
```

所以范围收到前端 `ui/screen.js`。本机没有 Playwright 浏览器，用 `playwright-core`（不下载
浏览器）+ 系统 Edge（`executablePath`）跑真实指针事件，并在页面里拦 `/api/screen/*` 请求，
把「用户做了一个手势 → 到底有没有请求发出去」逐场景量化。修复**前**实测：

```
A 单击: 1 条 (tap {"x":539,"y":961})
B 有 3px 手抖的单击: 0 条 (无)              ← 点了没反应
C 拖拽上滑 400px: 0 条 (无)                 ← 滑不动
D 拖拽后的单击: 1 条 (tap …)
E 双击两下: 2 条
F 长按 900ms: 1 条 (tap …)                  ← 长按被压成点击
```

两个独立真因：

**17.1 `<img>` 默认 `draggable=true`，原生 HTML5 拖拽把自定义手势打断。**
`<img>` 天生可拖。鼠标按住画面往外拖，浏览器启动 HTML5 drag，随即对元素发 `pointercancel`，
`_dragStart` 被清空，`pointerup` 里「没有起点」直接 return —— **一次 swipe 都发不出去**
（上面 C 的 0 条）。现场取证：第一次探针打出来的 `{"draggable":true,"events":["pointerdown","pointerup"]}`
里根本没出现过 `pointermove`/`pointerup` 的配对，而修复后同一场景是
`pointerdown,pointermove×12,pointerup`，且 `draggable:false`。

修法（三条都要有，不同浏览器认的不一样）：`el.draggable = false` + `setAttribute('draggable','false')`；
`pointerdown` 里 `ev.preventDefault()`（阻止默认拖拽与文本选中）；`dragstart` 上
`preventDefault()` 兜底。CSS 侧补 `-webkit-user-drag: none` / `-webkit-touch-callout: none` /
`touch-action: none`。

**17.2 「点 vs 滑」的判定用设备像素，容差实际上只有 2.5 个浏览器像素。**
旧代码：`if (dx < 8 && dy < 8) tap else swipe`，`dx/dy` 是**设备像素**。但这台机 1080×1920 的
画面在桌面上是 344×612 CSS px，**1 CSS px ≈ 3.14 设备像素**，于是 8 设备像素 = 2.5 CSS px。
鼠标/触控板点击自带的 2~4px 手抖都会被判成 swipe，再被 `Math.max(50, elapsed)` 抬到 50ms，
最终发出的是 `input swipe x y x+3 y 50` —— 位移 3 个设备像素、50ms，屏幕上什么都不会发生。
这就是「点了没反应」的第二个来源（上面 B 的 0 条）。

修法：抽出纯函数 `classifyGesture({dx, dy, deviceDx, deviceDy, elapsed})`，**位移用 CSS 像素**
判（`TAP_SLOP_CSS = 10`，与触摸屏的 click slop 同量级），并加一条兜底：设备像素位移
`< 6` 时一律算点击（此时 swipe 必是空操作）。顺带补上长按：`input tap` 只是瞬时的 down+up，
触发不了长按菜单，所以按住 ≥ 600ms 且没位移时发**原地按住** `input swipe x y x y <dur>`。

修后同一套探针（真机 10.31.0.4，真实 Edge）：

```
img 属性 = {"draggable":false,"touchAction":"none","userDrag":"none"}
A 单击:                     tap {"x":539,"y":961}
B 有 3px 手抖的单击:        tap {"x":549,"y":968}          ← 不再被吞
C 拖拽上滑 400px:           swipe {539,1589 → 539,334, dur 194}   ← 不再为 0 条
D 拖拽后的单击:             tap {"x":539,"y":961}           ← 没被上一次拖拽污染
E 双击两下:                 2 条 tap
F 长按 900ms:               swipe {539,961 → 539,961, dur 902}     ← 原地按住
G 很小的真拖拽（20px）:      swipe {539,961 → 539,899, dur 100}
```

设备端也确实动了（不是「请求发出去了」就完事）：

| 场景 | 客观判据 | 结果 |
| --- | --- | --- |
| 桌面拖拽上滑 | 画面 PNG sha256 | `1ad36188ba1b → d5574f69387b`，开应用抽屉 |
| 应用内单击（Flashlight 主开关） | 画面 PNG sha256 | `c374706496ad → a8025aab36fe →` 再点切回 |
| 长按桌面 900ms | 画面 hash + 停留稳定性 | 变化且稳定 1.2s（弹层停住），`back` 后恢复 |
| 直打 API 上滑 | 画面 hash 序列 | 连续 4 拍稳定到新 hash（抽屉打开） |

**附带修的两个「看起来发了、其实没到设备」的路径**（`server/api/screen.js`）：

- 常驻输入通道（`core/adb.js` 的 `_inputSession`）在模拟器重启后是断的，命令写进死管道
  等于丢掉。抽出 `_inject(adb, cmd, {timeout})`：通道失败就退回一次性 `adb shell` 重发，
  两条都失败才抛错（不能静默）。
- `input swipe` 会阻塞到滑动结束，而通道超时是固定 4s，2.5s 的长滑动加上 adb 开销非常贴边，
  一旦超时就把这条滑动判成失败。改为按滑动时长放宽（`dur + 6000`）。
- 顺便：`ui/screen.js` 在每次输入后**立刻补一帧**（轮询只有 2fps，等下一拍最多 500ms，
  点完看着像没反应）；补帧与轮询之间用 `_grabbing` 互斥，不会打出双倍帧率。

**为什么之前没被拦**：`grep -rn "ScreenView\|screen.js\|_toDevice" test/*.js` 零命中 ——
画面/输入这块前端逻辑**完全没有测试**。这次补了 13 个用例（`classifyGesture` 用上面探针的
真实数据当夹具，加一条静态护栏断言「必须设 `draggable=false` 且 `pointerdown` 里
`preventDefault`」，防止以后被顺手删掉）。

**版本处置**：17.1 / 17.2 与后端兜底都在 `0.2.5`，纯前端 + 服务端脚本改动，覆盖安装即可。

### 附：已按真机实测校正的参数（非偏差，属对齐）

- `buildArgs`：`-no-window -no-audio -no-boot-anim -gpu off -accel on -port <port> -no-snapshot-save`（`-gpu` 见偏差 5；`-accel off` 被此版本 emulator 拒绝，见偏差 5 附带结论）。
- `BOOT_TIMEOUT_MS = 180000`（**≥ 实测冷启动 65s**，含 2.7 倍余量）。
- `cmd/main` 健康门限 `HEALTH_TIMEOUT = 20s`（`/api/health` 200 后 `start` 才 exit 0），幂等：已在跑且健康 → 直接 `0`。
- 内存/核数按真机 4 核 / 2GB 基线：`DEFAULT_SETTINGS` `memoryMB=2048`、`cores=2`（`0` 时自动：内存取物理 1/4 封顶 4096，核数 `min(4, 核数/2)`）。
- `AVD` 1080x1920 / density 420 / `disk.dataPartition.size=4G`。

---

## 3. 自检记录

### 3.1 语法与加载
```
node --check  core/*.js server/**/*.js ui/*.js build/gen-*.js   → 全部通过（0 失败）
node -e "require('./server/config')"                            → OK
require-graph（26 个模块全量 require + buildContext/buildRouter）→ REVIEW_OK
```

配置自检输出：
```
SYSTEM_IMAGE       = { apiLevel: 34, tag: 'google_apis', abi: 'x86_64' }
SYSTEM_IMAGE_DIR   = system-images/android-34/google_apis/x86_64
imageTag           = google_apis
platform-tools     sha256=d230f138...  marker=platform-tools/adb
emulator           sha256=0127e7c7...  marker=emulator/emulator
system-image       sha256=783a4013...  marker=system-images/android-34/google_apis/x86_64/system.img
```

### 3.2 运行时接口（本地 `TRIM_PKGVAR=/tmp/apkstart-r2 TRIM_APPDEST=$PWD`）
```
GET /api/health   → {"app":"apkstart-fnos","status":"ok","version":"0.1.0",
                     "pid":27249,"uptimeSec":0,"node":"v22.22.2"}
GET /api/status   → {"runtime":{"deployed":false,"phase":"idle"},"emulator":"stopped",
                     "adbConnected":false,"foregroundPackage":null,"foregroundDetail":null,
                     "screen":null,"kvm":{"available":false,"writable":false},"bootMs":null,
                     "rssMB":null,"error":null}
GET /api/apps     → []
GET /api/runtime/status → {deployed:false,adbOk:false,emulatorOk:false,imageOk:false,
                           kvm:{available:false,writable:false,group:""}}
GET /api/settings → 全量默认值，emulator.imageTag = "google_apis"，
                    emulator.disableBluetooth = true（偏差 9）
PUT /api/settings {"emulator":{"disableBluetooth":false}} → 200 深合并生效
                    （gpu/port 等其余字段保持不变），写回 settings.json 后可读回 false
GET /            → 200 text/html 6581 B；/style.css 200；/app.js 200；/images/icon_64.png 200 image/png
```
错误语义（全部中文 `{code,message}`）：`/api/emulator/start` → 503 `RUNTIME_NOT_READY`；`/api/apps/install` → 503 `EMULATOR_DOWN`；`/api/screen/tap` → 503 `EMULATOR_DOWN`；坏 JSON → 400；`/api/nope` → 404；坏 ZIP 上传 → 400「文件不是有效的 APK（缺少 ZIP 文件头）」；`.apks/.xapk` → 422 `UNSUPPORTED`。

APK 解析实测（自建最小 APK）：
```
{"uploadId":"up_...","package":"com.example.demo","label":"阅读","versionName":"3.2.1",
 "versionCode":3210,"minSdk":21,"targetSdk":33,
 "launchActivity":"com.example.demo.MainActivity","abis":[],"armOnly":false,
 "sizeBytes":1161,"iconDataUri":""}
```

### 3.3 arm64-only 分支单元验证
```
code = UNSUPPORTED
msg  = 当前运行时镜像不含 ARM 翻译层，暂不支持 arm64-only 应用（P1 将支持可切换镜像）
上传暂存已清理 = true，临时文件已删除 = true                      → PASS
```

### 3.4 AVD 与启动参数验证
```
config.ini: image.sysdir.1=system-images/android-34/google_apis/x86_64/
            abi.type=x86_64 / hw.cpu.arch=x86_64 / tag.id=google_apis
            tag.display=Google APIs / PlayStore.enabled=no
            1080x1920 / density 420 / disk 4G / gpu off（hw.gpu.enabled=no / hw.gpu.mode=off）
buildArgs(KVM ok)   = -avd apkstart -no-window -no-audio -no-boot-anim -gpu off -accel on  -port 5554 -no-snapshot-save -memory 2048 -cores 2
buildArgs(无 KVM)   = ... -accel off ...（此版本 emulator 会拒绝，运行强依赖 /dev/kvm，见偏差 5）
adb serial          = emulator-5554（不是 127.0.0.1:5554，见偏差 6）
spawn 环境 ANDROID_ADB_SERVER_PORT = adb 客户端 ANDROID_ADB_SERVER_PORT = 5044（SAME=true）
tag 由 google_apis_playstore 切到 google_apis → 旧 userdata 自动清除 = true
BOOT_TIMEOUT_MS = 180000（≥ 实测 65s）
```

### 3.5 `cmd/main` 生命周期（`TRIM_PKGVAR=/tmp/apkstart-cmd2`）
```
status(before) rc=3 → start rc=0 → status rc=0 → start(再次, 幂等) rc=0
→ curl /api/health 200 → stop rc=0 → status(after) rc=3          ✅
```

### 3.5a 假成功防护验收（端口被第三方占用，`TRIM_SERVICE_PORT=8899`）
用一个「同样返回 200 但不属于我们」的假服务占住 `0.0.0.0:8899`：
```
$ node -e "http.createServer((q,s)=>s.end('{\"ok\":true}')).listen(8899,'0.0.0.0')"
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8899/api/health   → 200（别人的）

$ TRIM_SERVICE_PORT=8899 cmd/main start
ApkStart 启动失败：服务进程已退出，健康检查未通过。下面是日志尾部（.../logs/service.log）：
[..] 启动 node=... port=8899
[..] 已拉起源码进程 pid=27105，等待健康检查（最多 20s）
[..] 端口 8899 已被占用，请在 Web 控制台的设置里改用其他端口，或释放该端口后重启 ApkStart。
端口 8899 已被占用，请在 Web 控制台的设置里改用其他端口，或释放该端口后重启 ApkStart。
[..] 进程已退出，启动失败（健康检查未通过）
rc=1                                                            ✅（旧实现这里给 rc=0）
```
杀掉占用者后同一命令：
```
$ cmd/main start      → rc=0
$ cat /tmp/apkstart-occ/service.pid              → 27249
$ curl 127.0.0.1:8899/api/health
  {"app":"apkstart-fnos","status":"ok","version":"0.1.0","pid":27249,...}   ✅ app 与 pid 均命中
$ cmd/main start      → rc=0（幂等）
$ cmd/main status     → rc=0
$ cmd/main stop       → rc=0
$ cmd/main status     → rc=3
$ curl 127.0.0.1:8899/api/health → 连接失败（端口已释放）        ✅
```
> 注：首次复现时假服务绑在 `127.0.0.1:8899`，而本服务绑 `0.0.0.0:8899`，Linux/macOS 允许二者共存，故未触发 `EADDRINUSE`；改用 `0.0.0.0` 绑定后才复现真实场景。

### 3.5b 升级 / 配置脚本生命周期（`TRIM_PKGVAR=/tmp/apkstart-upg`）
```
config_init rc=0 → config_callback rc=0                       （幂等空操作）
upgrade_init（服务未运行）rc=0，跳过停止
main start rc=0
upgrade_init（服务运行中）rc=0 → 服务已停（service.pid 已删）
                              → settings.json.bak 内容与升级前一致
upgrade_callback rc=0（复用 20s 健康轮询启动成功）→ bak 已清理
main status rc=0
—— 失败回滚路径 ——
TRIM_APPDEST=/nonexistent upgrade_callback → rc=1，settings.json 已还原为升级前内容 ✅
```

### 3.6 图标
`build/gen-icons.js` 生成 4 个 PNG，magic `89504e470d0a1a0a` 校验通过；`file` 报告 `PNG image data, 64x64 / 256x256, 8-bit/color RGBA, non-interlaced`。

### 3.7 打包（`bash build/pack.sh --version 0.1.0`）
```
dist/apkstart-fnos_0.1.0_x86.fpk   90722 B
sha256  cee439f852e7e95851c8c75475304fa585897c43a3c72617e88a2febc791f21c
tar -tzf → 62 条目，顶层 apkstart-fnos/（ARCH §7.1 步骤 8：tar -C stage <appname>）
           （较 83711 版 +1：新增 app/server/service/foreground.js，见偏差 9）
cmd/ 9 个脚本全部 -rwxr-xr-x（main / install_init / install_callback / uninstall_init /
  uninstall_callback / upgrade_init / upgrade_callback / config_init / config_callback）
manifest: platform=x86；无 os_min_version、无 depend；checkport=false；
          disable_authorization_path=true（见偏差 3）
          checksum=cbc497e5a23e7950c9d25321f10952aea5ba30e320585ccbd72c97fb955516b3
          （独立复算一致：CHECKSUM_OK；较上一版变化，因为本次改了 server/service/foreground.js 与 installer.js）
包内代码核验：app/server/service/emulator.js 含 `serial: \`emulator-${EMULATOR_PORT}\``、
  `ANDROID_ADB_SERVER_PORT: process.env.ANDROID_ADB_SERVER_PORT || '5044'`、
  `_effectiveGpu`、`if (!this._child) throw`、`async _postBootHardening()`（L222）、
  `await this._postBootHardening()`（L425，在置 running 之前）、
  `const disableBluetooth = opts.disableBluetooth !== false`；app/server/config.js `gpu: 'off'`
  + `disableBluetooth: true`；app/server/service/foreground.js 已入包，含
  `topResumedActivity` 五字段解析（见偏差 9b）+ `parseSystemDialog`（ANR / 崩溃弹窗，
  见偏差 12）+ `waitForPackage` 默认 `timeoutMs = 12000`（偏差 11）；
  app/server/service/installer.js 两处调用显式传 `{ timeoutMs: 12000 }`；
  cmd/main 含 `-s "emulator-5554" emu kill`
dist/fnpack.snippet.json: platform=["x86"]，packages.x86.sha256/size 与上一致（cee439f8… / 90722）；
  service_port="8890"（字符串）、install_type=""、download_url 指 Release 资产、
  补 maintainer_url="https://github.com/RoutineMiku"、distributor_url="https://github.com/TaroCats/apkstart"，
  删掉空数组 preview_urls（见偏差 10）；
  app 条目 16 个 key 的**名称与顺序**与参考源 apps.huitai 完全一致（node 断言 `===` 为 true，缺 0 多 0）；
  icon_url/readme_url 指 raw.githubusercontent.com/TaroCats/apkstart/main/…（见偏差 8）；.sha256 已同步
app/ui/config: {".url":{"apkstart-fnos.main":{...,"type":"url","port":"8890","url":"/"}}}
包内 app/server/config.js tag='google_apis'；cmd/install_init imageTag="google_apis"   ✅
```
> macOS 上 `tar` 为 bsdtar，跳过 `--owner/--group/--mtime` 可复现固定（CI 的 ubuntu-latest 为 GNU tar，会启用）。属已知环境差异，不影响功能。

### 3.8 零第三方依赖
`core/`、`server/`、`ui/` 的非相对 `require` 仅 `child_process, crypto, fs, http, https, os, path, stream/promises, url, zlib`。`require('electron')` 仅出现在未参与 fnOS 打包的上游遗留脚本（`build/render-logo.js`、`src/`、`test/`）。

### 3.9 开机后加固与前台解析单测（`node test/fnos-unit.js`，已并入 `npm test`）
```
[emulator.js / 开机后加固] 6 条：计划为 4 条命令且次序为 pm disable → pm disable-user
  → am force-stop → settings；pm disable 必须早于 disable-user；disableBluetooth=false → 空计划；
  缺省 undefined 按 true（兼容旧 settings.json）；parseDisabledPackages 处理 \r\n/空行/
  非 package: 行/空输入
[foreground.js / 真实前台解析] 17 条：**夹具逐字取自真机原文**（见偏差 9b）——
  topResumedActivity= 两行/单行、只有 ResumedActivity: 一行、旧系统 mResumedActivity: 兼容、
  topResumedActivity 优先于 ResumedActivity、u10 两位数 user id、
  mCurrentFocus=Window{...}、mFocusedApp=ActivityRecord{...}、window dump 取 mCurrentFocus、
  空输入/只有无关行 → null 不抛错、isSystemSurface 正负例、
  pickForeground 优先级与退化、弹窗抢焦点 → com.android.bluetooth + systemSurface=true、
  桌面占前台 → nexuslauncher + systemSurface=true
[foreground.js / ANR 与崩溃弹窗] 5 条（偏差 12，夹具逐字取自真机原文）：
  `Application Not Responding: com.android.systemui` → source=dialog/systemSurface=true；
  `Application Not Responding: system` → 归一成 android；
  `Application Error: com.example.boom` → 同样识别；
  普通焦点窗口不会被误判成弹窗；
  弹窗优先级高于 resumed（resumed 仍是 launcher 时也如实报弹窗）
[foreground.js / waitForPackage 轮询] 4 条：桌面→应用 第 2 次采样命中即停；
  弹窗一直占前台 → 超时返回弹窗包名（绝不返回期望包名）；adb 报错 → null 不抛错；
  显式 timeoutMs 跑满窗口且窗口内多次采样（默认 12000 的回归护栏）
[foreground.js / current() 采样命令] 7 条：采样命令必须含 topResumedActivity（命令级拦截本次回归）、
  窗口命令覆盖 mCurrentFocus/mFocusedApp、真机原文端到端采样返回包名（不是 null）、
  Activity 栈采不到时退化到窗口焦点、**第一次采样必须是 window 焦点**、
  命中弹窗后不再多打一次 dumpsys、焦点采样抛错时兜住仍用 Activity 栈返回应用

[xserver.js / 硬件 3D X display] 16 条：`-interface 127.0.0.1` 必带、`-hw3d`/`-drinode` 必带、
  `-SecurityTypes None` 只绑回环、display 首参、`parseDisplayNum`/`socketPathFor`/`parseReadyLog`/`parseBindConflict`、
  `-xkbdir` 透传与 `pickXkbDir` 优先级、`pickXkbBinCwd` 找打包根、`findXkbcompBin`、`ensureXkbRoot` 造 xkbcomp 软链、
  `cleanStaleDisplay` 清死 lock / 不被 pid 复用卡死、`parseFatalError`
[gpu.js / -gpu 模式裁决] 9 条：off、auto+全齐→host、auto 无 X→off、auto 无 render node→off、
  显式 host 无 X 降级、显式 swiftshader 无 X 也降级、显式 host 齐全尊重、gpuAutoEnable=false、未知模式回落

[fnos-unit] 结果：96 通过，0 失败
npm test 全链：run-tests 39 + engine-test 24 + auto-test 3 + fnos-unit 96 = 162 通过，0 失败
```

0.2.3 / 0.2.4 新增的 18 条用例（端口同源与探测、xattr PAX 兜底、AVD 回收、adb HOME、emulator cwd）都在这一组里。

---

## 4. 遗留与已知限制

1. **无 KVM 时不可用（不只是慢）**：此版本 emulator 拒绝 `-accel off`（需 `ANDROID_I_WANT_MY_TCG=yes`），因此本移植版**强依赖 `/dev/kvm` 可读写**（包用户属 `kvm` 组 + 安装期 `all.editor` 权限）。见偏差 5 附带结论。
2. **arm64-only 应用不支持**：见偏差 2，P1 提供可切换镜像（含 native bridge 的镜像 + 有窗口/或已授权镜像方案）。
3. **中文输入**：P0 仅 ASCII（`adb shell input text` 限制），UI 提示「暂仅支持英文数字」；中文需自建 IME（P1，ARCH §9-A3）。
4. **`.apks` / `.xapk`** 返回 `UNSUPPORTED`（P1-3，接 `adb.installMultiple` 即启用）。
5. **打包可复现**：macOS 本地为 bsdtar，未固定 owner/mtime；CI 上生效。
6. **未做真实 fpk 安装**：本次按指示**未** SSH 部署到 10.31.0.4，落地安装验证留待团队后续真机步骤。
7. **蓝牙不可用**：无头模拟器缺 netsim/packet streamer，蓝牙 HAL 必然崩溃并弹窗抢前台，已在开机后自动禁用（偏差 9）。若要蓝牙调试，把 `emulator.disableBluetooth` 设为 `false` —— 但会重新出现崩溃弹窗。
8. **`start` / `install` 接口最坏耗时可到 ~12s**：为覆盖软件渲染下 splash→main 的 4~10s 切换，`waitForPackage` 窗口放宽到 12s（偏差 11）。应用在前台时命中即返回（通常 <1s），只有「应用始终没到前台」或「被弹窗占住」时才跑满窗口。前端按钮已按长请求处理（有 loading 态）。

---

## 5. 自审结论

- 文件清单：ARCH §2.1–2.5 全部落地（`core/` 7、`server/` **19**（+`foreground.js`）、`ui/` 7、`fnos/` 16、`build/` 4 + workflow 1）。
- API 契约：22 条路由与 ARCH §3.3 表格逐条核对一致（路径、方法、成功体字段、错误码）。
- manifest 契约：与目标机 6 个真实包逐字段对齐（`platform=x86`，无 `os_min_version`/`depend`，补 `checkport`/`disable_authorization_path`）。
- `cmd/` 生命周期：真实包 10 项中除 `common`（无共享逻辑需求，见偏差 3 说明）外 9 项齐备，全部 0755；`upgrade_*` 已实测正常与回滚两条路径。
- 符号一致性：**26** 个模块全量 `require` 无循环依赖/缺失导出；`buildContext`/`buildRouter` 可正常构建。
- 脚本契约：`cmd/main` 0/3 返回码 + 20s 健康门限 + 幂等；全部 `cmd/*` 0755。
- 假成功防护：`/api/health` 带 `app`+`pid` 身份；`health_ok()` 校验响应体身份并与 `service.pid` 比对；`listen` 失败必 `exit(1)` 且打印中文可执行建议；进程提前退出即 `tail` 日志并 `return 1`。已用「第三方占端口且返回 200」场景实测复现并验证修复（见 §3.5a）。
- adb 链路：serial 统一 `emulator-5554`，spawn 环境与 adb 客户端 `ANDROID_ADB_SERVER_PORT` 同值 5044（实测 `SAME=true`）；`_waitBoot` 进程提前退出立即失败，超时信息带 `进程存活` + `adb devices` 现场（见偏差 6/7）。
- 镜像与安全语义：`google_apis` 全链路一致；arm64-only 显式 4xx 中文原因。
- 弹窗抢前台：开机后自动 `adb root` + `pm disable com.android.bluetooth`（持久，非仅 `disable-user`）+ `force-stop` + `settings put global bluetooth_on 0`，失败只记日志不影响启动；前台包名改为 `foreground.js` 五字段优先级解析（`topResumedActivity` → `ResumedActivity` → `mResumedActivity` → `mCurrentFocus` → `mFocusedApp`），`start` 接口返回 `started` + `foregroundNow` + `foregroundIsApp`，不再谎报 `foreground:true`（见偏差 9 / 9b）。
- 启动误报（偏差 11）：`waitForPackage` 默认窗口 4s → **12s**（软件渲染下 splash→main 要 4~10s），`installer.js` 两处调用显式传值。真机验收：start 耗时 14793ms，`foregroundNow` 直接是应用包名。
- ANR / 崩溃弹窗（偏差 12）：`current()` 改为**先窗口焦点、后 Activity 栈**，新增 `parseSystemDialog()` 识别 `Application Not Responding:` / `Application Error:` 弹窗窗口（`system` 归一成 `android`），弹窗优先级高于 resumed。真机验收：`mCurrentFocus=Window{33d43fa u0 Application Error: com.google.android.bluetooth}` 时返回 `{"foregroundPackage":"com.google.android.bluetooth","activity":"","source":"dialog","systemSurface":true}`，没有再把桌面谎报成前台。
- fnpack：补 `maintainer_url` / `distributor_url`，删掉空 `preview_urls`；`platform` / `packages` 保持单元素 `x86`（无 arm 产物，不跟随参考源加 arm），见偏差 10。
- 单测：`npm test` 全链 **162 通过 0 失败**（run-tests 39 + engine-test 24 + auto-test 3 + `test/fnos-unit.js` 96）。前台解析与弹窗识别的夹具**全部逐字取自真机 dump**，并有「采样命令必须含 topResumedActivity」「第一次采样必须是 window 焦点」的命令级断言，Android 14 null 回归与 ANR 谎报都可在不连真机时被拦住（见偏差 9b / 11）。0.2.3/0.2.4 补的端口与 AVD/HOME/cwd 用例走「真起监听进程 / 真杀进程 / 真 mkdir」而不是只断言源码，`netstat -ltn` 那条假修复就是被这类用例当场抓出来的。

**IS_PASS: YES**
