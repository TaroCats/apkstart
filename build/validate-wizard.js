#!/usr/bin/env node
// =============================================================================
// 校验 fpk wizard 文件契约（build/pack.sh 与 test/fnos-unit.js 共用）
//
// 背景（0.2.0 踩过的坑）：
//   wizard/install 顶层写成对象 `{title, steps:[…]}` 时，App Center 会报
//     checkPackage installWizard …/wizard/install is not exist: 100610
//     wizard invalid: json: cannot unmarshal object into Go value of type []trimpkg.WizardPage
//   报错文案里的 "is not exist" 是误导 —— 文件存在且能读，只是 JSON 形状不对。
//   fnOS 的 wizard 顶层类型是 `[]trimpkg.WizardPage`，必须是数组。
//
// 契约（从目标机已装应用的 wizard 反向确认）：
//   顶层      Array<WizardPage>
//   WizardPage { stepTitle: string, items: WizardItem[] }
//   WizardItem { type: 'tips'  , helpText: string }
//            | { type: 'switch', field: string, label: string, rules?: Rule[] }
//            | { type: 'text'  , field: string, label: string, rules?: Rule[] }
//   Rule       { required?: boolean, pattern?: string, message?: string }
//
// 注意：item 的 field 只用于前端表单校验，值不会传到 cmd/* 脚本
//      （已 grep 目标机 3 个真实应用确认）。需要脚本感知的选项不能靠 wizard。
//
// 用法：node build/validate-wizard.js [dir]      默认 dir = <repo>/fnos/wizard
//      通过打印 "wizard 校验通过: N 个文件 / M 页"；失败逐条打印并以 1 退出。
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const KNOWN_ITEM_TYPES = ['tips', 'switch', 'text'];
// 每个 type 必须存在的键
const REQUIRED_KEYS = {
  tips: ['helpText'],
  switch: ['field', 'label'],
  text: ['field', 'label'],
};

function validatePage(page, where, errors) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) {
    errors.push(`${where}: page 必须是对象`);
    return 0;
  }
  if (typeof page.stepTitle !== 'string' || !page.stepTitle.trim()) {
    errors.push(`${where}: 缺少 stepTitle（非空字符串）`);
  }
  if (!Array.isArray(page.items) || page.items.length === 0) {
    errors.push(`${where}: items 必须是非空数组`);
    return 0;
  }

  page.items.forEach((item, i) => {
    const at = `${where}.items[${i}]`;
    if (!item || typeof item !== 'object') {
      errors.push(`${at}: item 必须是对象`);
      return;
    }
    if (!KNOWN_ITEM_TYPES.includes(item.type)) {
      errors.push(`${at}: type=${JSON.stringify(item.type)} 不在已知类型 ${KNOWN_ITEM_TYPES.join('/')} 内`);
      return;
    }
    for (const key of REQUIRED_KEYS[item.type]) {
      if (typeof item[key] !== 'string' || !item[key].trim()) {
        errors.push(`${at}(type=${item.type}): 缺少 ${key}（非空字符串）`);
      }
    }
    if (item.rules !== undefined) {
      if (!Array.isArray(item.rules)) {
        errors.push(`${at}: rules 必须是数组`);
      } else {
        item.rules.forEach((r, j) => {
          if (!r || typeof r !== 'object' || Array.isArray(r)) {
            errors.push(`${at}.rules[${j}]: rule 必须是对象`);
            return;
          }
          const keys = Object.keys(r).filter((k) => ['required', 'pattern', 'message'].includes(k));
          if (keys.length === 0) {
            errors.push(`${at}.rules[${j}]: 至少要有 required / pattern / message 之一`);
          }
          if (r.message !== undefined && typeof r.message !== 'string') {
            errors.push(`${at}.rules[${j}]: message 必须是字符串`);
          }
        });
      }
    }
  });

  return page.items.length;
}

function validateFile(file) {
  const errors = [];
  const name = path.basename(file);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { file: name, pages: 0, items: 0, errors: [`读取失败: ${e.message}`] };
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { file: name, pages: 0, items: 0, errors: [`JSON 解析失败: ${e.message}`] };
  }

  if (!Array.isArray(json)) {
    const t = json && typeof json === 'object' ? 'object' : typeof json;
    errors.push(
      `顶层必须是数组（[]trimpkg.WizardPage），实际是 ${t}；` +
        `否则 App Center 报 "json: cannot unmarshal ${t} into Go value of type []trimpkg.WizardPage"`
    );
    return { file: name, pages: 0, items: 0, errors };
  }

  let items = 0;
  json.forEach((page, i) => {
    items += validatePage(page, `[${i}]`, errors);
  });

  return { file: name, pages: json.length, items, errors };
}

function validateDir(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => {
      const p = path.join(dir, f);
      return fs.statSync(p).isFile() && !f.startsWith('.');
    })
    .sort()
    .map((f) => path.join(dir, f));

  const results = files.map(validateFile);
  const errors = [];
  for (const r of results) {
    for (const e of r.errors) errors.push(`${r.file}${e.startsWith('[') || e.startsWith('.') ? '' : ' '}${e}`);
  }
  // install / uninstall 两个文件必须存在（少一个都是 App Center 侧硬失败）
  const names = results.map((r) => r.file);
  for (const must of ['install', 'uninstall']) {
    if (!names.includes(must)) errors.push(`缺少必需文件: ${must}`);
  }

  return {
    files: results.length,
    pages: results.reduce((s, r) => s + r.pages, 0),
    items: results.reduce((s, r) => s + r.items, 0),
    errors,
  };
}

module.exports = { validateDir, validateFile };

if (require.main === module) {
  const dir = process.argv[2] || path.join(__dirname, '..', 'fnos', 'wizard');
  if (!fs.existsSync(dir)) {
    console.error(`!! wizard 目录不存在: ${dir}`);
    process.exit(1);
  }
  const res = validateDir(dir);
  if (res.errors.length) {
    console.error(`!! wizard 校验失败（${dir}）`);
    for (const e of res.errors) console.error('   - ' + e);
    process.exit(1);
  }
  console.log(`wizard 校验通过: ${res.files} 个文件 / ${res.pages} 页 / ${res.items} 个 item（${dir}）`);
}
