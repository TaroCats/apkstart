# apkstart → 飞牛 fnOS fpk 交付报告

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/TaroCats/apkstart |
| 目标平台 | 飞牛 fnOS（x86，KVM） |
| **当前可交付版本** | **`0.2.5`**（见下方发布表首行；本表其余数值是 `0.1.0` 首次交付的基线快照，保留用于对照） |
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
| `0.2.5` | `apkstart-fnos_0.2.5_x86.fpk` | 107,688 B | `283f0ad4327d0a244815f3e06acb662236cdfdf1a28db6be26812790acfccd64` | 2026-11-14T08:32Z |
| `0.2.4` | `apkstart-fnos_0.2.4_x86.fpk` | 105,445 B | `c7a010da3752d5652ea51a5ae72fd88dcdec5b0eae89a62b34586131e0ed84b8` | 2026-11-14T07:28Z |
| `0.2.3` | `apkstart-fnos_0.2.3_x86.fpk` | 102,180 B | `4a3df53b9f000b701cdc6571a61d2b7a87c1d8cca4e7c77b8462b57b755d8166` | 2026-11-14T06:37Z |
| `0.2.2` | `apkstart-fnos_0.2.2_x86.fpk` | 100,452 B | `8b9a7f318bde97c8e085c1e9c709d237bbf75bdd37b55bed5f0018ee2b943e2a` | 2026-11-14T05:55Z |
| `0.2.1` | `apkstart-fnos_0.2.1_x86.fpk` | 99,933 B | `d2219092bc5c80cd8a4b38a5cccc35b73d7b2591919f982dc2711644fe076ae3` | 2026-11-14T05:34Z |
| `0.2.0` | `apkstart-fnos_0.2.0_x86.fpk` | 99,027 B | `ec0f9581d8e5fec2e5393192cad76cf59a51af4c0d753316ea837c1ef37723af` | 2026-11-14T04:37Z |
| `0.1.0` | `apkstart-fnos_0.1.0_x86.fpk` | 90,722 B | `cee439f852e7e95851c8c75475304fa585897c43a3c72617e88a2febc791f21c` | 2026-11-13T20:16Z |

