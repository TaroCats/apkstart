# fnOS 运行时范式（取自目标机已装应用，非推测）

来源：`/var/apps/fndepot/cmd/{main,common}`、`/var/apps/wechat-on-cloud/cmd/main`、`/var/apps/wechat-on-cloud/{manifest,config/*,ui/config}`（fnOS 1.2.1010 实测）。

## 1. 真实环境变量名（务必使用这些，不要自造）

| 变量 | 实测含义 |
|---|---|
| `TRIM_APPDEST` | 代码根（安装后 `target/` 指向的目录） |
| `TRIM_PKGVAR` | 运行时数据根（`var/` → `/volX/@appdata/<app>`） |
| `TRIM_PKGTMP` | 临时目录 |
| `TRIM_TEMP_LOGFILE` | 应用中心读取的日志文件（stderr 摘要写这里） |
| `TRIM_SYS_ARCH` | 架构（`x86_64` 等） |
| `TRIM_SYS_LANGUAGE` / `TRIM_SERVICE_PORT` | 语言 / 服务端口 |

社区 skill 文档里的 `TRIM_APPDATA` / `TRIM_APPHOME` / `TRIM_APPCONF` **在机上脚本里未出现**；以本表为准，其中 `TRIM_PKGVAR` 才是持久数据根。

## 2. `cmd/main` 契约（两份实例一致）

```bash
case $1 in
  start)  启动服务；成功 exit 0 ;;
  stop)   停止服务；成功 exit 0 ;;
  status) 运行中 exit 0，未运行 exit 3 ;;
  *)      exit 1 ;;
esac
```

## 3. 长驻服务启动范式（fndepot 实测）

- `nohup <binary> --data-dir="${TRIM_PKGVAR}" --ui-dir="${TRIM_APPDEST}/ui" >> "${TRIM_PKGVAR}/gateway.log" 2>&1 &`
- PID 写 `${TRIM_PKGVAR}/app.pid`；`status` 用「PID 存活 + 端口/socket 健康检查」双重判定。
- 启动后轮询健康检查（最多 20 s），失败则 kill 并清理 PID，返回非 0 —— **`start` 必须等到服务真的可用才返回 0**，应用中心据此显示「运行中」。
- 日志写 `${TRIM_PKGVAR}/info.log`，按 5 MB 轮转保留 1 份；错误摘要同时追加到 `${TRIM_TEMP_LOGFILE}`。
- 已在运行时重复 `start` 要先做健康检查再决定「直接返回 0」还是「清理重启」（幂等）。

## 4. 桌面入口两种形态

```jsonc
// A. 直连端口（wechat-on-cloud 用法；本次采用）
{".url": {"<app>.main": {title, icon:"images/icon_{0}.png", type:"url",
  protocol:"http", port:"18990", url:"/", allUsers:true}}}

// B. 统一网关（fndepot 用法；需监听 unix socket，鉴权由 NAS 处理，P1 可选）
{"type":"iframe", "gatewaySocket":"<app>.sock", "gatewayPrefix":"/app/<app>", "url":"/app/<app>"}
```

## 5. privilege / resource 实测样例

```json
// config/privilege
{"defaults":{"run-as":"package"},"username":"<app>","groupname":"<app>","join-groups":["all.editor"]}
```
`join-groups` 是**可靠**的：实测 `usermod -aG all.editor <appuser>` 后立即获得 `/dev/kvm` 读写权限。

## 6. manifest 实测字段（wechat-on-cloud）

```
appname / version / display_name / desc / changelog / platform=all / source=thirdparty
maintainer / maintainer_url / distributor / distributor_url
os_min_version / desktop_uidir=ui / desktop_applaunchname=<app>.main / ctl_stop=true / checksum
```
