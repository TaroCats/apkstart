'use strict';
/**
 * 图标生成（ARCH §2.5 / §7.1 step 7）。
 * 用 core/png.js 的 drawAppIcon 生成 PNG，避免往仓库塞二进制素材：
 *   fnos/ICON.PNG (64) / fnos/ICON_256.PNG (256)
 *   ui/images/icon_64.png / ui/images/icon_256.png
 * 产物提交到仓库，CI 与 pack.sh 亦可重跑。
 */
const fs = require('fs');
const path = require('path');
const { drawAppIcon } = require('../core/png');

const ROOT = path.resolve(__dirname, '..');

const targets = [
  { size: 64, file: path.join(ROOT, 'fnos', 'ICON.PNG') },
  { size: 256, file: path.join(ROOT, 'fnos', 'ICON_256.PNG') },
  { size: 64, file: path.join(ROOT, 'ui', 'images', 'icon_64.png') },
  { size: 256, file: path.join(ROOT, 'ui', 'images', 'icon_256.png') },
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function main() {
  for (const t of targets) {
    ensureDir(path.dirname(t.file));
    const buf = drawAppIcon(t.size);
    fs.writeFileSync(t.file, buf);
    // 基本 PNG magic 校验
    const magic = buf.slice(0, 8).toString('hex');
    const ok = magic === '89504e470d0a1a0a';
    console.log(`生成 ${path.relative(ROOT, t.file)}  ${t.size}x${t.size}  ${buf.length} bytes  magic=${magic}${ok ? ' OK' : ' BAD'}`);
    if (!ok) process.exitCode = 1;
  }
  if (!process.exitCode) console.log('图标全部生成完毕。');
}

main();
