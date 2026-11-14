'use strict';
/**
 * 运行时部署（ARCH §4.1 / §5.5）：
 *   platform-tools / emulator / system-image 三个组件
 *   → HTTP Range 断点续传下载到 $TRIM_PKGTMP/downloads/*.part
 *   → sha256（清单给了才校验，否则校验 size>0）
 *   → 解压到 $TRIM_PKGVAR/runtime（标准 SDK 布局）
 *   → 写 runtime/.deployed 标记
 * 进度通过 progress() 轮询（无需 WebSocket）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { PROVISION_MANIFEST } = require('../config');
const { checkKvmAccess } = require('./kvm');
const { ZipFile } = require('../../core/zip');

const COMPONENT_ORDER = ['platform-tools', 'emulator', 'system-image'];
const MAX_REDIRECTS = 6;

/** 发起 GET（自动跟随重定向），支持 Range 续传。 */
function httpGet(urlStr, { start = 0, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error(`下载地址无效：${urlStr}`)); }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {};
    if (start > 0) headers.Range = `bytes=${start}-`;
    const req = lib.get(u, { headers, timeout: 60000 }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error('下载重定向次数过多'));
        const next = new URL(res.headers.location, u).toString();
        return resolve(httpGet(next, { start, redirects: redirects + 1 }));
      }
      if (status !== 200 && status !== 206) {
        res.resume();
        return reject(new Error(`下载失败：HTTP ${status}`));
      }
      return resolve({ res, status });
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', (e) => reject(new Error(`下载出错：${e.message}`)));
  });
}

/** 流式解压整个 zip 到 destDir（安全：禁止路径穿越）。 */
async function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.resolve(destDir);
  const zip = new ZipFile(zipPath);
  try {
    for (const name of zip.names()) {
      if (!name || name.endsWith('/') || name.endsWith('\\')) continue;
      const out = path.resolve(base, name);
      if (out !== base && !out.startsWith(base + path.sep)) continue; // 越界跳过
      // eslint-disable-next-line no-await-in-loop
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const entry = zip.entries.get(name);
      if (!entry || entry.uncompSize === 0) {
        try {
          fs.writeFileSync(out, Buffer.alloc(0));
          const m0 = entry && entry.unixMode ? (entry.unixMode & 0o777) : 0;
          fs.chmodSync(out, (m0 & 0o111) ? 0o755 : 0o644);
        } catch (_) { /* ignore */ }
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const ws = fs.createWriteStream(out);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve, reject) => {
        ws.on('error', reject);
        ws.on('finish', resolve);
        zip.pipeTo(name, ws).catch(reject);
      });
      // 解压后按 ZIP 中央目录里的 Unix mode 还原权限位。
      // 不能靠文件名启发式：emulator 包里有 qemu-system-x86_64-headless 等
      // 名字不带目录提示的可执行文件，漏掉一个就 Permission denied（真机实测 code=13）。
      // mode 缺失时退化为 0644；任何带任一执行位的文件按 0755 落盘。
      const mode = entry && entry.unixMode ? (entry.unixMode & 0o777) : 0;
      let finalMode = 0o644;
      if (mode & 0o111) finalMode = 0o755;
      else if (mode & 0o777) finalMode = mode;
      try { fs.chmodSync(out, finalMode); } catch (_) { /* ignore */ }
    }
  } finally {
    zip.close();
  }
}

class Provision {
  constructor({ paths }) {
    this.paths = paths;
    const m = (this._m = Object.create(null));
    this.state = {
      taskId: null,
      phase: 'idle', // idle | downloading | extracting | error
      percent: 0,
      downloaded: 0,
      total: 0,
      speedBps: 0,
      done: false,
      error: null,
      current: '',
    };
    this._running = false;
  }

  /** 组件绝对 marker 路径。 */
  _markerPath(comp) {
    return path.join(this.paths.RUNTIME, comp.marker);
  }

  _isComponentReady(comp) {
    try { return fs.existsSync(this._markerPath(comp)); } catch (_) { return false; }
  }

  /** @returns {{deployed:boolean, adbOk:boolean, emulatorOk:boolean, imageOk:boolean, kvm:object}} */
  status() {
    const adbOk = this._isComponentReady(PROVISION_MANIFEST['platform-tools']);
    const emulatorOk = this._isComponentReady(PROVISION_MANIFEST.emulator);
    const imageOk = this._isComponentReady(PROVISION_MANIFEST['system-image']);
    const deployed = fs.existsSync(this.paths.RUNTIME_MARKER) && adbOk && emulatorOk && imageOk;
    return { deployed, adbOk, emulatorOk, imageOk, kvm: checkKvmAccess() };
  }

  /** 当前进度快照。 */
  progress() {
    const s = this.state;
    return {
      phase: s.phase,
      percent: Math.round(s.percent),
      downloaded: s.downloaded,
      total: s.total,
      speedBps: s.speedBps,
      done: s.done,
      error: s.error,
    };
  }

