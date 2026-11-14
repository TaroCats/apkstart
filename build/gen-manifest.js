'use strict';
/**
 * 生成 manifest（ARCH §7.2 / §7.3）。
 * 读 manifest.in，注入 @VERSION@ / @PORT@ / @CHECKSUM@，写到 stage 根下的 manifest。
 *
 * checksum 语义（§7.2）：包体校验，等于「除 manifest 外所有文件按相对路径排序后
 * 各文件 sha256 行（`<hex>  ./relpath`）拼接文本」的 sha256，与
 * `find . -type f ! -name manifest | sort | xargs sha256sum | sha256sum` 等价。
 *
 * 用法：node build/gen-manifest.js --stage <dir> --template <file> --out <file>
 *                            --version <v> --port <p> [--changelog <text>]
 *
 * manifest 是严格的每行一个 `key=value`，所以 changelog 里的换行必须压成空格，
 * 否则多出来的行会被 fnOS 当成未知键（甚至解析失败）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[key] = val;
    }
  }
  return out;
}

/** 递归收集目录下的普通文件，返回相对路径（POSIX 风格，前置 ./）。 */
function walk(dir, base, acc) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      walk(abs, rel, acc);
    } else if (ent.isFile()) {
      acc.push({ abs, rel });
    }
  }
  return acc;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 计算包体校验和（排除 manifest）。
 * @param {string} stageDir
 * @returns {string} hex
 */
function computeChecksum(stageDir) {
  const files = walk(stageDir, '', [])
    .filter((f) => f.rel !== 'manifest')
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const lines = files.map((f) => {
    const hex = sha256(fs.readFileSync(f.abs));
    return `${hex}  ./${f.rel}`;
  });
  return sha256(Buffer.from(lines.join('\n') + (lines.length ? '\n' : ''), 'utf8'));
}

/**
 * 模板替换：@KEY@ → 值。未提供的占位保持原样（不静默吞掉）。
 * @param {string} tpl
 * @param {Object<string,string>} vars
 */
function render(tpl, vars) {
  return tpl.replace(/@([A-Z0-9_]+)@/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const stageDir = args.stage;
  const templateFile = args.template;
  const outFile = args.out || (stageDir && path.join(stageDir, 'manifest'));
  const version = args.version || '0.1.0';
  const port = args.port || '8890';
  const changelog = String(args.changelog || '初始 fnOS 移植版本').replace(/\s*\n\s*/g, ' ').trim();

  if (!stageDir || !fs.existsSync(stageDir)) throw new Error(`stage 目录不存在: ${stageDir}`);
  if (!templateFile || !fs.existsSync(templateFile)) throw new Error(`模板不存在: ${templateFile}`);

  const checksum = computeChecksum(stageDir);
  const tpl = fs.readFileSync(templateFile, 'utf8');
  const body = render(tpl, {
    VERSION: version,
    PORT: port,
    CHECKSUM: checksum,
    CHANGELOG: changelog,
  });
  fs.writeFileSync(outFile, body, 'utf8');
  console.log(`manifest 已生成: ${outFile}`);
  console.log(`  version=${version} port=${port} checksum=${checksum}`);
  console.log(`  changelog=${changelog}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('gen-manifest 失败:', e.message);
    process.exit(1);
  }
}

module.exports = { computeChecksum, render };
