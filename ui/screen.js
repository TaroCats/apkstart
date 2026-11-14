'use strict';
/**
 * 画面模块（ARCH §2.3 / §1.1）：轮询 /api/screen/frame 拉 PNG，注入 <img>；
 * 将浏览器点击/拖拽坐标按 wm size 比例换算为设备坐标后调用 input API。
 * 纯浏览器脚本，通过全局 window.ScreenView 暴露。
 */
(function (global) {
  /**
   * 手势判定参数（0.2.5）。
   *
   * 这里用「浏览器 CSS 像素」做容差，而不是设备像素：真机 1080x1920 的画面在
   * 桌面上通常只有 344x612 CSS px，1 CSS px ≈ 3.14 设备像素。早先按「8 设备像素」
   * 判点击，等于只给 2.5 CSS px 的容差 —— 鼠标/触控板点击自带的 2~4px 手抖
   * 立刻被判成 swipe，再被 `Math.max(50, …)` 抬到 50ms，最终发出
   * `input swipe x y x+3 y 50`，屏幕上什么都没发生。用户体感就是「点了没反应」。
   * 触摸屏的 click slop 也是 8~10 CSS px 量级，这里对齐它。
   */
  const TAP_SLOP_CSS = 10;      // 触点位移 <= 10 CSS px 视为点击
  const MIN_SWIPE_DEVICE = 6;   // 设备像素位移太小，swipe 等于空操作，仍按点击处理
  const MIN_SWIPE_MS = 100;     // input swipe 时长下限（更短会被当 fling 丢掉）
  const MAX_SWIPE_MS = 2000;
  const LONG_PRESS_MS = 600;    // 按住不动超过这么久 → 用「原地按住」表达长按

  /**
   * 纯函数：把一次 pointerdown → pointerup 判成 tap / swipe / hold。
   *
   * @param {{dx:number, dy:number, deviceDx:number, deviceDy:number, elapsed:number}} g
   *        dx/dy 为浏览器 CSS 像素位移，deviceDx/deviceDy 为设备像素位移
   * @returns {{kind:'tap'|'swipe'|'hold', durationMs:number, cssDist:number, devDist:number}}
   */
  function classifyGesture(g) {
    const dx = Number(g && g.dx) || 0;
    const dy = Number(g && g.dy) || 0;
    const ddx = Number(g && g.deviceDx) || 0;
    const ddy = Number(g && g.deviceDy) || 0;
    const elapsed = Math.max(0, Number(g && g.elapsed) || 0);
    const cssDist = Math.sqrt(dx * dx + dy * dy);
    const devDist = Math.sqrt(ddx * ddx + ddy * ddy);
    const durationMs = Math.round(Math.min(MAX_SWIPE_MS, Math.max(MIN_SWIPE_MS, elapsed)));
    const still = cssDist <= TAP_SLOP_CSS || devDist < MIN_SWIPE_DEVICE;
    if (!still) return { kind: 'swipe', durationMs, cssDist, devDist };
    // 按住不动足够久：`input tap` 只是瞬时的 down+up，触发不了长按菜单，
    // 必须发出「原地按住」的 swipe（同起点终点 + 时长）才能被 ROM 认成长按。
    if (elapsed >= LONG_PRESS_MS) return { kind: 'hold', durationMs, cssDist, devDist };
    return { kind: 'tap', durationMs, cssDist, devDist };
  }

  /**
   * @param {{img: HTMLImageElement, overlay?: HTMLElement, API: object, onError?: Function, fps?: number}} opts
   */
  class ScreenView {
    constructor(opts) {
      this.img = opts.img;
      this.overlay = opts.overlay || null;
      this.API = opts.API;
      this.onError = opts.onError || function () {};
      this.fps = Math.max(1, Math.min(10, opts.fps || 2));
      this.timer = null;
      this.device = { width: 1080, height: 1920, density: 420 };
      this.active = false;
      this._dragStart = null;
      this._objectUrl = null;
      this._grabbing = false;
      this._bindInput();
    }

    /** 设备真实分辨率（来自 wm size）。 */
    async refreshSize() {
      try {
        const s = await this.API.screenSize();
        if (s && s.width && s.height) {
          this.device = { width: s.width, height: s.height, density: s.density || this.device.density };
        }
        return this.device;
      } catch (_) {
        return this.device;
      }
    }

    /** 启动轮询。 */
    start() {
      if (this.timer) return;
      this.active = true;
      const loop = async () => {
        if (!this.active) return;
        await this._grab();
        if (!this.active) return;
        this.timer = setTimeout(loop, Math.round(1000 / this.fps));
      };
      loop();
    }

    /** 停止轮询。 */
    stop() {
      this.active = false;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }

    setFps(fps) {
      this.fps = Math.max(1, Math.min(10, fps || 2));
    }

    /** 拉取一帧。204 表示暂无画面。 */
    async _grab() {
      if (this._grabbing) return; // 输入后会主动补一帧，别把轮询和补帧叠在一起
      this._grabbing = true;
      try {
        await this._grabOnce();
      } finally {
        this._grabbing = false;
      }
    }

    async _grabOnce() {
      try {
        const res = await fetch('/api/screen/frame', { cache: 'no-store' });
        if (res.status === 204) {
          this._setPlaceholder('等待模拟器画面…');
          return;
        }
        if (!res.ok) {
          let msg = `画面获取失败（HTTP ${res.status}）`;
          try {
            const j = await res.json();
            if (j && j.message) msg = j.message;
          } catch (_) {}
          this.onError(msg);
          this._setPlaceholder(msg);
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const old = this._objectUrl;
        this.img.onload = () => { if (old) URL.revokeObjectURL(old); };
        this.img.src = url;
        this._objectUrl = url;
        this.img.classList.add('active');
      } catch (e) {
        this.onError(e && e.message ? e.message : '画面轮询异常');
      }
    }

    _setPlaceholder(msg) {
      this.img.classList.remove('active');
      if (this.overlay) this.overlay.textContent = msg;
    }

    /** 浏览器坐标 → 设备坐标。 */
    _toDevice(clientX, clientY) {
      const rect = this.img.getBoundingClientRect();
      const w = rect.width || 1;
      const h = rect.height || 1;
      const x = Math.round(((clientX - rect.left) / w) * this.device.width);
      const y = Math.round(((clientY - rect.top) / h) * this.device.height);
      return {
        x: Math.max(0, Math.min(this.device.width - 1, x)),
        y: Math.max(0, Math.min(this.device.height - 1, y)),
      };
    }

    _bindInput() {
      const el = this.img;
      el.style.touchAction = 'none';

      // 关键（0.2.5）：<img> 默认 draggable=true。鼠标从画面上拖出去会启动 HTML5
      // 原生拖拽，浏览器随即发 pointercancel，_dragStart 被清空 → 一次 swipe 都
      // 发不出去，画面「只能看不能滑」。三条都要有：属性 + 阻止默认 + dragstart 兜底
      // （部分浏览器只认其中一个）。
      el.draggable = false;
      el.setAttribute('draggable', 'false');
      if ('webkitUserDrag' in el.style) el.style.webkitUserDrag = 'none';
      el.addEventListener('dragstart', (ev) => ev.preventDefault());

      el.addEventListener('pointerdown', (ev) => {
        if (!this.active) return;
        if (ev.button !== undefined && ev.button > 0) return; // 右键/中键不接管
        ev.preventDefault(); // 阻止原生拖拽与文本选中
        try { el.setPointerCapture(ev.pointerId); } catch (_) { /* 老浏览器 */ }
        const dev = this._toDevice(ev.clientX, ev.clientY);
        // 同时记浏览器坐标：判定手势要用 CSS 像素，不能用放大后的设备像素
        this._dragStart = { x: dev.x, y: dev.y, cx: ev.clientX, cy: ev.clientY, t: Date.now() };
      });

      el.addEventListener('pointerup', (ev) => {
        if (!this.active || !this._dragStart) return;
        const start = this._dragStart;
        this._dragStart = null;
        try { el.releasePointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
        const end = this._toDevice(ev.clientX, ev.clientY);
        const g = classifyGesture({
          dx: ev.clientX - start.cx,
          dy: ev.clientY - start.cy,
          deviceDx: end.x - start.x,
          deviceDy: end.y - start.y,
          elapsed: Date.now() - start.t,
        });
        this._dispatch(g, start, end);
      });

      // 正常情况下（阻止了原生拖拽）不该再收到 pointercancel；留着做兜底，
      // 同时避免一次被取消的拖拽污染下一次的起点。
      el.addEventListener('pointercancel', () => { this._dragStart = null; });
    }

    /** 把判定结果投递到后端；失败只提示，不改变已发生的输入语义。 */
    async _dispatch(g, start, end) {
      try {
        if (g.kind === 'tap') {
          await this.API.tap(end.x, end.y);
        } else if (g.kind === 'hold') {
          await this.API.swipe(start.x, start.y, start.x, start.y, g.durationMs);
        } else {
          await this.API.swipe(start.x, start.y, end.x, end.y, g.durationMs);
        }
      } catch (e) {
        this.onError((e && e.message) || '输入注入失败');
      } finally {
        // 输入后立刻补一帧：轮询只有 2fps，等下一拍最多要 500ms，
        // 用户会以为「点了没反应」。这里立刻拉一次，画面马上跟上。
        if (this.active) this._grab();
      }
    }
  }

  global.ScreenView = ScreenView;
  // 供单测直接拿纯函数（不需要 DOM）
  ScreenView.classifyGesture = classifyGesture;
  ScreenView.GESTURE = { TAP_SLOP_CSS, MIN_SWIPE_DEVICE, MIN_SWIPE_MS, MAX_SWIPE_MS, LONG_PRESS_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = ScreenView;
})(typeof window !== 'undefined' ? window : globalThis);
