#!/usr/bin/env bash
# =============================================================================
# ApkStart for fnOS 打包主脚本（ARCH §7.1）
#   1) 生成图标   2) 组装 stage  3) 生成 ui 入口 config  3.8) 负载→根级 app.tgz
#   4) 生成 manifest  5) tar.gz→.fpk  5.5) 校验包结构  6) sha256  7) fnpack 片段
# 可复现：Linux 下固定 --mtime/--owner/--group/--sort（同 tag 重跑 sha256 稳定）。
# 用法：bash build/pack.sh --version 0.1.0 [--port 8890] [--changelog "说明"]
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPNAME="apkstart-fnos"
VERSION="${VERSION:-0.1.0}"
PORT="${PORT:-8890}"
CHANGELOG="${CHANGELOG:-}"

# ---- 解析参数 ----
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)   VERSION="$2";   shift 2 ;;
    --port)      PORT="$2";      shift 2 ;;
    --changelog) CHANGELOG="$2"; shift 2 ;;
    -h|--help) echo "用法: bash build/pack.sh --version <v> [--port <p>] [--changelog <text>]"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

STAGE="$ROOT/build/stage"
PKGROOT="$STAGE/$APPNAME"
DIST="$ROOT/dist"

echo "==> ApkStart 打包开始  version=$VERSION  port=$PORT"

# ---- 1) 生成图标（写入 repo ui/images 与 fnos/ICON*.PNG）----
node "$ROOT/build/gen-icons.js"

# ---- 2) 组装 stage ----
# 两个目录，别混：
#   $PKGROOT   → fpk 根（cmd/ config/ wizard/ ICON* manifest app.tgz）→ /var/apps/<appname>/
#   $APPSTAGE  → app.tgz 的内容根（server/ core/ ui/）→ 原样解包到 TRIM_APPDEST
# App Center **只认根级 app.tgz**，不认 app/ 目录（0.2.1 报 10107 的根因）。
rm -rf "$STAGE"
mkdir -p "$PKGROOT" "$DIST"
APPSTAGE="$STAGE/.app"          # 以 . 开头，永不进包
mkdir -p "$APPSTAGE"

