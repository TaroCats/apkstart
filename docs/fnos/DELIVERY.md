# apkstart → 飞牛 fnOS fpk 交付报告

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/TaroCats/apkstart |
| 目标平台 | 飞牛 fnOS（x86，KVM） |
| 产物 | `dist/apkstart-fnos_0.1.0_x86.fpk` |
| 大小 | 90,722 B |
| sha256 | `cee439f852e7e95851c8c75475304fa585897c43a3c72617e88a2febc791f21c` |
| manifest checksum | `cbc497e5a23e7950c9d25321f10952aea5ba30e320585ccbd72c97fb955516b3` |
| 包内条目 | 62 |
| fnDepot 元数据 | 仓库根 `fnpack.json`（sha256 `158d0ff8…`），与 `dist/fnpack.snippet.json` 逐字一致 |
| 真机验收环境 | `root@10.31.0.4`，验证端口 18890 |

### 已发布版本（GitHub Releases，由 `release.yml` 构建）

| 版本 | 产物 | 大小 | sha256 | 发布时间 |
|---|---|---|---|---|
| `0.2.0` | `apkstart-fnos_0.2.0_x86.fpk` | 99,027 B | `ec0f9581d8e5fec2e5393192cad76cf59a51af4c0d753316ea837c1ef37723af` | 2026-11-14T04:37Z |
| `0.1.0` | `apkstart-fnos_0.1.0_x86.fpk` | 90,722 B | `cee439f852e7e95851c8c75475304fa585897c43a3c72617e88a2febc791f21c` | 2026-11-13T20:16Z |

> 两条 release 同时保留在仓库根 `fnpack.json` 里（`gen-fnpack.js` 是**增量合并**，不是覆盖），
> `0.1.0` 可随时回滚下载。`0.2.0` 的体积差异来自 GPU 改造新增的
> `service/xserver.js` + `service/gpu.js` 与 `render`/`video` 组声明。
>
> **版本口径**：本文档「v0.1」指首个 fpk 包 `0.1.0`；「v0.2」指 GPU 改造版 `0.2.0`。
> 上游 apkstart 自身的 `0.2.7` 是另一条号，与 fpk 版本无关；`server/config.js` 的 `VERSION`
> 默认值仅在未注入 `APKSTART_VERSION` 时兜底，`pack.sh` 会在计算 checksum 前注入实际版本。

一句话结论：**四阶段全部落地，fpk 已在真实 fnOS 上按 fpk 生命周期契约完成端到端安装、运行、升级、卸载验证；CI 与 fnDepot 发布元数据齐备。** 三项依赖外部条件（App Center 图形界面、真实 Release 推送、fnDepot 客户端收录）无法在本机验证，已在文末单列。

---

## 阶段 1 · 源码分析

### 改动
无代码改动，只读梳理。产出 `docs/fnos/project-analysis.md`（加上 `recon.md`、`class-diagram.mermaid`、`sequence-diagram.mermaid`）。

### 结论要点
- **三段式架构**：Node 22 HTTP 服务（`server/index.js`）→ 纯 JS APK 解析层（`core/`，零 native 依赖）→ adb 作为**唯一控制面**；Android 侧以无头模拟器承载（`runtime/emulator`）。
- **控制面单一性**是移植的关键抓手：所有设备操作都收敛为 `adb shell` 调用，因此 fnOS 侧只需保证「模拟器能起来 + adb 能连上 + 端口能通」，业务层几乎不用改。
- **原项目的运行时假设**（Electron 外壳、用户目录写数据、固定 5554/5037 端口、GPU 加速）正是移植中需要逐条重写的地方。

### 验证
分析结论与后续改造逐条对应：`recon.md` 中列出的假设，在阶段 2 均以显式偏差（`docs/fnos/IMPL.md` 偏差 1–12）落地。

---

## 阶段 2 · fpk 改造

### 改动

**目录结构（新增 `fnos/`，构建时装配为 fpk 布局）**
```
fnos/
├── manifest.in          # 模板，构建时生成无扩展名的 manifest
├── ICON.PNG             # 64×64
├── ICON_256.PNG         # 256×256
├── cmd/                 # 9 个生命周期脚本，全部 0755
│   ├── main  install_init  install_callback
│   ├── uninstall_init  uninstall_callback
│   └── upgrade_init  upgrade_callback
│   └── config_init  config_callback
├── config/
│   ├── privilege        # {"defaults":{"run-as":"package"},"join-groups":["all.editor","render","video"]}
│   └── resource         # port 8890 / memory_mb 4096
└── wizard/{install,uninstall}
```

