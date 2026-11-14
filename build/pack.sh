#!/usr/bin/env bash
# =============================================================================
# ApkStart for fnOS 打包主脚本（ARCH §7.1）
#   1) 生成图标   2) 组装 stage  3) 生成 ui 入口 config
#   4) 生成 manifest  5) tar.gz→.fpk  6) sha256  7) fnpack 片段
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
rm -rf "$STAGE"
mkdir -p "$PKGROOT/app" "$DIST"

# fpk 骨架（manifest.in 仅作模板，不进包；manifest 由 gen-manifest 生成）
cp "$ROOT/fnos/ICON.PNG" "$PKGROOT/ICON.PNG"
cp "$ROOT/fnos/ICON_256.PNG" "$PKGROOT/ICON_256.PNG"
mkdir -p "$PKGROOT/cmd" "$PKGROOT/config" "$PKGROOT/wizard"
cp "$ROOT"/fnos/cmd/* "$PKGROOT/cmd/"
cp "$ROOT"/fnos/config/* "$PKGROOT/config/"
cp "$ROOT"/fnos/wizard/* "$PKGROOT/wizard/"

# 应用代码
mkdir -p "$PKGROOT/app"
cp -R "$ROOT/server" "$PKGROOT/app/server"
cp -R "$ROOT/core"   "$PKGROOT/app/core"
cp -R "$ROOT/ui"     "$PKGROOT/app/ui"

# 清理不应进包的产物
rm -rf "$PKGROOT/app/ui/node_modules" 2>/dev/null || true
find "$PKGROOT" -name '.DS_Store' -delete 2>/dev/null || true

# 可执行权限（cmd/* 必须 0755）
chmod 0755 "$PKGROOT"/cmd/* 2>/dev/null || true

# ---- 2.5) 校验 wizard 契约（必须在打包前，校验的是真正进包的那份）----
# wizard 顶层必须是数组 []trimpkg.WizardPage；给对象时 App Center 会报
#   "wizard invalid: json: cannot unmarshal object into Go value of type
#    []trimpkg.WizardPage"，文案还伪装成 "is not exist: 100610"（0.2.0 踩过）。
node "$ROOT/build/validate-wizard.js" "$PKGROOT/wizard"

# ---- 3) 生成 app/ui/config（桌面入口，type:url + port，ARCH §7.4 / §10-4）----
cat > "$PKGROOT/app/ui/config" <<EOF
{".url":{"$APPNAME.main":{"title":"ApkStart","icon":"images/icon_64.png","type":"url","protocol":"http","port":"$PORT","url":"/","allUsers":true}}}
EOF

# ---- 3.5) 注入包内版本兜底值（必须在 gen-manifest 算 checksum 之前）----
# config.js 里 `process.env.APKSTART_VERSION || 'x.y.z'` 的兜底值是静态写死的，
# 不注入的话包里运行时报的版本永远是源码里那个（0.1.0）。运行时没人会设
# APKSTART_VERSION，所以必须构建期改写。
node - "$PKGROOT/app/server/config.js" "$VERSION" <<'NODE'
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

# ---- 4) 生成 manifest（注入 version/port/changelog/checksum，ARCH §7.2）----
rm -f "$PKGROOT/manifest"   # checksum 计算需排除 manifest 本身
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

TAR_VER="$(tar --version 2>/dev/null | head -n1 || echo unknown)"
REPRO_FLAGS=()
if echo "$TAR_VER" | grep -qi 'gnu tar'; then
  REPRO_FLAGS=(--owner=0 --group=0 --numeric-owner --mtime='UTC 2020-01-01' --sort=name)
  echo "==> 使用 GNU tar 可复现参数"
else
  echo "==> 非 GNU tar（${TAR_VER}），跳过 owner/mtime 固定（本地开发可接受）"
fi

# macOS 打包避免 ._ 资源叉文件
export COPYFILE_DISABLE=1
tar -czf "$FPK" -C "$STAGE" ${REPRO_FLAGS[@]+"${REPRO_FLAGS[@]}"} "$APPNAME"

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
