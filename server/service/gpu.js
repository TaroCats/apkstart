'use strict';
/**
 * `-gpu` 模式的运行期裁决（纯函数，可单测）。
 *
 * 事实依据（真机 A/B，见 docs/fnos/IMPL.md 偏差 5 及其更正）：
 *   ① 任何 `-gpu != off` 都需要一个 X display：无 DISPLAY 时 QEMU 会在 ~2s 内
 *      `main loop exits abnormally with code 1`（连纯软件的 swiftshader 也一样，
 *      因为它仍要向 windowing system 出画面）。
 *   ② 只有 `-hw3d` 的 X server（KasmVNC Xkasmvnc）才真拿到 GPU；Xvfb/TigerVNC
 *      的 llvmpipe 路径实测 29553ms，比 `off` 还慢，属于「配了反而更差」。
 *   ③ `-gpu host` 还要求进程能读写 `/dev/dri/renderD128`（`render` 组）。
 *
 * 旧实现 `_effectiveGpu()` 只校验 ③，**没校验 ①** —— 于是没有 X 的机器上
 * 用户一改设置就是 2 秒静默崩溃。本模块把三条前提显式化。
 */

/** 这些模式都必须有 X display；`off` 不需要。 */
const NEEDS_DISPLAY = new Set([
  'host',
  'angle_indirect',
  'guest',
  'mesa',
  'swiftshader_indirect',
  'swiftshader',
]);

/** reason → 面向用户/日志的中文说明。 */
const REASON_TEXT = {
  'configured-off': '已按配置关闭 GPU 加速',
  'no-render-node': '/dev/dri/renderD128 不可读写（包用户缺 render 组权限），已降级为 -gpu off',
  'no-xserver': '未找到支持 -hw3d 的 X server（Xkasmvnc），已降级为 -gpu off',
  'auto-host': '自动检测到硬件 3D X display 与 render node，启用 -gpu host',
  configured: '按配置启用 GPU 加速（X display 与 render node 均可用）',
};

/**
 * @param {{want?:string, hasDisplay?:boolean, renderNodeUsable?:boolean, autoEnabled?:boolean}} o
 * @returns {{mode:string, want:string, reason:string, message:string}}
 */
function resolveGpuMode({ want, hasDisplay, renderNodeUsable, autoEnabled = true } = {}) {
  const w = String(want || 'auto').trim().toLowerCase();
  const facts = { hasDisplay: !!hasDisplay, renderNodeUsable: !!renderNodeUsable };

  /** @param {string} mode @param {string} reason */
  const out = (mode, reason) => ({
    mode,
    want: w,
    reason,
    message: REASON_TEXT[reason] || reason,
  });

  if (w === 'off') return out('off', 'configured-off');

  if (w === 'auto') {
    if (!autoEnabled) return out('off', 'configured-off');
    if (!facts.renderNodeUsable) return out('off', 'no-render-node');
    if (!facts.hasDisplay) return out('off', 'no-xserver');
    return out('host', 'auto-host');
  }

  // 显式配置：前提不满足就降级，绝不把 QEMU 送进「2 秒崩溃」路径。
  if (NEEDS_DISPLAY.has(w)) {
    if (!facts.renderNodeUsable) return out('off', 'no-render-node');
    if (!facts.hasDisplay) return out('off', 'no-xserver');
    return out(w, 'configured');
  }
  return out('off', 'configured-off');
}

module.exports = { resolveGpuMode, NEEDS_DISPLAY, REASON_TEXT };