**manifest（真实词表，非猜测）**
- `platform=x86`（fnOS **不存在 `x86_64` 这个取值**）
- `checkport=false`（端口自检会误判 8890 已占用）、`disable_authorization_path=true`
- 不写 `depend`（Node 与 adb 随包自带，不依赖系统包）
- `checksum` 由 `build/gen-manifest.js` 计算：递归收集除 `manifest` 外全部文件 → 按相对路径排序 → 逐行 `<sha256>  ./rel` → 整体再 sha256

**启动/停止脚本（`cmd/main`）**
- `start`：轮询 `/api/health` ≤20s，**健康检查验身份**——`statusCode===200 && body.app==='apkstart-fnos' && body.pid===PIDFILE`，避免「端口上有个别的服务」造成假成功；`stop`→0；`status` 运行中→0 / 未运行→**3**；全部幂等。

**依赖项**
- Node 22、adb、emulator 全部来自包内 `app/`，安装后落到 `target/`；运行期无 `apt` 依赖。

**数据根口径（用现场统计定死）**
- 扫描目标机 20+ 真实应用：`TRIM_PKGVAR` 出现 **325** 次，`TRIM_APPDATA` **8** 次 → 统一取 `TRIM_PKGVAR → TRIM_APPDATA → $HOME/.apkstart`。

**打包链**
- `build/pack.sh --version X` → 生成 manifest → 装配 `apkstart-fnos/` → `tar.gz` → 改名 `apkstart-fnos_X_x86.fpk`。
- `build/gen-fnpack.js` 从 manifest 生成 fnDepot 元数据（不参与包内容，改它不会让 checksum 漂移——这一点在调试中差点造成误判）。

### 验证
- 包结构与 fpk 规范自检：62 条目、9 个 cmd 全 0755、顶层目录 `apkstart-fnos/`、两级图标齐全。
- manifest checksum 独立复算：`find . -type f ! -name manifest | sort | xargs shasum -a 256 | shasum -a 256` → 与 manifest 内 `cbc497e5…` 一致。
- 单元测试：`npm test` 全链 **105 通过 0 失败**（run-tests 39 / engine-test 24 / auto-test 3 / fnos-unit 39）。

---

## 阶段 3 · 真机部署与功能验证

### 改动（被真机暴露出来的 3 个产品级问题）

1. **权限链**：`/dev/kvm` 是 `root:all.editor 0660`。解决方式不是 `usermod`，而是 `config/privilege` 的 `join-groups:["all.editor","render","video"]` 让 fnOS 在安装期把包用户加进去（`render`/`video` 是 v0.2 为 GPU 加的，分别供 `renderD128` 与 `card0`）。
2. **图形渲染**：v0.1 默认 `-gpu off`，实测开机 30.9~31.3s。~~`/dev/dri/renderD128` 是 `root:render 0660`、组内只有 `marvis-app`，包用户拿不到 → `-gpu off` 是权限模型下的确定结论~~ —— **此归因已在后续实测中证伪**：权限补上后仍需「带硬件 3D 的 X display」，v0.2 已把该能力做成可选（默认 `gpu: 'auto'`，−12.0%）。见下节「补充验证：GPU 加速到底卡在哪」。
3. **前台检测两处修复（v7/v8）**
   - **P1**：`POST /api/apps/:pkg/start` 把刚启动成功的应用报成桌面。根因 `waitForPackage` 默认 4s，`-gpu off` 软渲染下 splash→main 切换慢，末次采样落在 launcher。改 12s 并在 `installer.js` L140/L177 显式传参。
   - **P2**：ANR / Application Error 弹窗匹配不上。Android 14 弹窗形如 `mCurrentFocus=Window{7061971 u0 Application Not Responding: com.android.systemui}`，**没有 `pkg/activity`**，且此时 `topResumedActivity` 仍是下方 launcher —— 只看 resumed 分支必然谎报。新增 `parseSystemDialog` + 两条弹窗正则，采样顺序改为「先窗口焦点（弹窗命中即返回）→ 再 resumed → 再 focus」，`pickForeground()` 同步。

### 验证（v8 冻结包，全部在 10.31.0.4 实跑）

