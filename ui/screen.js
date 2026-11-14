'use strict';
/**
 * 画面模块（ARCH §2.3 / §1.1）：轮询 /api/screen/frame 拉 PNG，注入 <img>；
 * 将浏览器点击/拖拽坐标按 wm size 比例换算为设备坐标后调用 input API。
 * 纯浏览器脚本，通过全局 window.ScreenView 暴露。
 */
(function (global) {
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
      el.addEventListener('pointerdown', (ev) => {
        if (!this.active) return;
        el.setPointerCapture(ev.pointerId);
        this._dragStart = Object.assign(this._toDevice(ev.clientX, ev.clientY), { t: Date.now() });
      });
      el.addEventListener('pointerup', async (ev) => {
        if (!this.active || !this._dragStart) return;
        const start = this._dragStart;
        this._dragStart = null;
        const end = this._toDevice(ev.clientX, ev.clientY);
        const dx = Math.abs(end.x - start.x);
        const dy = Math.abs(end.y - start.y);
        try {
          if (dx < 8 && dy < 8) {
            await this.API.tap(end.x, end.y);
          } else {
            const dur = Math.max(50, Math.min(2000, Date.now() - start.t));
            await this.API.swipe(start.x, start.y, end.x, end.y, dur);
          }
        } catch (e) {
          this.onError(e.message || '输入注入失败');
        }
      });
      el.addEventListener('pointercancel', () => { this._dragStart = null; });
    }
  }

  global.ScreenView = ScreenView;
  if (typeof module !== 'undefined' && module.exports) module.exports = ScreenView;
})(typeof window !== 'undefined' ? window : globalThis);