# fpk 骨架（manifest.in 仅作模板，不进包；manifest 由 gen-manifest 生成）
cp "$ROOT/fnos/ICON.PNG" "$PKGROOT/ICON.PNG"
cp "$ROOT/fnos/ICON_256.PNG" "$PKGROOT/ICON_256.PNG"
mkdir -p "$PKGROOT/cmd" "$PKGROOT/config" "$PKGROOT/wizard"
cp "$ROOT"/fnos/cmd/* "$PKGROOT/cmd/"
cp "$ROOT"/fnos/config/* "$PKGROOT/config/"
cp "$ROOT"/fnos/wizard/* "$PKGROOT/wizard/"

# 应用代码 → app.tgz 内容根（顶层就是 server/ core/ ui/，不带任何套壳目录：
# 实测 fnOS 把 app.tgz 内容原样解进 TRIM_APPDEST，cmd/main 按 $APPDEST/server/index.js 取）
cp -R "$ROOT/server" "$APPSTAGE/server"
cp -R "$ROOT/core"   "$APPSTAGE/core"
cp -R "$ROOT/ui"     "$APPSTAGE/ui"

# 清理不应进包的产物
rm -rf "$APPSTAGE/ui/node_modules" 2>/dev/null || true
find "$STAGE" -name '.DS_Store' -delete 2>/dev/null || true

# 可执行权限（cmd/* 必须 0755）
chmod 0755 "$PKGROOT"/cmd/* 2>/dev/null || true

# ---- 2.5) 校验 wizard 契约（必须在打包前，校验的是真正进包的那份）----
# wizard 顶层必须是数组 []trimpkg.WizardPage；给对象时 App Center 会报
#   "wizard invalid: json: cannot unmarshal object into Go value of type
#    []trimpkg.WizardPage"，文案还伪装成 "is not exist: 100610"（0.2.0 踩过）。
node "$ROOT/build/validate-wizard.js" "$PKGROOT/wizard"

# ---- 3) 生成 app/ui/config（桌面入口，type:url + port，ARCH §7.4 / §10-4）----
# 注意路径：装完后它就在 $APPDEST/ui/config（desktop_uidir=ui + desktop_applaunchname）
cat > "$APPSTAGE/ui/config" <<EOF
{".url":{"$APPNAME.main":{"title":"ApkStart","icon":"images/icon_64.png","type":"url","protocol":"http","port":"$PORT","url":"/","allUsers":true}}}
EOF

# ---- 3.5) 注入包内版本兜底值（必须在 gen-manifest 算 checksum 之前）----
# config.js 里 `process.env.APKSTART_VERSION || 'x.y.z'` 的兜底值是静态写死的，
# 不注入的话包里运行时报的版本永远是源码里那个（0.1.0）。运行时没人会设
# APKSTART_VERSION，所以必须构建期改写。
node - "$APPSTAGE/server/config.js" "$VERSION" <<'NODE'
const fs = require('fs');
const [file, ver] = process.argv.slice(2);
const src = fs.readFileSync(file, 'utf8');
const re = /(process\.env\.APKSTART_VERSION\s*\|\|\s*)'[^']*'/;
if (!re.test(src)) {
  console.error(`!! config.js 中未找到 VERSION 兜底值，版本注入失败: ${file}`);
  process.exit(1);
}
fs.writeFileSync(file, src.replace(re, `$1'${ver}'`), 'utf8');
console.log(`config.js 版本已注入: ${ver}`);
NODE

# ---- 3.8) 应用负载打成根级 app.tgz（App Center 只认它，不认 app/ 目录）----
# 语义实测（fnmusic-hub 等 9 个平台应用）：app.tgz 内容**原样**解进 TRIM_APPDEST
#   （/volX/@appcenter/<appname>，/var/apps/<appname>/target 是指向它的软链），
#   不剥前缀、不套壳。所以这里显式列 server core ui 三个成员，tar 顶层就是它们。
TAR_VER="$(tar --version 2>/dev/null | head -n1 || echo unknown)"
REPRO_FLAGS=()
if echo "$TAR_VER" | grep -qi 'gnu tar'; then
  REPRO_FLAGS=(--owner=0 --group=0 --numeric-owner --mtime='UTC 2020-01-01' --sort=name)
  echo "==> 使用 GNU tar 可复现参数"
else
  # bsdtar（macOS 默认）会把 Apple 扩展属性写成 PAX 头
  # （LIBARCHIVE.xattr.com.apple.provenance），fnOS 侧 GNU tar 解包时逐文件报
  # 「忽略未知的扩展头关键字」。无害但噪声很大，且本地包与 CI 包字节不一致。
  REPRO_FLAGS=(--no-mac-metadata)
  echo "==> 非 GNU tar（${TAR_VER}），跳过 owner/mtime 固定，仅关掉 mac 扩展属性（本地开发可接受）"
fi

# macOS 打包避免 ._ 资源叉文件（内层与外层 tar 都要）
export COPYFILE_DISABLE=1

rm -f "$PKGROOT/app.tgz"
tar -czf "$PKGROOT/app.tgz" -C "$APPSTAGE" ${REPRO_FLAGS[@]+"${REPRO_FLAGS[@]}"} server core ui
echo "==> app.tgz 已生成: $(wc -c < "$PKGROOT/app.tgz") B"

# ---- 4) 生成 manifest（注入 version/port/changelog/checksum，ARCH §7.2）----
# checksum 覆盖除 manifest 外的全部文件，app.tgz 作为**一个文件**参与（不会解开算）
rm -f "$PKGROOT/manifest"
node "$ROOT/build/gen-manifest.js" \
  --stage "$PKGROOT" \
  --template "$ROOT/fnos/manifest.in" \
  --out "$PKGROOT/manifest" \
  --version "$VERSION" \
  --port "$PORT" \
  --changelog "${CHANGELOG:-初始 fnOS 移植版本}"

# ---- 5) 打包（tar.gz → .fpk），可复现 ----
# 产物名里的架构段用 fnOS 平台词表 x86（与 manifest 的 platform=x86 对齐），
# 不用内核架构 x86_64 —— 真实包如 huitai_2.1.1_x86.fpk 都是这个写法（IMPL 偏差 7）。
ARCH_SEG="x86"
FPK="$DIST/${APPNAME}_${VERSION}_${ARCH_SEG}.fpk"
rm -f "$FPK"
tar -czf "$FPK" -C "$STAGE" ${REPRO_FLAGS[@]+"${REPRO_FLAGS[@]}"} "$APPNAME"

# ---- 5.5) 校验包结构（拦截「app/ 目录而非 app.tgz」这类装不上但能构建的包）----
# 0.2.1 就是这样发出去的：本地看不出问题，只有真机装到一半才报 10107。
node "$ROOT/build/validate-package.js" "$FPK"

# ---- 6) sha256 ----
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$DIST" && sha256sum "$(basename "$FPK")" > "$(basename "$FPK").sha256" )
else
  ( cd "$DIST" && shasum -a 256 "$(basename "$FPK")" > "$(basename "$FPK").sha256" )
fi

# ---- 7) fnpack 片段（增量合并仓库根 fnpack.json 的历史 releases，勿改成覆盖）----
if [[ -n "$CHANGELOG" ]]; then
  node "$ROOT/build/gen-fnpack.js" --version "$VERSION" --changelog "$CHANGELOG"
else
  node "$ROOT/build/gen-fnpack.js" --version "$VERSION"
fi

echo "==> 完成："
ls -l "$FPK" "$FPK.sha256"
cat "$FPK.sha256"
