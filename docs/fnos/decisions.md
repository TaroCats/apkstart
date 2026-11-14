# 主理人裁决记录（PRD §5 待确认问题）

| # | 问题 | 裁决 | 依据 |
|---|---|---|---|
| Q1 | 控制台鉴权 | **P0 不做登录**，控制台仅监听内网；风险写入交付说明，鉴权列为 P2-1 | 应用中心入口已受 NAS 登录保护；P0 优先保证链路可跑通，避免自建鉴权影响 fnOS 代理访问 |
| Q2 | 运行时交付形态 | **在线包**：fpk 内不含 emulator / 系统镜像，首次部署时联网下载；离线完整包转 P1-8 | GitHub Actions artifact 与 fnDepot 仓库对体积敏感；目标机实测可直连 dl.google.com（HTTP 200，1.7T 空闲） |
| Q3 | 模拟器实例模型 | **单实例共享一台模拟器跑多应用** | 目标机 15 GiB 内存，多 AVD 不现实；与上游 `container.js` 的「同实例切换应用」策略一致 |
| Q4 | `/dev/kvm` 权限 | **`config/privilege` 声明 `join-groups: ["all.editor","render","video"]`**；provision 仍必须做运行时检测，不可用时降级 `-accel off` 并在 UI 明确提示「无硬件加速」 | 目标机实测：`/dev/kvm` 为 `root:all.editor 0660`；package 用户（如 `nodejs_v22`）**默认不可读写**；`usermod -aG all.editor` 后立刻 `WRITABLE`。v0.2 追加 `render`/`video`：分别对应 `renderD128`(`root:render 0660`) 与 `card0`(`root:video`)，是 `-gpu host` 的必要前提 |
| Q6 | 是否随包携带硬件 3D 的 X server | **不携带，只探测**。默认 `gpu: 'auto'`：`$TRIM_PKGVAR/runtime/xserver/Xkasmvnc` 存在且 `renderD128` 可读写 → `-gpu host`，否则回落 `off`；`-gpu host` 起不来再自动 `-gpu off` 重试 | 唯一支持 `-hw3d` 的 `Xkasmvnc` 是 **KasmVNC 1.4.0 / GPL-2.0**（随 MIT 包分发需附源码或书面要约），且 `ldd` 依赖 `libxfont2`/`libpixman-1-0`/`libunwind8`/`libwebp7`/`libxshmfence1` 等独立 deb。改为运维投放可做到包体积零增量，实测收益 −2.86s（−12.0%，中位 23843→20979ms） |
| Q5 | fnDepot 归属与署名 | 目标仓库 **`TaroCats/FnDepot`**（遵循 FnDepot 强制的仓库名规范）；`maintainer` 保留上游 `RoutineMiku`，另加 `distributor: TaroCats` 与 "fnOS port" 说明 | FnDepot 客户端硬性要求仓库名为 `FnDepot`；保留上游署名符合 MIT 与社区惯例 |

## 补充技术事实（架构师可直接使用）

- 目标机 fnOS 1.2.1010，`/var/apps/<appname>/` 为安装目录，数据软链至 `/volX/@app*`。
- 系统已装 `libx11-6 / libpulse0 / libgbm1 / libxcb1 / libxext6 / libxcomposite1 / libnss3 / libasound2`，Linux 版 emulator 无头运行依赖齐备。
- Node v22.23.4 已在目标机 `/usr/local/bin/node`（但 fpk 不应依赖系统 Node，须自带或使用 fnOS 的 nodejs 应用；架构需给出明确方案）。
- 应用中心安装无自动化凭据 → 真机验证走「按 fpk 契约手动安装 + 启停 + 功能验证」。
- 默认端口 **8890**。