| 验证项 | 结果 |
|---|---|
| 包上传后 `sha256sum` | 与本地一致 |
| 按 fpk 契约手工安装 | `KVM_WRITABLE` / `DEPLOY_OK` |
| 服务启动 `cmd/main start` | rc=0，新 pid 2539199 |
| `GET /api/health` | 200，含 `app=apkstart-fnos` 与真实 `pid` |
| `POST /api/emulator/start` | `bootMs=32152`、`adbConnected=true` |
| APK 安装与解析 | 成功 |
| `POST /api/apps/:pkg/start` | `foregroundNow=com.simplemobiletools.flashlight`、`foregroundIsApp=true`、**14793ms** |
| `GET /api/screen/frame` | 200，PNG 1080×1920，目视干净桌面无弹窗 |
| `POST /api/screen/tap` | `{"ok":true}` |
| `POST /api/emulator/stop` | `qemu-system-x86_64` 进程归零 |
| P2 弹窗分支（意外复现） | 弹窗真出现：`Application Error: com.google.android.bluetooth`，接口返回 `{"foregroundPackage":"com.google.android.bluetooth","activity":"","source":"dialog","systemSurface":true}` |
| `upgrade_init` / `upgrade_callback` | 均 rc=0；停服务 + 备份 `settings.json.bak` + **保留 `runtime/` 与 `.deployed`**（不重下 6.6 GB），回调后健康检查通过 |
| `uninstall_init` / `uninstall_callback` | 均 rc=0；无残留进程；默认不 purge，`runtime/` 5.1G、`avd/` 1.5G、`settings.json` 全保留，18890 释放 |
| `cmd/main status` | 运行中 rc=0 / 停止 rc=**3** |
| `cmd/main stop` | rc=0 |

补充说明：一次「应用拉不起来 + systemui ANR」被误判成产品 bug，查明是 Docker 加载镜像把 load average 顶到 30+；负载回落后 `bootMs=32152` 恢复正常。已在 `IMPL.md` 记录，防止后续再误判。

---

## 阶段 4 · CI 与 fnDepot

### 改动
- `.github/workflows/release.yml`：tag `v*` 或 `workflow_dispatch` → Node 22 → 解析版本 → `bash build/pack.sh --version …` → 写 sha256 到 step summary → 上传 artifact（`dist/*.fpk`、`*.sha256`、`fnpack.snippet.json`）→ tag 时 `softprops/action-gh-release@v2` 挂 Release → **`Sync fnpack.json`** 把 `dist/fnpack.snippet.json` 提交回仓库根（无变化则跳过）。

**`Sync fnpack.json` 里两个只有真跑才会暴露的坑（都已修，并用临时 bare 仓库实跑复现验证）**
1. **判空写法**：`git diff --quiet -- fnpack.json` 对**未跟踪**文件返回 0（无差异），首次同步会误判「无变化」直接跳过，永远提交不上去。改为「先 `git add` 再 `git diff --cached --quiet`」。实测：未跟踪场景旧写法返回 0（误判）、新写法返回 1（正确提交）。
2. **detached HEAD**：tag 触发的 checkout 是 detached HEAD、没有 upstream，`git push` 直接报 `fatal: You are not currently on a branch.`。改为先 `git fetch origin $BRANCH` → `git checkout -B $BRANCH origin/$BRANCH` → `git push origin HEAD:$BRANCH`（`BRANCH` 取 `github.event.repository.default_branch`；`dist/` 在 `.gitignore` 内，切分支不会丢产物）。

三条路径实跑结果：内容已一致 → `IDEMPOTENT_SKIP`；版本变化 → 提交并 `PUSH_OK`，远端 `main` 上 `fnpack.json` sha256 与本地一致；再跑一次 → 回到 `IDEMPOTENT_SKIP`。
- `.github/workflows/ci.yml`：`windows-latest`，Node `[20,22]` 矩阵，`npm ci` → `npm test` → PowerShell 指针钩子断言 `POINTER_HOOK_LOGIC_OK`。
- 仓库根 `fnpack.json`：fnDepot V2 schema，**逐字段对齐目标机已收录源的原文**，不是照文档猜的。