> 七条 release 同时保留在仓库根 `fnpack.json` 里（`gen-fnpack.js` 是**增量合并**，不是覆盖），
> `0.1.0` / `0.2.0` / `0.2.1` / `0.2.2` / `0.2.3` 可随时回滚下载（只有 `0.2.4` / `0.2.5` 既装得上、
> 起得来、模拟器又能真正开机并且**画面可操作**）。
> `0.2.2` 的体积比 `0.2.1` 多 519 B，来源是新增的根级 `app.tgz` 头部与 `cmd/` 两处修正，不是功能增量。
>
> `0.2.5` 同样验过 CI 产物：下载 Release 资产 → `shasum -a 256` = `283f0ad4…`，与 GitHub asset
> digest 逐字一致 → `node build/validate-package.js` → `包结构校验通过: 根 21 条目 / app.tgz 43 条目`
> → 解出 `manifest` 确认 `version=0.2.5`、`ui/config` 确认 `"port":"18990"` → 从 `app.tgz` 里取出的
> `ui/screen.js` / `ui/style.css` / `server/api/screen.js` 与仓库工作区**sha256 逐字一致**
> （`5050fd75…` / `6c4c469e…` / `eec8b0e3…`）。`fnpack.json` 由 CI 自动同步（`2bfbe55`）。
>
> `0.2.4` 同样验过 CI 产物：下载 Release 资产 → `shasum -a 256` 与 GitHub asset digest 逐字一致
> （`c7a010da…`）→ `node build/validate-package.js` → `包结构校验通过: 根 21 条目 / app.tgz 43 条目`
> → 从包里解出 `manifest` 确认 `version=0.2.4` / `port=18990`，解出 `ui/config` 确认 `"port":"18990"`
> → 包内 `LIBARCHIVE.xattr` PAX 头计数 **0**。`fnpack.json` 由 CI 自动同步（`ab3dc7b`）。
>
> **`0.2.2` 的 CI 产物已就地校验过结构**（不是只验本地包）：把 Release 上的
> `apkstart-fnos_0.2.2_x86.fpk` 下回来跑 `node build/validate-package.js`，输出
> `包结构校验通过: 根 21 条目 / app.tgz 43 条目`，sha256 `8b9a7f31…` 与 GitHub 上报的
> asset digest 逐字一致。本地 macOS 包（bsdtar）与 CI 包（GNU tar）**字节不同**，
> 但结构断言一致——这也是把校验放在**产物**上而不是源码上的原因。
>
> `0.2.3` 同样验过：下载 Release 资产跑 `validate-package.js` → `包结构校验通过: 根 21 条目 /
> app.tgz 43 条目`，并直接从 CI 包里解出 `ui/config` 确认 `"port":"18990"`、仓库根 `fnpack.json`
> 的 `service_port` 也是 `18990`（CI 的 Sync 步骤自动提交 `3ec0d3d`）。
>
> `0.2.0` 的体积差异来自 GPU 改造新增的
> `service/xserver.js` + `service/gpu.js` 与 `render`/`video` 组声明。
>
> **`0.2.0` 不要用于 App Center 安装**：它的 `wizard/install`、`wizard/uninstall` 顶层是对象，
> fnOS 侧类型是 `[]trimpkg.WizardPage`，会报 `wizard invalid: json: cannot unmarshal object …` /
> `100610`（详见 IMPL 偏差 13）。`0.2.1` 已修复，包内容 checksum 与 `0.2.0` 只差在 wizard
> 与版本串。`0.2.0` 资产**故意不覆盖**（可能已有用户下载），升级路径是直接装最新版。
>
> **`0.2.1` 也不要用于 App Center 安装**：它把应用代码放在 fpk 根下的 `app/` 目录，而平台只认
> **根级 `app.tgz`**，安装时报
> `failed to decompress app.tgz: … open …/apkstart-fnos-0.2.1-tpk/app.tgz: no such file or directory (code 10107)`
> （详见 IMPL 偏差 14）。`0.2.2` 已改成根级 `app.tgz`。`0.2.1` 资产同样**故意不覆盖**。
>
> **`0.2.2` 能装，但可能起不来**：它把默认端口写死 8890，而目标机的 8890 被 Docker 里的
> uvicorn 长期占用（`uvicorn app.main:app --port 8890`），服务 bind 不上、进程秒退（IMPL 偏差 15）。
>
> **能装、能起来、且画面能操作的只有 `0.2.5`**：`0.2.0` wizard 坏、`0.2.1` 包结构坏、
> `0.2.2` 端口撞车、`0.2.3` 装得上也能起服务但**模拟器开不起来**（同 AVD 遗留占用 / adb HOME
> 不可写 / emulator 继承了不可读的 cwd，见 IMPL 偏差 16）、`0.2.4` 起得来但**画面只能看不能操作**
> （`<img>` 原生拖拽打断手势 + 点击容差用错单位，见偏差 17）。直接装 `0.2.5` 即可——它是
> 0.2.3 端口修正 + 0.2.4 启动链修复 + 0.2.5 输入修复的合集。
>
> **版本口径**：本文档「v0.1」指首个 fpk 包 `0.1.0`；「v0.2」指 GPU 改造版 `0.2.0`；
> `0.2.1` 是修 wizard 的补丁版（顶层改数组）；`0.2.2` 是修包结构的补丁版（`app/` → `app.tgz`）；
> `0.2.3` 是修端口冲突的补丁版（默认 8890 → 18990，端口以 `ui/config` 为单一真源）；
> `0.2.4` 是修模拟器启动链的补丁版（AVD 回收 + adb HOME + emulator cwd，GPU 加速真机跑通）；
> `0.2.5` 是修「画面不能操作」的补丁版（`<img>` 关掉原生拖拽 + 手势判定改用 CSS 像素 + 长按
> 走原地按住 + 输入后立即补帧）。
> 上游 apkstart 自身的 `0.2.7` 是另一条号，与 fpk 版本无关；`server/config.js` 的 `VERSION`
> 默认值仅在未注入 `APKSTART_VERSION` 时兜底，`pack.sh` 会在计算 checksum 前注入实际版本。

