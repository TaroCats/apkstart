'use strict';
/**
 * KVM 可用性检测（ARCH §1.1 / Q4）。
 * - available：/dev/kvm 是否存在（存在即表示内核有 KVM 模块）
 * - writable ：当前进程（package 用户）是否可读写 /dev/kvm（决定 -accel on/off）
 * - group    ：/dev/kvm 所属组名（Linux 常为 kvm 或 all.editor），便于 UI 提示
 * 非 Linux / 无 /dev/kvm 时统一返回 available=false。
 */
const fs = require('fs');
const path = require('path');

const KVM_DEV = '/dev/kvm';

/** 从 /etc/group 里按 gid 反查组名（取不到则返回数字字符串）。 */
function groupNameOf(gid) {
  try {
    const text = fs.readFileSync('/etc/group', 'utf8');
    for (const line of text.split('\n')) {
      const parts = line.split(':');
      if (parts.length >= 3 && Number(parts[2]) === gid) return parts[0];
    }
  } catch (_) { /* ignore */ }
  return gid != null ? String(gid) : '';
}

/**
 * @param {string} [dev]
 * @returns {{available:boolean, writable:boolean, group:string}}
 */
function checkKvmAccess(dev = KVM_DEV) {
  const info = { available: false, writable: false, group: '' };
  let st;
  try {
    st = fs.statSync(dev);
  } catch (_) {
    return info; // 不存在
  }
  info.available = true;
  info.group = groupNameOf(typeof st.gid === 'number' ? st.gid : null);
  try {
    fs.accessSync(dev, fs.constants.R_OK | fs.constants.W_OK);
    info.writable = true;
  } catch (_) {
    info.writable = false;
  }
  return info;
}

module.exports = { checkKvmAccess, KVM_DEV, groupNameOf };
