'use strict';
/**
 * 画面与输入注入（ARCH §3.3 #17-#22 / §1.1）。
 * 画面：adb exec-out screencap -p → image/png（浏览器 <img> 轮询）。
 * 输入：adb shell input tap/swipe/text/keyevent（坐标基于 wm size）。
 */
function _assertRunning(ctx) {
  if (!ctx.emulator || ctx.emulator.state !== 'running') {
    const e = new Error('模拟器未运行');
    e.code = 'EMULATOR_DOWN';
    throw e;
  }
  return ctx.emulator.adb();
}

function _num(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    const e = new Error(`参数 ${name} 必须是数字`);
    e.code = 'BAD_REQUEST';
    throw e;
  }
  return Math.round(n);
}

/**
 * 注入一条 input 命令。
 *
 * 两处「看起来发了、其实没到设备」的隐蔽路径都在这里兜住：
 *  1. 常驻输入通道（core/adb.js 的 `_inputSession`）在模拟器重启后会断，
 *     命令写进死管道等于丢掉 —— 退回一次性 `adb shell` 再发一次。
 *  2. `input swipe` 会阻塞到滑动结束，原先固定 4s 的通道超时对 3s 的长滑动
 *     非常贴边，一旦超时就把这条滑动判成失败。这里按时长放宽。
 */
async function _inject(adb, cmd, { timeout = 4000 } = {}) {
  try {
    await adb.input(cmd, { timeout });
  } catch (e) {
    if (typeof adb.shell !== 'function') throw e;
    await adb.shell(cmd, { timeout: timeout + 4000 });
  }
}

/** GET /api/screen/frame → image/png 或 204 */
async function frame(ctx, req, res, params, h) {
  if (!ctx.emulator || ctx.emulator.state !== 'running') {
    const e = new Error('模拟器未运行');
    e.code = 'EMULATOR_DOWN';
    throw e;
  }
  const adb = ctx.emulator.adb();
  let png = null;
  try {
    png = await adb.screenshot();
  } catch (_) {
    png = null;
  }
  if (!png || png.length < 8) {
    h.sendPng(res, null); // 204
    return;
  }
  h.sendPng(res, png);
}

/** GET /api/screen/size → { width, height, density } */
async function size(ctx, req, res, params, h) {
  const adb = _assertRunning(ctx);
  const sizeOut = await adb.shell('wm size').catch(() => '');
  const m = /(\d+)x(\d+)/.exec(String(sizeOut).split('\n').pop() || sizeOut);
  const width = m ? Number(m[1]) : 0;
  const height = m ? Number(m[2]) : 0;
  const denOut = await adb.shell('wm density').catch(() => '');
  const dm = /(\d+)\s*$/.exec(String(denOut).trim()) || /(\d+)/.exec(String(denOut));
  const density = dm ? Number(dm[1]) : 0;
  h.sendJson(res, 200, { width, height, density });
}

/** POST /api/screen/tap { x, y } */
async function tap(ctx, req, res, params, h) {
  const adb = _assertRunning(ctx);
  const body = await h.readJson(req);
  const x = _num(body.x, 'x');
  const y = _num(body.y, 'y');
  await _inject(adb, `input tap ${x} ${y}`);
  h.sendJson(res, 200, { ok: true });
}

/** POST /api/screen/swipe { x1, y1, x2, y2, durationMs=300 } */
async function swipe(ctx, req, res, params, h) {
  const adb = _assertRunning(ctx);
  const body = await h.readJson(req);
  const x1 = _num(body.x1, 'x1');
  const y1 = _num(body.y1, 'y1');
  const x2 = _num(body.x2, 'x2');
  const y2 = _num(body.y2, 'y2');
  // 起点=终点时不是滑动，而是「原地按住」：UI 侧用它表达长按（input tap 只是
  // 瞬时的 down+up，触发不了长按菜单），所以时长下限放宽到 300ms。
  const same = x1 === x2 && y1 === y2;
  const lo = same ? 300 : 50;
  const dur = Math.max(lo, Math.min(3000, Number(body.durationMs) || 300));
  const ms = Math.round(dur);
  await _inject(adb, `input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`, { timeout: ms + 6000 });
  h.sendJson(res, 200, { ok: true });
}

/**
 * 把任意文本转成 adb `input text` 的安全形式：
 * 去单引号/换行（避免破坏 shell 包裹），空格换 %s。
 */
function escapeInputText(str) {
  let t = String(str == null ? '' : str).replace(/[\r\n]+/g, ' ');
  t = t.replace(/'/g, ''); // 单引号会破坏外层 shell 包裹
  t = t.replace(/ /g, '%s');
  return t;
}

/** POST /api/screen/text { text } */
async function text(ctx, req, res, params, h) {
  const adb = _assertRunning(ctx);
  const body = await h.readJson(req);
  if (typeof body.text !== 'string') {
    const e = new Error('参数 text 必须是字符串');
    e.code = 'BAD_REQUEST';
    throw e;
  }
  const escaped = escapeInputText(body.text);
  await _inject(adb, `input text '${escaped}'`);
  h.sendJson(res, 200, { ok: true });
}

const KEYMAP = { back: 4, home: 3, recents: 187 };

/** POST /api/screen/key { key: "back"|"home"|"recents" } */
async function key(ctx, req, res, params, h) {
  const adb = _assertRunning(ctx);
  const body = await h.readJson(req);
  const code = KEYMAP[body.key];
  if (!code) {
    const e = new Error('参数 key 必须是 back/home/recents 之一');
    e.code = 'BAD_REQUEST';
    throw e;
  }
  await _inject(adb, `input keyevent ${code}`);
  h.sendJson(res, 200, { ok: true });
}

module.exports = { frame, size, tap, swipe, text, key, escapeInputText, _inject };