一句话结论：**四阶段全部落地，fpk 已在真实 fnOS 上按 fpk 生命周期契约完成端到端安装、运行、升级、卸载验证；CI 与 fnDepot 发布元数据齐备，`0.2.2` 起包结构符合 App Center 的 `app.tgz` 要求，`0.2.3` 起默认端口不再与宿主已有服务撞车，`0.2.4` 起模拟器能真正开机并跑在 GPU 上（`gpu=host`，`adbConnected=true`）。** 用户已通过 App Center 图形界面实际装成 `0.2.3` 并拉起服务，这条外部依赖随之闭环；仅剩 fnDepot 客户端收录未在本机验证，已在文末「验证边界」标注。

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
│   └── resource         # port 18990（由 pack.sh 按 $PORT 注入）/ memory_mb 4096
└── wizard/{install,uninstall}
```

**manifest（真实词表，非猜测）**
- `platform=x86`（fnOS **不存在 `x86_64` 这个取值**）
- `checkport=false`（平台的端口自检对「端口被别的服务占着」只能报错停下，帮不上忙；改成我们自己在 `cmd/main start` 里探测并说明占用者，见 IMPL 偏差 15）、`disable_authorization_path=true`
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
- 单元测试：`npm test` 全链 **138 通过 0 失败**（run-tests 39 / engine-test 24 / auto-test 3 / fnos-unit 72）。

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

### 补充验证：0.2.2 的「等价安装」（修 10107 之后）

App Center 的完整流程（下载 → 解 app.tgz → 落 `$TRIM_APPDEST` → 建桌面入口 → 跑 wizard）无法在本机复现：`trim-cli` 需要 OAuth 交互授权，profile `nas` 只有 `nas.oauth-pending.json`。**没有为此打断用户做授权**，改成按 App Center 的语义在真机上手工重放一遍：

| 步骤 | 结果 |
|---|---|
| 按 `app.tgz` 语义解到临时 `APPDEST` | 顶层解出 `core server ui`，与包内成员逐项一致（无多套一层、无少一层） |
| 入口文件齐备 | `server/index.js`、`server/config.js`、`ui/config`、`ui/index.html` 全在 |
| 以 `TRIM_APPDEST` / `TRIM_PKGVAR` / `TRIM_SERVICE_PORT=28890` 起服务 | `/var/apps/nodejs_v22/target/bin/node` 正常拉起 |
| `GET /api/health` | `200 {"app":"apkstart-fnos","status":"ok","version":"0.2.2","pid":4132607,"node":"v22.23.4"}` |
| `SIGTERM` 收尾 | 优雅退出，无残留 |

两点说明：
- 端口用 **28890** 而不是习惯的 18890——目标机上 18890 已被别的服务监听（`ss -ltn` 可见）。这反映的是机器现状，与 `cmd/main` 的 `checkport` / 健康检查逻辑无关。
- 这**不等于** App Center 全流程通过。它验证的是「包内容按平台语义解出来能跑」，能排除 10107 之后的下一类问题；真正装完仍需在 App Center 里点一次，见文末待办。

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
- `service_port` 是**字符串** `"18990"`；
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

### 目标机当前状态（0.2.5 验证后）

`settings.json` 的 `emulator.gpu` = `auto`、`xserverPath` = `""`；包用户组 `920(apkstart-fnos),44(video),105(render),992(all.editor)`；`$TRIM_PKGVAR/runtime/xserver/Xkasmvnc` 已投放（运维侧动作，非包内文件）；`/tmp/.X9-lock` 与 `:9` socket 在 `stop()` 后不再残留（只剩宿主自己的 `X99`）；无残留 qemu / X server 进程；我此前手工调试留下的 root adb server（`5037`）与 `/tmp` 下的测试部署已清理。

### 0.2.4 模拟器启动链真机验证（2026-11-14）

同一天连做三轮，每轮都以「真实包用户 uid 926 + 服务 → spawn 的产品路径」为准：

| 轮次 | 现象 | 结论 |
|---|---|---|
| 1 | `FATAL Running multiple emulators with the same AVD`（用户报的原文） | 遗留 qemu 占着 AVD；`_releaseAvd` 修好后开机正常（`bootMs` 32s） |
| 2 | 开机成功但 `adbConnected:false`，adb 原文 `Cannot mkdir '/home/apkstart-fnos/.android'` | 包用户无家目录；`pickWritableHome()` 修好后 `adb devices` → `emulator-5554 device` |
| 3 | 一切正常但 `gpu.mode` 永远 `off`（`fallback-after-failure`） | emulator 继承了不可读的 `cwd`（从 `/root` 拉起服务）；`_spawnCwd()` 修好后 `gpu=host(auto-host)` |

第 3 轮的最终现场（**故意**保留原本必失败的环境：服务从 `/root` 启动）：

```
[gpu] 自动检测到硬件 3D X display 与 render node，启用 -gpu host（DISPLAY=:9）
[start] KVM available=true writable=true accel=on gpu=host display=:9 cwd=/vol2/@appdata/apkstart-fnos/tmp
[boot] boot_completed in 27614ms
status: emulator=running  gpu=host(auto-host)  adbConnected=true  bootMs=27614
emulator 日志: vulkan_mode_selected:host gles_mode_selected:host
              Graphics Adapter … (Mesa Intel(R) Graphics (ADL-N))
