'use strict';
/**
 * 输入命令白名单（从上游 pointer.js 抽出的 isInputCommand）。
 *
 * 只有由本服务内部拼装出来的 `input ...` 命令才允许进常驻 `adb shell`，
 * 杜绝命令注入。上游只允许 tap/swipe/keyevent；fnOS 版新增 text 一档，
 * 用于网页文本框输入（P0-8，ASCII）。
 *
 * text 一律用**单引号包裹**：shell 单引号内除单引号本身外不做任何解释，
 * 因此只要禁止单引号与换行，命令即天然安全，无需额外转义。
 */
const INPUT_RE = /^input (?:keyevent \d{1,3}|swipe -?\d+ -?\d+ -?\d+ -?\d+ \d{1,4}|tap -?\d+ -?\d+)$/;
const TEXT_RE = /^input text '[^'\r\n]*'$/;

/** @param {string} cmd @returns {boolean} */
function isInputCommand(cmd) {
  const s = String(cmd || '');
  return INPUT_RE.test(s) || TEXT_RE.test(s);
}

module.exports = { isInputCommand, INPUT_RE, TEXT_RE };