**fnDepot V2 关键坑（实测得到）**
- 仓库根放 `fnpack.json` 即可被添加为源，仓库名不必叫 FnDepot；
- `platform` 与 `packages` 的 key 都是 `x86`（不是 `x86_64`）；
- `service_port` 是**字符串** `"8890"`；
- `install_type` 是**空串**；
- **不存在 `preview_urls` 键**（不是空数组）—— 写了会被 schema 拒。

### 验证
- `python3 -c "json.load(...)"` → `JSON_OK`
- `diff fnpack.json dist/fnpack.snippet.json` → 完全一致
- `release.yml` 解析出的步骤序列：`Checkout → Setup Node.js 22 → Resolve version → Build fpk → Show sha256 → Upload artifacts → Attach to release → Sync fnpack.json`
- `download_url` 指向 Release 资产路径，`sha256`/`size` 与冻结包一致（`cee439f8…` / 90722）

---

## 补充验证 · GPU 加速到底卡在哪（推翻了阶段 3 的归因）

阶段 3 把「跑不了 GPU」归因为「包用户拿不到 `/dev/dri/renderD128`，所以 `-gpu off` 是权限模型下的确定结论」。这个归因**是错的**，本轮重做了一遍完整实测。

### 逐项排除过程

| 假设 | 实验 | 结论 |
|---|---|---|
| 设备被别的应用占用 | `fuser /dev/dri/renderD128`、同时运行 `Xvnc` 与 qemu | ✗ DRM render node 天然多客户端共享，无独占 |
| 缺 `render` 组 | `usermod -aG render` → 包用户可 `open()` 设备 | 必要条件，但**不充分** |
| 缺 `video` 组（`card0`） | 加入后 `libEGL warning: failed to open /dev/dri/card0` 消失 | 必要条件，仍不充分 |
| dma-buf 堆 / udmabuf | `chmod 666 /dev/dma_heap/system /dev/udmabuf /dev/vhost-*` + 加 `kvm` 组 | ✗ 仍然崩 |
| HOME 不可写（`su` 导致 `HOME=/root`） | 改用可写 `HOME` + `XDG_CACHE_HOME` | ✗ 仍然崩 |
| capability | `setpriv` 分别补 `sys_nice/ipc_lock/dac_override/sys_admin/sys_resource/sys_ptrace` | ✗ 单个都不解决问题；`setpriv` **零 capability** 也能跑 |
| **缺少带硬件 3D 的 X display** | 宿主 `Xvnc`（TigerVNC，不支持 `-hw3d`）→ llvmpipe 软光栅；`Xkasmvnc -hw3d` → Intel | **✓ 这才是真因** |

### 结论

1. 宿主 `/usr/bin/Xvnc`（TigerVNC 1.12）与 `Xvfb` **都不支持 `-hw3d`**；系统里唯一支持的是 KasmVNC 的 `Xkasmvnc`（5.5MB，只存在于别的应用的 mount namespace）。其 40 个动态依赖在宿主 `/lib/x86_64-linux-gnu/` **全部存在**，libc 同版本，可直接搬运。
2. `Xkasmvnc` 必须显式带 `-interface 127.0.0.1`，否则启动即 `vncExtInit: failed to bind socket, is someone else on our -websocketPort?: Address already in use (98)`（与 rfbport 无关，端口其实是空的；照同机 `fygo-browser` 的可用命令行补 `-interface` 后成功）。
3. **无 X 的 headless 路线走不通**：`EGL_PLATFORM=surfaceless` + 无 `DISPLAY` → `Failed to get EGL display` / `Failed to initialize GL emulation`。

### 收益实测（走应用自己的 Node → `spawn()` 路径，不是手工命令行）

| gpu | 采样 `bootMs` | 中位数 | qemu 持有 `renderD128` fd | 客户机适配器 |
|---|---|---|---|---|
| `off` | 31267 / 30908 / 30960 | **30960** | 0 | ANGLE (Google, Vulkan 1.2.0 SwiftShader) |
| `host` | 28621 / 27680 / 27652 / 27604 | **27666** | 6 | **Mesa Intel(R) Graphics (ADL-N)** |

qemu 进程 `Uid: 926`（即包用户 `apkstart-fnos`），日志含 `Selecting Vulkan device: Intel(R) Graphics (ADL-N)` 与 `Graphics Adapter … (Mesa Intel(R) Graphics (ADL-N))`，`/api/status` 返回 `emulator: running / adbConnected: true`。