```

即「GPU 加速」不再只是配置项上的字样。注意事项写进了 IMPL 偏差 16.3：手工重放必须先把
`<AVD>/config.ini` 的 `hw.gpu.mode` 改成 `host`，否则 emulator 按 AVD 里的 `off` 退回 lavapipe，
会跑出「host 其实能用」的假阳性。

### 0.2.5 「画面可操作」真机验证（2026-11-14）

用户报障：「为什么只有画面不能操作？应该是可以操作的」。先证明后端没坏——直打产品接口注入
输入，前后帧 sha256 真的变了（`288e5b9f4a39 → 361b73042802`），于是范围收到前端。

本机没有 Playwright 浏览器，用 `playwright-core`（不下载浏览器）+ 系统 Edge 跑**真实指针
事件**，并在页面里拦 `/api/screen/*`，把「用户做了个手势 → 到底有没有请求发出去」量化。
修复前后（同一台机、同一分辨率、同一套探针）：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 单击 | `tap {539,961}` | `tap {539,961}` |
| **有 3px 手抖的单击** | **0 条（点了没反应）** | `tap {549,968}` |
| **拖拽上滑 400px** | **0 条（滑不动）** | `swipe {539,1589 → 539,334, 196ms}` |
| 拖拽后的单击 | `tap` | `tap`（没被上次拖拽污染） |
| 长按 900ms | `tap`（长按被压成点击） | `swipe {539,961 → 539,961, 902ms}`（原地按住） |
| 很小的真拖拽 20px | 被吞 | `swipe {539,961 → 539,899, 100ms}` |

两个真因（详见 IMPL 偏差 17）：`<img>` 默认 `draggable=true`，拖拽触发原生 HTML5 drag →
`pointercancel` 把 `_dragStart` 清掉，swipe 一条都发不出；点击阈值写成 `dx < 8`（**设备像素**），
而这台机 1 CSS px ≈ 3.14 设备像素，容差实际只有 2.5 个浏览器像素，手抖就被判成 swipe 且被抬到
50ms → `input swipe x y x+3 y 50` 等于没动。

不只验「请求发出去了」，还用画面 sha256 确认**设备端真的动了**（真实 Release 产物
`0.2.5`，展开后按包用户 uid 跑服务）：

| 场景 | 客观判据 | 结果 |
|---|---|---|
| 桌面拖拽上滑 | 画面 PNG sha256 | `1ad36188ba1b → d5574f69387b`（打开应用抽屉） |
| 应用内单击（Flashlight 主开关） | 画面 PNG sha256 | `459f8601fa69 → 86e812326aae →` 再点切回 `9a91aac13d07` |
| 长按桌面 900ms | hash + 停留稳定性 | 变化且稳定 1.2s（弹层停住），`back` 后恢复 |

同一次实例启动链也复验：`[boot] boot_completed in 30896ms`、`gpu=host`、`adbConnected=true`、
服务版本 `0.2.5`（`/api/health`）。

**CI 侧一个小插曲（记下来免得下次重踩）**：`v0.2.4` 首轮 CI 的 `Release` 与 Linux 单测都绿，
两个 Windows job 却红。拉日志看到是**新用例自身的跨平台问题**，不是包的问题：

```
✗ adb 的 HOME 必须可写：包用户没有家目录时不能照抄 process.env.HOME
  HOME 不可用时应回落到 TRIM_PKGVAR：期望 "C:\\Users\\RUNNER~1\\…\\var"，实际 "/nonexistent-root-…/home"
```

用例原本用 `/nonexistent-root-<ts>/home` 造「建不出 `.android` 的 HOME」，在 macOS/Linux 上
`/` 不可写所以必然失败；Windows 上 `/` 就是当前盘根、runner 又有管理员权限，反而真建成了 →
`pickWritableHome()` 合理地返回了它。改成「父级放一个普通文件」（`blocker/home`）后三平台一致。
另有一条同类问题（`/proc/…` 在 Windows 变成 `C:\proc\…` 能真建成）一并修掉，最终
`65679e7` 三 job 全绿。**包的字节没有任何变化**（`pack.sh` 只打 `server/ core/ ui/`，
`test/` 不进包，manifest checksum 与 `v0.2.4` 资产仍逐字一致），因此没有重新发版。

---

## 验证边界（如实标注，2026-11-14 更新）

| 项 | 状态 |
|---|---|
| **真实 tag 触发的 GitHub Actions** | ✅ **已实际跑过七次**（`v0.1.0`～`v0.2.5`），`Release` 与 `CI` 全绿；`Sync fnpack.json` 每次自动提交回 `main`（`8dd063d` / `3ec0d3d` / `ab3dc7b` / `2bfbe55` 分别对应 0.2.2 / 0.2.3 / 0.2.4 / 0.2.5）；`v0.2.4` 首轮 Windows job 红过两次，原因是新用例自身的跨平台假设，包字节未变（见上节） |
| **Release 资产与 sha256** | ✅ `0.2.5` 资产 107,688 B / `283f0ad4…`，与 GitHub asset digest、`fnpack.json` 逐字一致；包内 `ui/screen.js` 等三个改动文件与仓库 sha256 逐字一致；Release body 用 tag 注释正文 |
| **App Center 图形界面点击安装** | ✅ **已闭环**：用户通过 App Center 装成 `0.2.3`，服务被平台拉起监听 `18990`（`/vol2/@appcenter/apkstart-fnos/server/index.js`，`/api/health` 返回 `version 0.2.3`），随后真机报障的正是模拟器启动链——说明安装、解包、服务拉起三环都由平台真实调度过 |
| **0.2.5 通过 App Center 覆盖安装** | ⚠️ 待用户点一次：包结构与 0.2.4 同构（`validate-package.js` 断言一致，根 21 / app.tgz 43），差异只在 `ui/` 两个文件与 `server/api/screen.js`，风险面很小 |
| **画面可操作（点击 / 拖拽 / 长按）** | ✅ 真 Release 产物 + 真实浏览器指针事件验证：手势全部落成请求，且设备端画面 sha256 有对应变化（见「0.2.5 画面可操作真机验证」）；用户侧覆盖安装后可复验 |
| **fnDepot 客户端实际收录** | ⚠️ 未验：需要在客户端里「添加源」指向本仓库 `fnpack.json`，本地只能证明元数据符合 V2 schema |

### 手工安装的等价路径（无 App Center 时）

目标机 `trim_app_center` 无 `install` 子命令，unix socket 直连返回 404 且需鉴权；`trim-cli` 则要 OAuth 交互授权。因此采用两级替代：

1. **严格按 fpk 契约手工安装**（解包、建 `/vol2/@app*` 目录、软链、建用户加组、注入 `TRIM_*` 跑 `install_init`/`install_callback`）——覆盖安装脚本与权限链，但不覆盖 App Center 调度；
2. **按 0.2.2 的语义只重放解包+启动**（见阶段 3「补充验证」）——覆盖「`app.tgz` 原样落到 `$TRIM_APPDEST` 后能跑起来」。

### 发版基础设施现状（已过首次发版，保留为备忘）
1. `fnpack.json` 已入库且由 CI 增量维护，无需人工干预；人工入库的理由（避免 bot 作首个作者）已不适用。
2. `main` 未开启 branch protection —— `Sync fnpack.json` 用 `GITHUB_TOKEN` 直推 `HEAD:main` 一直成功。**若日后给 `main` 加保护规则，这一步会变红**（属仓库设置，不是脚本问题）。`GITHUB_TOKEN` 的推送不会二次触发 workflow，无循环风险。


## 已知备注（不影响验收）
- `isSystemSurface()` 白名单只含 `com.android.bluetooth`，而本镜像蓝牙包名是 `com.google.android.bluetooth`；因弹窗分支直接置 `systemSurface=true`，不影响结果。若后续要精确化可补白名单项。
