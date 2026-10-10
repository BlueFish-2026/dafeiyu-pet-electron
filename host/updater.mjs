/**
 * dsh-pet 独立版 —— 内置自动更新
 *
 * 背景：可运行整包里 348MB 是 Electron 引擎（几乎不变），我们自己写的代码（host/pet/web）
 * 加起来才几百 KB。每次发版都重传整包纯属浪费 —— 这里让宠物自己联网、只拉改动的小文本文件。
 *
 * 运作：
 *   - 版本清单 `version.json`（仓库根，含 { version, notes, files }）走 raw.githubusercontent 的 main 分支；
 *   - 逐个下载清单里的文件 → **全部成功才一次性落盘**（先写 .tmp 再 rename，原子替换）→ 调用方重启生效。
 *
 * 只同步「纯文本源码」：host/*.mjs、pet/*(js|html|json)、web/admin.html、
 * config/pet-config.default.json、README.md、CHANGELOG.md。
 * 🚫 bin/（Electron 引擎）与 assets/（106 个 webm 二进制）太大，不进本次同步 —— 它们变了必须整包重装。
 *
 * 约定：仓库 main 分支 = 已确认的正式代码（见项目推送纪律），所以「拉 main」=「拉最新确定版」。
 * 因此发版时只要把代码推到 GitHub，用户的宠物点「立即更新」就能自己升级，无需再传大包。
 */
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { APP_VERSION } from './version.mjs';

const REPO = 'BlueFish-2026/dafeiyu-pet-electron';
const BRANCH = 'main';
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

// —— 网络栈选择（大肥鱼独立版注入）——
// 优先走 Electron 的 Chromium 网络栈（net.fetch）：
//   ① 信任「Windows 系统证书库」——用户开着 Watt Toolkit/Steam++ 这类 hosts 反代加速器时，
//      它的自签根证书只装在系统库里，Node 内置 fetch（自带 OpenSSL CA）不认 → fetch failed；
//   ② 自动跟随系统代理——浏览器能上 GitHub 的机器，宠物也能。
// 普通 Node 环境（探针测试）拿不到 electron 模块 → 回落内置 fetch。
let electronNet = null;
try {
  electronNet = (await import('electron')).net;
} catch {
  /* 普通 Node 环境，走内置 fetch */
}

export function currentVersion() {
  return APP_VERSION;
}

/** 比较语义化版本：a>b 返 1，a<b 返 -1，相等返 0（容忍 v 前缀、缺位按 0 补） */
export function compareVersion(a, b) {
  const norm = (s) =>
    String(s ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 只接受仓库内的相对路径（挡掉绝对路径 / 上跳 / 盘符，防清单被塞恶意路径写到仓库外） */
function safeRel(rel) {
  const n = String(rel).replace(/\\/g, '/').trim();
  if (!n || n.startsWith('/') || n.includes('..') || /^[A-Za-z]:/.test(n)) return null;
  return n;
}

/** Electron net.fetch 与 Node fetch 的参数差异：net.fetch 不吃 cache 选项（防缓存靠 ts= 时间戳已够） */
async function rawFetch(url, opts = {}) {
  if (electronNet?.fetch) {
    return electronNet.fetch(url, {
      method: 'GET',
      headers: opts.headers,
      signal: opts.signal,
      bypassCustomProtocolHandlers: true,
    });
  }
  return fetch(url, opts);
}

async function fetchText(rel) {
  const url = RAW + rel + (rel.includes('?') ? '&' : '?') + 'ts=' + Date.now();
  const opts = {
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
    headers: { 'cache-control': 'no-cache' },
  };
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await rawFetch(url, opts);
      if (!res.ok) throw new Error(`${rel} → HTTP ${res.status}`);
      return res.text();
    } catch (e) {
      lastErr = e; // 网络抖动重试一次；第二次仍失败才抛出
    }
  }
  throw lastErr;
}

/**
 * 查最新版（只读，不落盘）。
 * @returns {Promise<{current:string, latest:string, hasUpdate:boolean, notes:string, files:string[]}>}
 */
export async function checkUpdate() {
  const manifest = JSON.parse(await fetchText('version.json'));
  const latest = String(manifest.version || '');
  const files = Array.isArray(manifest.files) ? manifest.files.filter((f) => safeRel(f)) : [];
  return {
    current: APP_VERSION,
    latest,
    hasUpdate: compareVersion(latest, APP_VERSION) > 0,
    notes: manifest.notes ? String(manifest.notes) : '',
    files,
  };
}

/**
 * 应用更新：先把清单里所有文件下载到内存（任何一个失败就整体放弃、不落盘），
 * 全部拿到后再逐个原子替换 —— 避免「下到一半失败把程序写坏」。
 * @param {string} rootDir 安装根目录
 * @param {string[]} files 相对路径清单
 * @param {(done:number,total:number,rel:string)=>void} [onProgress]
 * @returns {Promise<string[]>} 实际写入的相对路径
 */
export async function applyUpdate(rootDir, files, onProgress) {
  const list = (files || []).map(safeRel).filter(Boolean);
  const loaded = [];
  for (let i = 0; i < list.length; i++) {
    const rel = list[i];
    loaded.push([rel, await fetchText(rel)]);
    if (onProgress) onProgress(i + 1, list.length, rel);
  }
  const written = [];
  for (const [rel, text] of loaded) {
    const dest = join(rootDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = dest + '.dshupdate.tmp';
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, dest);
    written.push(rel);
  }
  return written;
}