  /**
   * 启动部署（异步）。已在进行时抛 CONFLICT（由 api 层转换）。
   * @returns {{taskId:string, state:string}}
   */
  deploy({ force = false, settings } = {}) {
    if (this._running) {
      const err = new Error('运行时正在部署中，请勿重复发起');
      err.code = 'CONFLICT';
      throw err;
    }
    const taskId = `rt_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
    this.state = {
      taskId, phase: 'downloading', percent: 0, downloaded: 0, total: 0,
      speedBps: 0, done: false, error: null, current: '',
    };
    this._running = true;
    // 后台执行，不阻塞 HTTP 响应
    this._run({ force, settings }).catch((e) => {
      this.state.phase = 'error';
      this.state.error = e && e.message ? e.message : String(e);
      this.state.done = false;
      this._running = false;
    });
    return { taskId, state: 'running' };
  }

  async _run({ force, settings }) {
    const baseUrl = (settings && settings.runtime && settings.runtime.baseUrl)
      || 'https://dl.google.com/android/repository';
    fs.mkdirSync(this.paths.DOWNLOADS, { recursive: true });
    fs.mkdirSync(this.paths.RUNTIME, { recursive: true });

    const comps = COMPONENT_ORDER.map((k) => PROVISION_MANIFEST[k]);
    const n = comps.length;

    for (let i = 0; i < n; i += 1) {
      const comp = comps[i];
      // eslint-disable-next-line no-await-in-loop
      const ready = this._isComponentReady(comp);
      if (ready && !force) {
        this.state.percent = ((i + 1) / n) * 100;
        continue;
      }
      this.state.current = comp.name;
      const url = `${baseUrl.replace(/\/$/, '')}/${comp.relPath}`;
      // eslint-disable-next-line no-await-in-loop
      const zipPath = await this._downloadOne(comp, url, i, n);

      this.state.phase = 'extracting';
      const destDir = comp.extractDir
        ? path.join(this.paths.RUNTIME, comp.extractDir)
        : this.paths.RUNTIME;
      // eslint-disable-next-line no-await-in-loop
      await extractZip(zipPath, destDir);
      // 解压后删除 zip 节省空间（system-image 很大）
      try { fs.rmSync(zipPath, { force: true }); } catch (_) { /* ignore */ }
      this.state.phase = 'downloading';
      this.state.percent = ((i + 1) / n) * 100;
    }

    // 写部署完成标记
    fs.writeFileSync(
      this.paths.RUNTIME_MARKER,
      JSON.stringify({ deployedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
    this.state.phase = 'idle';
    this.state.percent = 100;
    this.state.done = true;
    this._running = false;
  }

  /** 单组件下载（Range 续传 + sha/size 校验），返回 zip 绝对路径。 */
  async _downloadOne(comp, url, index, n) {
    const partPath = path.join(this.paths.DOWNLOADS, `${comp.fileName}.part`);
    let start = 0;
    try { start = fs.statSync(partPath).size; } catch (_) { start = 0; }

    const { res, status } = await httpGet(url, { start });
    // 服务器不支持 Range（200）→ 从头覆盖
    const append = status === 206 && start > 0;
    if (!append) start = 0;
    const baseFrac = index / n;
    const stepFrac = 1 / n;

    const contentLen = Number(res.headers['content-length'] || 0);
    let total = 0;
    const cr = res.headers['content-range'];
    if (cr) {
      const m = /\/(\d+)$/.exec(cr);
      if (m) total = Number(m[1]);
    } else if (contentLen) {
      total = contentLen + (append ? start : 0);
    }
    this.state.total = total;
    this.state.downloaded = start;

    const hash = crypto.createHash('sha256');
    if (append) {
      // 续传：先把已有部分读入哈希
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(partPath);
        rs.on('data', (c) => hash.update(c));
        rs.on('error', reject);
        rs.on('end', resolve);
      });
    }

    const ws = fs.createWriteStream(partPath, { flags: append ? 'a' : 'w' });

    await new Promise((resolve, reject) => {
      let downloaded = append ? start : 0;
      let lastTick = Date.now();
      let lastBytes = downloaded;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        hash.update(chunk);
        this.state.downloaded = downloaded;
        if (total > 0) {
          this.state.percent = (baseFrac + stepFrac * Math.min(1, downloaded / total)) * 100;
        }
        const now = Date.now();
        if (now - lastTick >= 500) {
          this.state.speedBps = Math.round(((downloaded - lastBytes) * 1000) / (now - lastTick));
          lastTick = now;
          lastBytes = downloaded;
        }
      });
      res.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      res.pipe(ws);
    });

    const size = fs.statSync(partPath).size;
    if (size <= 0) throw new Error(`下载内容为空：${comp.fileName}`);

    // 校验：sha256 为空则只校验 size>0
    if (comp.sha256) {
      const actual = hash.digest('hex');
      if (actual.toLowerCase() !== comp.sha256.toLowerCase()) {
        try { fs.rmSync(partPath, { force: true }); } catch (_) { /* ignore */ }
        throw new Error(`校验失败（SHA256 不匹配）：${comp.fileName}，已删除分片`);
      }
    }

    const finalPath = path.join(this.paths.DOWNLOADS, comp.fileName);
    try { fs.rmSync(finalPath, { force: true }); } catch (_) { /* ignore */ }
    fs.renameSync(partPath, finalPath);
    return finalPath;
  }
}

module.exports = { Provision, extractZip, httpGet, COMPONENT_ORDER };
