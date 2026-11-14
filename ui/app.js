'use strict';
/**
 * 控制器（ARCH §2.3）：绑定事件、调用 Api、渲染视图、轮询状态。
 * 纯浏览器脚本，依赖 api.js（window.Api）与 screen.js（window.ScreenView）。
 */
(function () {
  const API = window.Api;
  const $ = (sel) => document.querySelector(sel);

  /** 运行期状态缓存。 */
  const state = {
    version: '-',
    status: null,
    runtime: null,
    apps: [],
    pendingApk: null,   // { uploadId, vo }
    deployTimer: null,
    statusTimer: null,
    screen: null,
    busy: false,
  };

  // ---------------- 工具 ----------------
  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  function setConn(ok) {
    const dot = $('#conn-dot');
    dot.className = 'conn-dot ' + (ok ? 'ok' : 'err');
    dot.title = ok ? '后端连接正常' : '后端连接失败';
  }

  function fmtBytes(n) {
    if (!n || n < 0) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function fmtSpeed(bps) {
    return bps ? `${fmtBytes(bps)}/s` : '-';
  }

  function guard(fn) {
    return async (...args) => {
      if (state.busy) return;
      state.busy = true;
      try {
        await fn(...args);
      } catch (e) {
        toast(e.message || '操作失败', 'err');
        if (e.code === 'EMULATOR_DOWN' || e.code === 'RUNTIME_NOT_READY') {
          setTimeout(refreshStatus, 300);
        }
      } finally {
        state.busy = false;
      }
    };
  }

  // ---------------- 状态渲染 ----------------
  const EMU_LABEL = {
    stopped: '已停止', starting: '启动中…', running: '运行中',
    stopping: '停止中…', error: '异常',
  };

  async function refreshStatus() {
    try {
      const [status, runtime] = await Promise.all([
        API.status(),
        API.runtimeStatus(),
      ]);
      state.status = status;
      state.runtime = runtime;
      setConn(true);
      renderStatus(status, runtime);
    } catch (e) {
      setConn(false);
      const errBox = $('#status-error');
      errBox.textContent = e.message || '状态获取失败';
      errBox.classList.remove('hidden');
    }
  }

  function renderStatus(s, rt) {
    if (!s) return;
    // 运行时
    const rtEl = $('#st-runtime');
    if (rt && rt.deployed) {
      rtEl.textContent = s.runtime && s.runtime.phase === 'idle' ? '已就绪' : (s.runtime && s.runtime.phase) || '已就绪';
    } else {
      rtEl.textContent = '未部署';
    }
    // 模拟器
    $('#st-emulator').textContent = EMU_LABEL[s.emulator] || s.emulator || '未知';
    // ADB
    $('#st-adb').textContent = s.adbConnected ? '已连接' : '未连接';
    // 前台
    $('#st-foreground').textContent = s.foregroundPackage || '-';
    // 分辨率
    $('#st-resolution').textContent = s.screen && s.screen.width ? `${s.screen.width}×${s.screen.height}` : '-';
    // RSS
    $('#st-rss').textContent = s.rssMB ? `${s.rssMB} MB` : '-';

    // 错误
    const errBox = $('#status-error');
    if (s.error) { errBox.textContent = s.error; errBox.classList.remove('hidden'); }
    else errBox.classList.add('hidden');

    // KVM 警告
    const warn = $('#kvm-warning');
    if (rt && rt.kvm && rt.kvm.available && !rt.kvm.writable) warn.classList.remove('hidden');
    else if (rt && rt.kvm && !rt.kvm.available) warn.classList.remove('hidden');
    else warn.classList.add('hidden');

    // 画面轮询：仅在 running 时启动
    if (state.screen) {
      if (s.emulator === 'running') {
        state.screen.device = s.screen && s.screen.width
          ? { width: s.screen.width, height: s.screen.height, density: s.screen.density || 420 }
          : state.screen.device;
        state.screen.start();
      } else {
        state.screen.stop();
        $('#screen-img').classList.remove('active');
        $('#screen-overlay').textContent = s.emulator === 'error'
          ? '模拟器异常，请查看日志'
          : '模拟器未运行';
      }
    }

    // 部署按钮可用性
    $('#btn-deploy').disabled = !!(s.runtime && s.runtime.phase === 'downloading');
  }

  // ---------------- 应用列表 ----------------
  async function refreshApps() {
    try {
      const apps = await API.listApps();
      state.apps = Array.isArray(apps) ? apps : [];
      renderApps();
    } catch (e) {
      // EMULATOR_DOWN 时后端仍返回列表（running=null），此处多为网络错误
      if (e.code !== 'EMULATOR_DOWN') toast(e.message, 'err');
    }
  }

  function renderApps() {
    const ul = $('#app-list');
    if (!state.apps.length) {
      ul.innerHTML = '<li class="empty">暂无应用，先上传并安装一个 APK 吧。</li>';
      return;
    }
    ul.innerHTML = '';
    for (const app of state.apps) {
      const li = document.createElement('li');
      li.className = 'app-item';
      const icon = app.iconDataUri || 'images/icon_64.png';
      const runningPill = app.running === true
        ? '<span class="pill running">运行中</span>'
        : (app.running === null ? '<span class="pill">未知</span>' : '');
      const fgPill = app.foreground ? '<span class="pill foreground">前台</span>' : '';
      li.innerHTML = `
        <img class="app-icon" src="${icon}" alt="" onerror="this.src='images/icon_64.png'" />
        <div class="app-info">
          <div class="app-title">${escapeHtml(app.label || app.package)} ${runningPill} ${fgPill}</div>
          <div class="app-sub">${escapeHtml(app.package)} · v${escapeHtml(String(app.versionName || '?'))} (${app.versionCode || '?'})</div>
        </div>
        <div class="app-actions">
          <button class="btn btn-sm" data-act="start">启动</button>
          <button class="btn btn-sm btn-ghost" data-act="stop">停止</button>
          <button class="btn btn-sm btn-danger" data-act="remove">卸载</button>
        </div>`;
      li.querySelector('[data-act="start"]').onclick = guard(async () => {
        await API.startApp(app.package);
        toast(`已启动 ${app.label || app.package}`, 'ok');
        refreshApps();
      });
      li.querySelector('[data-act="stop"]').onclick = guard(async () => {
        await API.stopApp(app.package);
        toast(`已停止 ${app.label || app.package}`, 'ok');
        refreshApps();
      });
      li.querySelector('[data-act="remove"]').onclick = guard(async () => {
        if (!window.confirm(`确定卸载 ${app.label || app.package} 吗？`)) return;
        await API.removeApp(app.package);
        toast('已卸载', 'ok');
        refreshApps();
      });
      ul.appendChild(li);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---------------- 运行时部署 ----------------
  async function startDeploy() {
    try {
      $('#btn-deploy').disabled = true;
      $('#deploy-progress-wrap').classList.remove('hidden');
      await API.deployRuntime(false);
      toast('开始下载运行时…');
      pollDeploy();
    } catch (e) {
      $('#btn-deploy').disabled = false;
      toast(e.message, 'err');
    }
  }

  function pollDeploy() {
    clearTimeout(state.deployTimer);
    const tick = async () => {
      try {
        const p = await API.deployProgress();
        renderProgress(p);
        if (p.done) {
          toast(p.error ? `部署失败：${p.error}` : '运行时部署完成', p.error ? 'err' : 'ok');
          refreshStatus();
          return;
        }
        state.deployTimer = setTimeout(tick, 800);
      } catch (e) {
        toast(e.message, 'err');
      }
    };
    tick();
  }

  function renderProgress(p) {
    if (!p) return;
    const pct = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
    $('#deploy-bar').style.width = pct + '%';
    $('#deploy-percent').textContent = pct + '%';
    const phaseLabel = {
      idle: '空闲', downloading: '下载中', extracting: '解压中', error: '出错', done: '完成',
    };
    $('#deploy-phase').textContent = phaseLabel[p.phase] || p.phase || '进行中';
    const parts = [];
    if (p.downloaded) parts.push(`${fmtBytes(p.downloaded)}${p.total ? ' / ' + fmtBytes(p.total) : ''}`);
    if (p.speedBps) parts.push(fmtSpeed(p.speedBps));
    if (p.error) parts.push(p.error);
    $('#deploy-detail').textContent = parts.join(' · ');
    if (p.done) $('#btn-deploy').disabled = false;
  }

  // ---------------- 模拟器 ----------------
  async function startEmulator() {
    const wipe = $('#chk-wipe').checked;
    try {
      await API.startEmulator(wipe);
      toast(wipe ? '模拟器启动中（已清空数据）…' : '模拟器启动中…');
      setTimeout(refreshStatus, 500);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function stopEmulator() {
    try {
      await API.stopEmulator();
      toast('正在停止模拟器…');
      setTimeout(refreshStatus, 500);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ---------------- APK 上传解析 ----------------
  async function handleFile(file) {
    if (!file) return;
    const name = file.name || '';
    if (/\.(apks|xapk)$/i.test(name)) {
      toast('暂不支持 .apks / .xapk，请上传单 APK', 'err');
      return;
    }
    if (!/\.apk$/i.test(name)) {
      toast('请选择 .apk 文件', 'err');
      return;
    }
    try {
      const vo = await API.parseApk(file);
      state.pendingApk = { uploadId: vo.uploadId, vo };
      renderApkPreview(vo);
    } catch (e) {
      toast(e.message || 'APK 解析失败', 'err');
      $('#apk-preview').classList.add('hidden');
    }
  }

  function renderApkPreview(vo) {
    const box = $('#apk-preview');
    const icon = vo.iconDataUri || 'images/icon_64.png';
    const armWarn = vo.armOnly
      ? '<div class="apk-warn">⚠️ 该 APK 仅含 ARM 库，当前运行时镜像不含 ARM 翻译层，将无法安装（P1 将支持可切换镜像）</div>'
      : '';
    box.innerHTML = `
      <img src="${icon}" alt="" onerror="this.src='images/icon_64.png'" />
      <div class="apk-meta">
        <strong>${escapeHtml(vo.label || vo.package)}</strong>
        <div>${escapeHtml(vo.package)} · v${escapeHtml(String(vo.versionName || '?'))} (${vo.versionCode || '?'})</div>
        <div>${fmtBytes(vo.sizeBytes)}${vo.abis && vo.abis.length ? ' · ' + escapeHtml(vo.abis.join(', ')) : ' · 纯 Java'}</div>
        ${armWarn}
      </div>
      <div class="apk-actions">
        <button class="btn btn-primary btn-sm" id="btn-install-apk"${vo.armOnly ? ' disabled title="当前镜像不含 ARM 翻译层"' : ''}>安装到模拟器</button>
      </div>`;
    box.classList.remove('hidden');
    const btn = $('#btn-install-apk');
    btn.onclick = guard(async () => {
      btn.disabled = true;
      btn.textContent = '安装中…';
      try {
        await API.installApp(vo.uploadId);
        toast('安装成功', 'ok');
        state.pendingApk = null;
        box.classList.add('hidden');
        $('#file-input').value = '';
        refreshApps();
        refreshStatus();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '安装到模拟器';
        throw e;
      }
    });
  }

  // ---------------- 输入 ----------------
  async function sendText(ev) {
    ev.preventDefault();
    const input = $('#text-input');
    const text = input.value;
    if (!text) return;
    try {
      await API.text(text);
      input.value = '';
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ---------------- 日志 ----------------
  async function refreshLogs() {
    try {
      const { lines } = await API.emulatorLogs(200);
      const pre = $('#log-content');
      pre.textContent = (lines && lines.length) ? lines.join('\n') : '（暂无日志）';
      pre.scrollTop = pre.scrollHeight;
    } catch (e) {
      $('#log-content').textContent = e.message || '日志获取失败';
    }
  }

  // ---------------- 事件绑定 ----------------
  function bindEvents() {
    $('#btn-deploy').onclick = startDeploy;
    $('#btn-emu-start').onclick = guard(startEmulator);
    $('#btn-emu-stop').onclick = guard(stopEmulator);
    $('#btn-refresh-apps').onclick = refreshApps;

    // 上传：点击 / 拖拽
    const dz = $('#dropzone');
    const fileInput = $('#file-input');
    dz.onclick = () => fileInput.click();
    $('#dz-pick').onclick = (e) => { e.stopPropagation(); fileInput.click(); };
    fileInput.onchange = () => handleFile(fileInput.files[0]);
    ['dragenter', 'dragover'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
    dz.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      handleFile(f);
    });

    // 键位
    document.querySelectorAll('[data-key]').forEach((btn) => {
      btn.onclick = guard(async () => { await API.key(btn.dataset.key); });
    });

    // 文本
    $('#text-form').onsubmit = sendText;

    // 日志抽屉
    $('#log-toggle').onclick = () => {
      const drawer = $('#log-drawer');
      drawer.classList.toggle('open');
      if (drawer.classList.contains('open')) refreshLogs();
    };

    // 可见性：隐藏页暂停轮询
    document.addEventListener('visibilitychange', () => {
      if (!state.screen) return;
      if (document.hidden) state.screen.stop();
      else if (state.status && state.status.emulator === 'running') state.screen.start();
    });
  }

  // ---------------- 启动 ----------------
  async function boot() {
    bindEvents();
    state.screen = new window.ScreenView({
      img: $('#screen-img'),
      overlay: $('#screen-overlay'),
      API,
      onError: (msg) => { $('#screen-overlay').textContent = msg; },
      fps: 2,
    });
    try {
      const h = await API.health();
      state.version = h.version || '-';
      $('#version-badge').textContent = 'v' + state.version;
      setConn(true);
    } catch (_) {
      setConn(false);
    }
    await refreshStatus();
    await refreshApps();
    try {
      const settings = await API.getSettings();
      if (settings && settings.screen && settings.screen.fps) state.screen.setFps(settings.screen.fps);
    } catch (_) {}

    // 状态轮询 2s
    clearInterval(state.statusTimer);
    state.statusTimer = setInterval(refreshStatus, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