**净收益 ≈ 3.3s（-10.6%）**。此前一度观察到「root 22s vs off 34s」的 12s 差距，含冷启动与噪声，不可复现；开机主要耗在 Android framework/zygote，不在 GL。

### 决策：v0.2 起默认 `gpu: 'auto'`（`0.2.0` 已发布）

~~不把这个能力做进默认路径~~ —— 第二轮改造已落地，形态与最初设想不同：**二进制不随包携带**（KasmVNC 是 GPL-2.0 强 copyleft，且依赖 `libxfont2`/`libpixman-1-0`/`libunwind8`/`libwebp7`/`libxshmfence1` 等独立 deb），改由运维把 `Xkasmvnc`（+x）投放到 `$TRIM_PKGVAR/runtime/xserver/`。默认 `gpu: 'auto'`：检测到「支持 `-hw3d` 的 X server + `renderD128` 可读写」就上 `-gpu host`，否则安静回落 `off`（与旧版行为一致）；`-gpu host` 启动失败还会自动 `-gpu off` 重试一次。**包体积零增量**，`join-groups` 追加 `render`、`video`。

改造后本机复测（4 组配对，冷启动）：`off` 中位 **23843ms** → `host` 中位 **20979ms**，**−2864ms（−12.0%）**。实施细节与两个真机坑（`Xkasmvnc` 硬编码相对 `.xkbbin/xkbcomp`；X 被信号杀掉遗留 lock 导致「Cannot establish any listening sockets」）见 `IMPL.md`「偏差 5 改造方案（已实施）」。

### 一条方法论教训

用 `setsid … &` 把模拟器丢后台再测，包用户下**必崩**；同一条命令前台跑、或由 Node `spawn()` 拉起则**正常**。初版「包用户下 `-gpu host` 必崩」的结论就是这个测试形态造成的假象，白花了大量时间在权限上。**结论：验收必须走产品真实启动路径，手工命令行只能用于单点排查。**

### 目标机当前状态（v0.2 改造后）

`settings.json` 的 `emulator.gpu` = `auto`、`xserverPath` = `""`；包用户组 `920(apkstart-fnos),44(video),105(render),992(all.editor)`；`$TRIM_PKGVAR/runtime/xserver/Xkasmvnc` 已投放（运维侧动作，非包内文件）；`/tmp/.X9-lock` 与 `:9` socket 在 `stop()` 后不再残留（只剩宿主自己的 `X99`）；无残留 qemu / X server 进程。

---

## 未能在本地验证的三项（如实标注）

1. **App Center 图形界面点击安装**：目标机 `trim_app_center` 无 `install` 子命令，unix socket 直连返回 404 且需鉴权 → 改为**严格按 fpk 契约手工安装**（解包、建 6 个 `/vol2/@app*` 目录、6 条软链、建用户加组、注入 `TRIM_*` 跑 `install_init`/`install_callback`），覆盖了安装脚本与权限链，但没覆盖 App Center 自身的调度逻辑。
2. **fnDepot 客户端实际收录**：需要把仓库真实推到 GitHub Public 并在客户端「添加源」，本地只能证明元数据符合 V2 schema。
3. **真实 tag 触发的 GitHub Actions 实跑**：workflow 结构、脚本、release 步骤均已本地校验，但未经真实 runner 跑过一次。

### 首次发版前必须人工完成的两件事（否则第一次 tag 会踩坑）
1. **把仓库根 `fnpack.json` 一起 `git add` 提交**。它目前是未跟踪状态（`?? fnpack.json`，已 `git check-ignore` 确认未被忽略）。虽然 `Sync fnpack.json` 有能力在首次运行时替你创建，但那样初始入库的 commit 作者会是 bot；人工入库一次更干净，且之后同 tag 重跑能靠 `git diff --cached --quiet` 正确早退。
2. **确认 `main` 没有开启「Require PR / branch protection」**。`Sync fnpack.json` 用 `GITHUB_TOKEN` 直推 `HEAD:main`，若 `main` 有保护规则会被拒、job 变红（属仓库设置层面，不是脚本问题）。另：`GITHUB_TOKEN` 的推送**不会**二次触发 workflow，不存在循环风险。

## 已知备注（不影响验收）
- `isSystemSurface()` 白名单只含 `com.android.bluetooth`，而本镜像蓝牙包名是 `com.google.android.bluetooth`；因弹窗分支直接置 `systemSurface=true`，不影响结果。若后续要精确化可补白名单项。
