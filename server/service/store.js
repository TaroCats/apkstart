'use strict';
/**
 * 本地持久化：应用清单（apps.json）+ 全局设置（settings.json）。
 * 数据落 $TRIM_PKGVAR（见 paths.js），不再用 Windows %APPDATA%。
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths');
const { DEFAULT_SETTINGS, deepMerge } = require('../config');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) { /* ignore */ }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

class Store {
  constructor(paths = PATHS) {
    this.paths = paths;
    this.appsFile = paths.APPS_FILE;
    this.settingsFile = paths.SETTINGS_FILE;
    this.iconDir = paths.ICONS;
  }

  ensureDirs() {
    for (const d of [this.paths.APPDATA, this.iconDir]) {
      try { fs.mkdirSync(d, { recursive: true }); } catch (_) { /* ignore */ }
    }
  }

  /** @returns {object} 完整设置（默认值 + 磁盘覆盖）。 */
  getSettings() {
    return deepMerge(DEFAULT_SETTINGS, readJson(this.settingsFile, {}));
  }

  /** 部分更新（深合并），返回合并后全量。 */
  saveSettings(patch) {
    const next = deepMerge(this.getSettings(), patch || {});
    writeJson(this.settingsFile, next);
    return next;
  }

  /** @returns {object[]} */
  getApps() {
    const data = readJson(this.appsFile, { apps: [] });
    return Array.isArray(data.apps) ? data.apps : [];
  }

  saveApps(apps) {
    writeJson(this.appsFile, { apps: Array.isArray(apps) ? apps : [] });
  }

  getApp(pkg) {
    return this.getApps().find((a) => a.package === pkg) || null;
  }

  upsertApp(app) {
    const apps = this.getApps();
    const i = apps.findIndex((a) => a.package === app.package);
    if (i >= 0) apps[i] = { ...apps[i], ...app };
    else apps.push(app);
    this.saveApps(apps);
    return app;
  }

  removeApp(pkg) {
    const apps = this.getApps().filter((a) => a.package !== pkg);
    this.saveApps(apps);
  }

  /** 图标相对 $TRIM_PKGVAR 的路径（§3.1 iconFile 字段格式）。 */
  iconRelPath(pkg) {
    return `icons/${pkg}.png`;
  }

  /** 图标绝对路径。 */
  iconPath(pkg) {
    return path.join(this.iconDir, `${pkg}.png`);
  }

  /** 保存图标二进制并返回相对路径。 */
  saveIcon(pkg, buffer) {
    this.ensureDirs();
    const abs = this.iconPath(pkg);
    try { fs.writeFileSync(abs, buffer); } catch (_) { /* ignore */ }
    return this.iconRelPath(pkg);
  }

  /** 读取图标为 data URI；不存在返回空串。 */
  iconDataUri(pkg) {
    try {
      const abs = this.iconPath(pkg);
      if (!fs.existsSync(abs)) return '';
      return `data:image/png;base64,${fs.readFileSync(abs).toString('base64')}`;
    } catch (_) {
      return '';
    }
  }
}

module.exports = { Store, readJson, writeJson };
