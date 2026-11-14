'use strict';
/**
 * 生成 FnDepot V2 fnpack.json 片段（ARCH §7.7）。
 *
 * 字段取值来自「真机 ground truth」：目标机 FnDepot 1.0.8 的 sources 表里
 * 3 个真实外部源（TaroCats/FN-AppHub、TaroCats/huitai、jia070310/lemon-muisc，
 * 均 schema_version=2）的 fnpack.json 原文。要点（见 IMPL 偏差 7）：
 *   - platform 是数组，词表只有 x86 / arm（**没有 x86_64**）
 *   - releases.<ver>.packages 的 key 同样是 x86 / arm，不是 x86_64
 *   - service_port 是**字符串**（"9080" / "7401" / "7983"）
 *   - install_type 真实值是空字符串 ""
 *   - os_min_version 常见但可选：没有可靠值就不要写（不瞎填）
 *   - download_url 指向 GitHub Release 资产（huitai 的做法），不必放进仓库 arch 目录
 *   - 源仓库名不必须是 FnDepot，只要仓库根目录有 fnpack.json 即可被添加为外部源
 *   - maintainer / distributor 还有配套的 maintainer_url / distributor_url（真实源有）
 *   - preview_urls 只在确实有截图时写，没有就整个键省略（不要留空数组）
 *
 * 用法：node build/gen-fnpack.js --version <v> [--sha256 <hex>] [--size <bytes>] [--out <file>]
 * 未提供 sha256/size 时，若 dist/<appname>_<v>_x86.fpk 存在则自动计算。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const APPNAME = 'apkstart-fnos';

/** fnOS 平台词表里本包的架构段（manifest 的 platform=x86 与之对齐）。 */
const ARCH = 'x86';

/** 源码/发布仓库（FnDepot 外部源只要仓库根有 fnpack.json 即可，无需叫 FnDepot）。 */
const REPO = 'TaroCats/apkstart';
const REPO_URL = `https://github.com/${REPO}`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;

const DIST = path.join(ROOT, 'dist');

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

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version || '0.1.0';
  const fpkName = `${APPNAME}_${version}_${ARCH}.fpk`;
  const fpkPath = path.join(DIST, fpkName);

  let sha = args.sha256 || '';
  let size = args.size ? Number(args.size) : 0;
  if ((!sha || !size) && fs.existsSync(fpkPath)) {
    if (!sha) sha = sha256File(fpkPath);
    if (!size) size = fs.statSync(fpkPath).size;
  }

  const iso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const snippet = {
    schema_version: '2',
    source_info: {
      name: 'ApkStart',
      author: 'TaroCats',
      homepage: REPO_URL,
      description: '在飞牛 NAS 上用 KVM 无头模拟器托管安卓应用',
    },
    apps: {
      [APPNAME]: {
        display_name: 'ApkStart',
        desc: 'Web 控制台管理安卓应用：上传 APK、一键部署运行时、无头运行、画面与输入',
        // 平台词表：x86 / arm（真实源里没有 x86_64）
        platform: [ARCH],
        categories: ['系统工具'],
        // 图标/README 用 raw 绝对地址（lemon-music 也用相对路径，两种都行）；
        // 路径必须是仓库里真实存在的文件：fnos/ICON_256.PNG、README.md
        icon_url: `${RAW_BASE}/fnos/ICON_256.PNG`,
        readme_url: `${RAW_BASE}/README.md`,
        // 字段顺序刻意与参考源 apps.huitai 一致：
        //   display_name,desc,platform,categories,icon_url,readme_url,bug_report_url,
        //   maintainer,maintainer_url,distributor,distributor_url,run_as,install_type,
        //   is_docker,service_port,releases
        // 不写 preview_urls：参考源里**根本没有这个键**（有截图才写，lemon-music 是
        // 5 条相对路径，huitai / apphub 干脆没有）。空数组虽多半无害，但没必要保留
        // 空值，减少 FnDepot 各版本解析差异的风险（IMPL 偏差 10）。
        bug_report_url: `${REPO_URL}/issues`,
        maintainer: 'RoutineMiku',
        // 维护者主页（真实可访问地址，与 manifest 中同值）
        maintainer_url: 'https://github.com/RoutineMiku',
        distributor: 'TaroCats',
        // 分发者主页（真实可访问地址，指向本仓库，与 manifest 中同值）
        distributor_url: REPO_URL,
        run_as: 'package',
        // 真实源均为空字符串（不是 'online'）
        install_type: '',
        is_docker: false,
        // 真实源为字符串（"9080" / "7401" / "7983"），不是数字
        service_port: '8890',
        releases: {
          [version]: {
            changelog: '初始 fnOS 移植版本',
            updated_at: iso,
            // 不写 os_min_version：真实源取值是平台构建号（如 1.1.3100 / 0.9.27），
            // 我们没有可靠值，宁可省略也不瞎填（该字段可选）。
            packages: {
              // key 用平台词表 x86（不是 x86_64）
              [ARCH]: {
                // Release 资产地址，形态与 huitai 一致
                download_url: `${REPO_URL}/releases/download/v${version}/${fpkName}`,
                sha256: sha,
                size,
              },
            },
          },
        },
      },
    },
  };

  const outFile = args.out || path.join(DIST, 'fnpack.snippet.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(snippet, null, 2) + '\n', 'utf8');
  console.log(`fnpack 片段已生成: ${outFile}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('gen-fnpack 失败:', e.message);
    process.exit(1);
  }
}
