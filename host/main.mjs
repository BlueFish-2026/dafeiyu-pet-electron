/**
 * dsh-pet 独立版 —— 宿主主进程（Electron）
 *
 * 为什么宿主是 Electron 而不是纯 Node：
 *   - powerMonitor.getSystemIdleTime() —— 判断「人还在不在电脑前」，久坐提醒的关键，
 *     纯 Node 得靠 PowerShell 调 user32.dll，慢且脆；
 *   - Notification —— 原生系统通知，右下角 toast；
 *   两者都是内置能力，零额外依赖。
 *
 * 职责：
 *   ① 起本地 HTTP 服务，实现 helper（宠物渲染进程）需要的全部端点
 *   ② 跑提醒引擎，触发时推 /work-status（切动画 + 弹气泡）并发系统通知
 *   ③ spawn 并看管 Electron helper —— 就是那个画宠物的透明置顶小窗
 *   ④ 提供管理页面（浏览器打开 http://127.0.0.1:<port>/admin 即可改提醒）
 *
 * helper 侧一行未改：它由环境变量驱动（DSH_PET_CONFIG_URL / DSH_PET_HOST_PID），
 * 并且从不设 DSH_PET_BRIDGE 时走 HTTP 直连宿主——正是为「手动 start-desktop」预留的路径。
 */

import { app, powerMonitor, Notification, dialog, Tray, Menu, shell, nativeImage } from 'electron';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from 'node:fs';
import { join, extname, normalize, resolve, sep, dirname } from 'node:path';

import { fileURLToPath } from 'node:url';

import { ROOT, DATA_DIR, ensureDirs, loadUserConfig, saveUserConfig, buildPetConfig, loadDefaultPetConfig } from './config.mjs';
import { queryBalance, resolveApiKey } from './balance.mjs';
import { ReminderEngine } from './reminders.mjs';

const PREFIX = '/dsh-pet-7340';
const HOST_NAME = 'dsh-pet-standalone';

const ELECTRON_EXE = join(ROOT, 'bin', 'electron', 'electron.exe');
const HELPER_MAIN = join(ROOT, 'pet', 'main.js');
/** 本文件（宿主入口）—— 重启时用它拼出与双击快捷方式等价的启动命令 */
const HOST_MAIN = fileURLToPath(import.meta.url);
const ASSETS = join(ROOT, 'assets');
const WEB_DIR = join(ROOT, 'web');

const RUNTIME_FILE = join(DATA_DIR, 'runtime.json');
const STATE_FILE = join(DATA_DIR, 'reminder-state.json');
const HELPER_LOG = join(DATA_DIR, 'helper.log');
const HOST_LOG = join(DATA_DIR, 'host.log');

const MIME = {
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// ---------------------------------------------------------------- 日志

ensureDirs();

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(HOST_LOG, line + '\n', 'utf8');
  } catch {
    /* 日志写不进去也不能影响主流程 */
  }
}

/** 滚动日志：超过 2MB 就清空重来，避免无限增长 */
function rotateIfBig(path, limit = 2 * 1024 * 1024) {
  try {
    if (existsSync(path) && readFileSync(path).length > limit) writeFileSync(path, '', 'utf8');
  } catch {
    /* ignore */
  }
}

/**
 * 致命错误：写日志 + 弹系统对话框再退出。
 * 宿主没有窗口，不弹框的话用户双击启动后只会「什么都没发生」，无从判断是坏了还是没启动。
 */
function fatal(text, detail) {
  log(`致命：${text}${detail ? ' — ' + detail : ''}`);
  try {
    dialog.showErrorBox('大肥鱼桌宠 · 启动失败', `${text}\n\n${detail ?? ''}\n\n详细日志：data\\host.log`);
  } catch {
    /* 对话框弹不出来也必须退出，不能留个半死不活的进程 */
  }
  app.exit(1);
}

// ---------------------------------------------------------------- 全局状态

let userCfg = null;
let petConfig = null;
let apiKeyInfo = { key: undefined, from: '未初始化' };
let httpPort = 0;

/**
 * 诊断用：渲染进程有没有回来取过配置。
 * helper 启动后的第一件事就是 GET /config —— 所以这个标记是「宠物到底有没有
 * 认下宿主」的硬证据，出问题时靠它在 host.log 里区分「链路没通」和「窗口看不见」。
 */
let helperFetchedConfig = false;

/** 工作状态快照 —— 提醒就是靠它推到宠物的（见 fireReminder） */
let workStatus = { state: null, task: null, ts: 0 };
/** 余额手动触发计数（渲染端 1s 轮询，count 变化即重播余额动画） */
let balanceTriggerCount = 0;
/** 气泡广播缓存：petId → { text, image, ts } */
const broadcastCache = new Map();
/** 提醒收起定时器句柄（连续触发时用于取消上一个） */
const bubbleTimers = new Map();

// ---------------------------------------------------------------- 工具

/** 把 URL 段安全地拼到根目录下；越根返回 undefined */
function safeJoin(root, rel) {
  const cleaned = String(rel ?? '').replace(/\\/g, '/');
  if (cleaned.includes('\0')) return undefined;
  const full = normalize(join(root, cleaned));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(rootWithSep)) return undefined;
  return full;
}

/** 解析出真实存在的文件；支持「请求无扩展名时补 .png」的兜底（素材里 cursor-grab 等就是这种） */
function resolveAsset(root, rel) {
  let p = safeJoin(root, rel);
  if (!p) return undefined;
  if (existsSync(p) && !isDir(p)) return p;
  // 无扩展名 → 试常见图片扩展
  if (!extname(p)) {
    for (const ext of ['.png', '.webp', '.gif', '.jpg']) {
      if (existsSync(p + ext)) return p + ext;
    }
  }
  return undefined;
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sendJson(res, status, obj, headers = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendText(res, status, text) {
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function sendFile(res, file) {
  const ext = extname(file).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return sendText(res, 404, 'dsh-pet: asset vanished');
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': size,
    'cache-control': 'public, max-age=86400',
    'accept-ranges': 'bytes',
  });
  const stream = createReadStream(file);
  stream.on('error', () => {
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  });
  stream.pipe(res);
}

function readBody(req) {
  return new Promise((done) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => done(''));
  });
}

// ---------------------------------------------------------------- 提醒 → 宠物

/**
 * 触发一次提醒。
 *
 * 走 /work-status 通道的理由：渲染端 events.js 第 75 行是
 *     this.workText = (snapshot && snapshot.task) || configuredText || null;
 * ——任务详情**优先**且是任意字符串，所以一条通道就能同时拿到「专属档位动画 + 任意文案」。
 *
 * 时序（渲染端 1s 轮询，故间隔取 1.5s 保证两次变化都被看到）：
 *   t=0      state=null    → 先把状态清空，保证接下来那次 stateChanged 为 true
 *   t=1.5s   state=目标档位 → 点亮气泡 + 播档位动画
 *   t=N      state=null    → 收起，为下次做准备
 */
function fireReminder(kind, text) {
  const bubbleMs = Math.max(5, Number(userCfg.bubbleSeconds) || 20) * 1000;
  // 久坐 → 档位 3「等待」（原地踱步张望 / 伸懒腰，循环播）
  // 定时 → 档位 4「完成」（雀跃庆祝，播一遍）
  const state = kind === 'sedentary' ? 'waiting' : 'success';

  if (bubbleTimers.has(kind)) clearTimeout(bubbleTimers.get(kind));

  workStatus = { state: null, task: null, ts: Date.now() };

  const t1 = setTimeout(() => {
    workStatus = { state, task: text, ts: Date.now() };
    log(`提醒触发 [${kind}] ${text}`);

    if (userCfg.systemNotification) {
      try {
        if (Notification.isSupported()) {
          const icon = join(ASSETS, 'pic', kind === 'sedentary' ? 'notify-question.png' : 'notify-done.png');
          new Notification({
            title: kind === 'sedentary' ? '该起来动动了' : '提醒',
            body: text,
            icon: existsSync(icon) ? icon : undefined,
            silent: false,
          }).show();
        }
      } catch (e) {
        log('系统通知失败：' + (e && e.message));
      }
    }

    const t2 = setTimeout(() => {
      workStatus = { state: null, task: null, ts: Date.now() };
      bubbleTimers.delete(kind);
    }, bubbleMs);
    bubbleTimers.set(kind, t2);
  }, 1500);

  bubbleTimers.set(kind + ':pre', t1);
}

/** 把提醒文本作为气泡广播（备用通道：任意文本，但动画固定为 events.whisper） */
function broadcast(petId, text) {
  broadcastCache.set(petId, { text, ts: Date.now() });
}

// ---------------------------------------------------------------- 路由

async function handleRoute(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = decodeURIComponent(url.pathname);

  // ---------- 根路径 → 管理页 ----------
  // 用户只输 http://127.0.0.1:<port> 时不该看到 404 白页，直接送到设置页。
  if (path === '/' || path === '/index.html') {
    res.writeHead(302, { Location: '/admin' });
    return res.end();
  }

  // ---------- 管理页与 API ----------
  if (path === '/admin' || path === '/admin/') {
    const f = join(WEB_DIR, 'admin.html');
    if (!existsSync(f)) return sendText(res, 404, 'admin.html 缺失');
    return sendFile(res, f);
  }
  if (path.startsWith('/api/')) {
    return handleApi(path, req, res, url);
  }

  // ---------- 优雅退出 ----------
  // 「退出大肥鱼」脚本先打这个端点，让宿主走完 before-quit（存提醒状态、收掉渲染进程），
  // 请求不通时才退化成强杀。绑定在 127.0.0.1 上，外部访问不到。
  if (path === '/shutdown') {
    sendJson(res, 200, { ok: true });
    log('收到退出请求，正在关闭…');
    setTimeout(() => app.quit(), 300);
    return;
  }

  if (!path.startsWith(PREFIX)) return sendText(res, 404, 'dsh-pet-standalone');

  const rest = path.slice(PREFIX.length + 1);

  // ---------- 配置 ----------
  if (rest === 'config') {
    // 渲染端只读；独立版的配置改走管理页/配置文件
    //
    // 这里打的日志是关键诊断锚点：helper 起来后第一件事就是取配置。
    // 它一旦出现在 host.log，就说明渲染进程已经把宿主认下来了，宠物窗口此时
    // 应当已经创建 —— 若界面上仍看不到，问题就出在窗口可见性上（被全屏程序盖住、
    // 置顶被系统策略拦、或宠物被拖到了屏幕边界外），而不是插件链路没通。
    if (!helperFetchedConfig) {
      helperFetchedConfig = true;
      log('渲染进程已连上并取走配置 —— 宠物窗口应当已经创建');
    }
    return sendJson(res, 200, petConfig);
  }

  // ---------- 余额 ----------
  if (rest === 'balance') {
    const result = await queryBalance(apiKeyInfo.key);
    return sendJson(res, 200, result);
  }
  if (rest === 'balance/trigger') {
    return sendJson(res, 200, { count: balanceTriggerCount }, { 'cache-control': 'no-cache, no-store' });
  }

  // ---------- 工作状态（提醒通道） ----------
  if (rest === 'work-status') {
    return sendJson(res, 200, workStatus, { 'cache-control': 'no-cache, no-store' });
  }

  // ---------- 气泡广播 ----------
  if (rest === 'broadcast') {
    const petId = url.searchParams.get('pet') ?? 'main';
    const hit = broadcastCache.get(petId);
    return sendJson(
      res,
      200,
      { ok: true, text: hit?.text ?? '', image: hit?.image, ts: hit?.ts ?? 0 },
      { 'cache-control': 'no-cache, no-store' },
    );
  }

  // ---------- 独立版没有的能力：显式返回空，不报错 ----------
  // 碎碎念要 LLM、对话要 LLM、notify 是 DSH 事件驱动 —— 独立版一律静默
  if (rest === 'whisper' || rest === 'whisper/trigger') {
    return sendJson(res, 200, { ok: false, reason: 'unsupported', message: '独立版未启用碎碎念' });
  }
  if (rest === 'chat') {
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, messages: [], rounds: 0 });
    return sendJson(res, 200, { ok: false, reason: 'unsupported', message: '独立版未启用对话' });
  }
  if (rest === 'notify') {
    return sendJson(res, 200, { ok: true, seq: 0, frames: [] }, { 'cache-control': 'no-cache, no-store' });
  }
  if (rest === 'config/meta') {
    return sendJson(res, 200, { user: join(ROOT, 'config', 'user-config.json'), default: join(ROOT, 'config', 'pet-config.default.json') });
  }

  // ---------- 静态素材 ----------
  const [scope, ...restParts] = rest.split('/');

  if (scope === 'font') {
    const file = resolveAsset(join(ASSETS, 'fonts'), restParts.join('/'));
    if (!file) return sendText(res, 404, 'dsh-pet: font not found');
    return sendFile(res, file);
  }

  if (scope === 'pic') {
    const isMeme = restParts[0] === 'memes';
    const root = join(ASSETS, isMeme ? 'memes' : 'pic');
    const file = resolveAsset(root, (isMeme ? restParts.slice(1) : restParts).join('/'));
    if (!file) return sendText(res, 404, 'dsh-pet: pic not found');
    return sendFile(res, file);
  }

  if (scope === 'thumb') {
    // /thumb/<petId>/<file> —— 独立版只有一个素材池，petId 只用于校验形状
    const [, ...nameParts] = restParts;
    if (nameParts.length === 0) return sendText(res, 400, 'dsh-pet: expected /thumb/<petId>/<file>');
    const fileName = nameParts.join('/');
    const ext = extname(fileName).toLowerCase();
    if (ext !== '.webm' && ext !== '.mov') return sendText(res, 400, 'dsh-pet: unsupported format');

    // 用户自定义素材优先（放 data/animations/ 即可覆盖同名动画）
    const userDir = join(DATA_DIR, 'animations');
    let file = existsSync(userDir) ? resolveAsset(userDir, fileName) : undefined;
    if (!file) file = resolveAsset(join(ASSETS, 'webm'), fileName);
    if (!file) return sendText(res, 404, 'dsh-pet: asset not found');
    return sendFile(res, file);
  }

  return sendText(res, 400, 'dsh-pet: unknown route ' + rest);
}

// ---------------------------------------------------------------- 管理 API

async function handleApi(path, req, res, url) {
  const action = path.slice('/api/'.length);

  // 当前状态（管理页加载时拉一次）
  if (action === 'state' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      port: httpPort,
      config: userCfg,
      keySource: apiKeyInfo.from,
      hasKey: !!apiKeyInfo.key,
      petConfigPath: join(ROOT, 'config', 'user-config.json'),
      version: app.getVersion(),
      reminderState: reminder.exportState(),
    });
  }

  // 保存整份用户配置（管理页表单提交）
  if (action === 'config' && req.method === 'POST') {
    const body = await readBody(req);
    let incoming;
    try {
      incoming = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    // 端口不允许热改（要重启），其余字段合并保存
    const merged = { ...userCfg, ...incoming, port: userCfg.port };
    saveUserConfig(merged);
    const oldKey = apiKeyInfo.key;
    userCfg = merged;
    petConfig = buildPetConfig(userCfg);
    apiKeyInfo = resolveApiKey(userCfg);
    log(`配置已更新（密钥来源：${apiKeyInfo.from}）`);
    pushPetConfigChanged();
    if (oldKey !== apiKeyInfo.key) balanceTriggerCount++;
    return sendJson(res, 200, { ok: true, config: userCfg });
  }

  // 手动触发一次提醒（管理页「试一下」按钮）
  if (action === 'test' && req.method === 'POST') {
    const kind = url.searchParams.get('kind') === 'sedentary' ? 'sedentary' : 'schedule';
    const text = url.searchParams.get('text') || (kind === 'sedentary' ? '测试：该起来动动啦' : '测试：提醒时间到了');
    fireReminder(kind, text);
    return sendJson(res, 200, { ok: true });
  }

  // 立刻刷新余额（管理页「立即刷新」）
  if (action === 'balance-refresh' && req.method === 'POST') {
    balanceTriggerCount++;
    return sendJson(res, 200, { ok: true, count: balanceTriggerCount });
  }

  // 重启（右键菜单「重启大肥鱼」）——与托盘那一项同一条链路：拉新实例 + 退出自己。
  // 先把响应发出去再重启：否则渲染端那个 fetch 会因为连接被掐断而报错。
  if (action === 'restart' && req.method === 'POST') {
    sendJson(res, 200, { ok: true, restarting: true });
    setTimeout(() => restartApp(), 300);
    return;
  }

  // 久坐计时快照（宠物头顶计时角标每秒轮询；禁止缓存，否则角标不刷新）
  if (action === 'seat-timer' && req.method === 'GET') {
    return sendJson(res, 200, reminder.getSeatInfo(), { 'cache-control': 'no-store' });
  }

  // 手动重置久坐计时（托盘 / 宠物右键菜单「重置久坐计时」）——把本次就座时间归零、从此刻重新计。
  // 不重启渲染进程：角标是 1s 轮询的，下一个周期自然读到 minutes=0 就自己隐藏了。
  if (action === 'seat-reset' && req.method === 'POST') {
    const r = reminder.resetSeat();
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  // 只改宠物大小（右键菜单「调整大小」）——管理页是整份 POST /api/config，
  // 而渲染端手里只有**宠物配置**、拿不到 userCfg（含端口/密钥/提醒），
  // 所以给它一个只动一个字段的窄接口。落盘 + 重启渲染进程，与改配置同一套链路。
  if (action === 'pet-size' && req.method === 'POST') {
    const raw = Number(url.searchParams.get('size'));
    if (!Number.isFinite(raw) || raw <= 0) {
      return sendJson(res, 400, { ok: false, error: 'size 必须是正数' });
    }
    const size = Math.round(Math.min(900, Math.max(80, raw)));
    const merged = { ...userCfg, pet: { ...(userCfg.pet ?? {}), size } };
    saveUserConfig(merged);
    userCfg = merged;
    petConfig = buildPetConfig(userCfg);
    log(`宠物大小已改为 ${size}（来自右键菜单）`);
    pushPetConfigChanged();
    return sendJson(res, 200, { ok: true, size });
  }

  // 右键菜单里的开关项（久坐 / 定时 / 余额 / 系统通知）——同样是窄接口。
  // 白名单字段 + 类型/范围校验，避免渲染端越权改到端口、密钥、提醒数组这些东西。
  // 只在真正影响**渲染进程外观**时才重启它；否则原地生效，不闪窗。
  if (action === 'pet-toggle' && req.method === 'POST') {
    const key = url.searchParams.get('key') || '';
    const valRaw = url.searchParams.get('value');
    const patch = {};

    if (key === 'sedentary' || key === 'schedule' || key === 'balance' || key === 'notify') {
      const on = valRaw === '1' || valRaw === 'true';
      if (key === 'sedentary') patch.sedentary = { ...userCfg.sedentary, enabled: on };
      else if (key === 'schedule') {
        // 定时提醒总开关：不动已有条目，只翻总开关（reminders.mjs 的 tickSchedules 认这个字段）
        patch.scheduleEnabled = on;
      } else if (key === 'balance') patch.balance = { ...userCfg.balance, enabled: on };
      else patch.systemNotification = on;
    } else if (key === 'sed-minute') {
      const n = Math.round(Number(valRaw));
      if (!Number.isFinite(n) || n < 1 || n > 600) {
        return sendJson(res, 400, { ok: false, error: '久坐时长须在 1～600 分钟' });
      }
      patch.sedentary = { ...userCfg.sedentary, intervalMin: n };
    } else if (key === 'corner') {
      const ALLOWED = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];
      if (!ALLOWED.includes(String(valRaw))) {
        return sendJson(res, 400, { ok: false, error: 'corner 非法' });
      }
      // 与设置页「起始角落」同语义：写 corner 并回到初始位置（渲染进程重启后按新角落摆）
      patch.pet = { ...userCfg.pet, corner: String(valRaw) };
    } else {
      return sendJson(res, 400, { ok: false, error: 'unknown key: ' + key });
    }

    const merged = { ...userCfg, ...patch };
    saveUserConfig(merged);
    userCfg = merged;
    log(`右键菜单改了设置：${key} = ${valRaw}`);

    // 哪些改动渲染进程需要重启才能看到：
    //   balance.enabled → 决定「查看余额」菜单项在不在、余额动画开不开
    //   pet.corner      → 窗口起始位置
    // 其余（久坐/定时/通知）是宿主自己的提醒逻辑，原地生效。
    if (key === 'balance' || key === 'corner') {
      petConfig = buildPetConfig(userCfg);
      pushPetConfigChanged();
    }
    return sendJson(res, 200, { ok: true, key, value: valRaw });
  }

  // 右键菜单的「详细设置…」= 打开管理页（与托盘那一项同一套）
  if (action === 'open-admin' && req.method === 'POST') {
    openAdmin();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { ok: false, error: 'unknown api: ' + action });
}

/**
 * 配置变了（比如改了宠物尺寸）→ 重启 helper 让它重新拉 /config。
 * helper 只在启动时拉一次配置，所以改外观必须重启它。
 */
function pushPetConfigChanged() {
  log('宠物配置已变化，重启渲染进程以生效');
  restartHelper();
}

// ---------------------------------------------------------------- 提醒引擎

let reminder = null;

function initReminders() {
  reminder = new ReminderEngine({
    getConfig: () => userCfg,
    getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    onFire: (kind, text) => fireReminder(kind, text),
    log: (m) => log('[提醒] ' + m),
  });

  // 载入上次的触发记录（避免重启后重复提醒）
  try {
    if (existsSync(STATE_FILE)) reminder.importState(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
  } catch (e) {
    log('提醒状态载入失败（忽略）：' + (e && e.message));
  }

  reminder.start();

  // 每 60s 落盘一次状态
  const saveTimer = setInterval(() => {
    try {
      writeFileSync(STATE_FILE, JSON.stringify(reminder.exportState()), 'utf8');
    } catch {
      /* ignore */
    }
  }, 60_000);
  if (saveTimer.unref) saveTimer.unref();
}

// ---------------------------------------------------------------- helper 进程

let helperProc = null;
let helperRestarts = 0;
let stopping = false;
let restarting = false;
let helperTimer = null;

/**
 * 重启交接标记：新实例带着它启动时，若发现端口还被旧实例占着，会等旧实例让出来再继续，
 * 而不是把自己当成「重复启动」直接退出（详见 startServer）。
 */
const RESTART_HANDOFF_ARG = '--restart-handoff';
/**
 * 本次会话起过的**所有**渲染进程 PID。
 * 正常情况下一刻只有一个（换尺寸 = 杀旧起新），但万一将来又出现重复 spawn，
 * 退出时靠这个集合把这些进程全收掉，不给用户留一桌面收不掉的宠物。
 */
const helperPids = new Set();

function startHelper() {
  if (stopping) return;
  // 同一时刻只允许一个渲染进程 —— 否则桌面上会同时浮出两只宠物
  if (helperProc) detachHelper(helperProc);
  rotateIfBig(HELPER_LOG);

  const env = { ...process.env };
  // 关键：宿主自己就是以 ELECTRON_RUN_AS_NODE=1 启动的，原样透传会让 helper 退化成纯 Node 模式，
  // 内置 electron 模块不注册 → require('electron') 直接失败 → 桌宠永远不出现。
  // （helper 的 helperSpawnEnv 也会删一次，这里是第二道保险。）
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  env.DSH_PET_CONFIG_URL = `http://127.0.0.1:${httpPort}${PREFIX}/config`;
  env.DSH_PET_HOST_PID = String(process.pid);
  env.DSH_PET_PETS = JSON.stringify(
    (petConfig?.main?.pets ?? []).map((p) => ({ id: p.id, size: p.size })),
  );

  log(`启动渲染进程：${ELECTRON_EXE} ${HELPER_MAIN}`);

  // GPU 相关开关传给 helper：
  //   作者在 Windows 下本就要求软件合成（见 pet/main.js 的 disableHardwareAcceleration），
  //   理由是 WS_EX_LAYERED 透明窗在 DWM 硬件合成下有黑边/内容丢失缺陷。这里做同方向的强化——
  //   把 GPU 链路整个摘掉，既省资源，也避开「GPU 进程崩溃连累整个渲染进程」的环境问题
  //  （远程桌面 / 虚拟机 / 受限会话下高发，表现是宠物刚出现就消失）。
  const child = spawn(
    ELECTRON_EXE,
    ['--in-process-gpu', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-process-crash-limit', HELPER_MAIN],
    {
      env,
      cwd: dirname(HELPER_MAIN),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: false,
    },
  );
  helperProc = child;
  if (child.pid) helperPids.add(child.pid);

  child.stdout.on('data', (c) => {
    try {
      appendFileSync(HELPER_LOG, c);
    } catch {
      /* ignore */
    }
  });
  child.stderr.on('data', (c) => {
    try {
      appendFileSync(HELPER_LOG, c);
    } catch {
      /* ignore */
    }
  });

  child.on('exit', (code, signal) => {
    if (child.pid) helperPids.delete(child.pid);
    if (helperProc === child) helperProc = null;
    if (stopping) return;
    // 被主动换掉的（改尺寸 / 改配置）不算崩溃：它的重启已经由 restartHelper 排好了，
    // 这里再排一次就会同时起两个渲染进程 —— 那正是「大肥鱼越来越多」的根因（2026-10-01）。
    if (child.replaced) return;
    helperRestarts++;
    log(`渲染进程退出（code=${code} signal=${signal}），第 ${helperRestarts} 次重启`);
    // 指数退避：1s 起，封顶 30s；连续崩 12 次后就别再徒劳重启了
    if (helperRestarts > 12) {
      log('渲染进程连续失败超过 12 次，已放弃自动重启（详见 data/helper.log）');
      return;
    }
    const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(helperRestarts - 1, 5)));
    if (helperTimer) clearTimeout(helperTimer);
    helperTimer = setTimeout(() => {
      helperTimer = null;
      startHelper();
    }, delay);
  });

  child.on('error', (e) => {
    if (helperProc === child) helperProc = null;
    log('渲染进程启动失败：' + (e && e.message));
  });
}

/**
 * 主动收掉一个渲染进程。
 * 关键：**先摘掉它的 exit 监听再 kill**。kill 是异步的，进程稍后才真的退出；
 * 不摘监听的话，exit 回调里的「自动重启」会跟调用方安排的重启叠加 ——
 * 一次「小一点」就起了两个渲染进程，桌面上多出一只宠物（2026-10-01 实测根因）。
 */
function detachHelper(p) {
  if (!p) return;
  p.replaced = true;
  try {
    p.removeAllListeners('exit');
  } catch {
    /* ignore */
  }
  try {
    p.kill();
  } catch {
    /* ignore */
  }
  if (helperProc === p) helperProc = null;
}

function stopHelper() {
  if (helperTimer) {
    clearTimeout(helperTimer);
    helperTimer = null;
  }
  detachHelper(helperProc);
  // 兜底：把这次会话起过的渲染进程全收掉。
  // 正常路径上 helper 自己会发现宿主没了（DSH_PET_HOST_PID 每 2s 探一次）并退，
  // 这里是万一它没退（或又出现了重复 spawn）时不让用户桌面留一堆收不掉的宠物。
  for (const pid of helperPids) {
    try {
      process.kill(pid);
    } catch {
      /* 已经退干净了 */
    }
  }
  helperPids.clear();
}

function restartHelper() {
  // 连点「小一点」时取消上一次待执行的重启，只按最后一次来
  if (helperTimer) {
    clearTimeout(helperTimer);
    helperTimer = null;
  }
  detachHelper(helperProc);
  helperTimer = setTimeout(() => {
    helperTimer = null;
    startHelper();
  }, 600);
}

// ---------------------------------------------------------------- HTTP 服务

function listen(port) {
  return new Promise((done, fail) => {
    const server = createServer((req, res) => {
      handleRoute(req, res).catch((e) => {
        log('路由异常：' + (e && e.stack ? e.stack : e));
        try {
          sendJson(res, 500, { error: String(e && e.message ? e.message : e) });
        } catch {
          /* ignore */
        }
      });
    });
    server.on('error', fail);
    server.listen(port, '127.0.0.1', () => done(server));
  });
}

/** 端口上跑的是不是本程序（用于「已经开着一只了」的判定，避免桌面上冒出两只宠物） */
async function isOurService(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const j = await res.json();
    return !!j && j.ok === true && typeof j.port === 'number';
  } catch {
    return false;
  }
}

async function startServer() {
  const base = Number(userCfg.port) || 34517;

  // 单例保护：端口上已经有本程序在跑 → 本次启动取消，别让桌面上出现两只宠物。
  //
  // 例外是「重启交接」：重启时新实例可能比旧实例早那么一点点起来（旧实例还在收尾、端口没释放）。
  // 带着 RESTART_HANDOFF_ARG 启动就多等一会儿，等旧实例让出端口再继续；
  // 等不到（旧实例其实没打算退）就照旧放弃 —— 这时旧实例仍在正常跑，宠物不会丢。
  const handoff = process.argv.includes(RESTART_HANDOFF_ARG);
  const handoffUntil = Date.now() + (handoff ? 20_000 : 0);
  let waitingLogged = false;
  for (;;) {
    if (!(await isOurService(base))) break;
    if (Date.now() >= handoffUntil) {
      log(`端口 ${base} 上已经有一个本程序在运行，本次启动取消（不会出现两只宠物）`);
      return null;
    }
    if (!waitingLogged) {
      waitingLogged = true;
      log(`重启交接：端口 ${base} 还被上一个实例占着，等它退出…`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  for (let p = base; p < base + 50; p++) {
    try {
      const server = await listen(p);
      httpPort = p;
      log(`本地服务已启动：http://127.0.0.1:${p}${PREFIX}/`);
      log(`管理页：http://127.0.0.1:${p}/admin`);
      return server;
    } catch (e) {
      if (e && e.code === 'EADDRINUSE') continue;
      throw e;
    }
  }
  throw new Error(`端口 ${base}~${base + 49} 全被占用`);
}

// ---------------------------------------------------------------- 系统托盘

let tray = null;

function openAdmin() {
  try {
    shell.openExternal(`http://127.0.0.1:${httpPort}/admin`);
  } catch {
    /* 打不开浏览器不影响宠物本体 */
  }
}

/**
 * 重启（对齐旧版大肥鱼的托盘「重启」）：**启动一个全新实例 → 退出当前实例**。
 *
 * 为什么用 Electron 内置的 `app.relaunch()`，而不是自己 spawn 一个新进程：
 * 本程序有单例保护（见 startServer —— 端口上已有本程序在跑就静默退出，免得桌面上两只宠物）。
 * 自己 spawn 的话新进程会**立刻**去抢端口，而旧进程还没退，于是新实例被自己的单例判定劝退、
 * 旧实例随后也退了 —— 两头空，宠物直接消失。
 * `app.relaunch()` 由 Electron 自带的 relauncher 进程守着：**等当前进程真正退出之后**才拉起新实例，
 * 端口这时已经释放，新实例能正常接管。再叠一道 startServer 里的交接等待，双保险。
 *
 * 走 `app.quit()` 而不是 `app.exit()`：要为的不是退出速度，而是让 before-quit 跑完
 * —— 存提醒状态、收掉渲染进程，跟「退出大肥鱼」同一条收尾链路。
 */
function restartApp() {
  if (restarting || stopping) return;
  restarting = true;
  log('收到重启请求：当前实例退出后由新实例接管');
  try {
    app.relaunch({ execPath: ELECTRON_EXE, args: [HOST_MAIN, RESTART_HANDOFF_ARG] });
  } catch (e) {
    log('重启失败（relaunch 抛错）：' + (e && e.message));
    restarting = false;
    return;
  }
  app.quit();
}

/**
 * 托盘图标 —— 独立版的「门把手」。
 *
 * 宠物本体是个无边框透明窗口，右键弹的是动作菜单，没有「关闭」；宿主自己又没有窗口。
 * 不给托盘的话，用户想关掉它就得回文件夹里双击 bat —— 这正是老版大肥鱼用
 * 托盘解决的痛点（它右键菜单里就有「退出」）。挂上托盘之后，
 * 「双击图标启动 / 右键托盘退出」的手感就和老版一致了。
 */
function createTray() {
  try {
    const img = nativeImage.createFromPath(join(ROOT, 'icon.ico'));
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('大肥鱼桌宠（右键设置 / 退出）');
    rebuildTrayMenu();
    tray.on('double-click', openAdmin);
    log('托盘图标已就绪 —— 右键托盘可改设置、退出');
  } catch (e) {
    // 托盘起不来不影响宠物，最多回到「用文件夹里的入口」这条老路
    log('托盘创建失败（不影响宠物本体）：' + (e && e.message));
  }
}

/**
 * 托盘菜单 = 保命通道（原生菜单）。
 * 日常开关（久坐/定时/余额/通知/间隔/角落）已全部搬进**宠物右键菜单**（见 pet/sprite.js 的注入块），
 * 那里才是顺手的地方。托盘只留三件事：打开设置（宠物被拖到屏幕外时的兜底入口）、
 * 重启大肥鱼（app.relaunch，网页层做不到）、退出大肥鱼（app.quit，网页层做不到）。
 */
function rebuildTrayMenu() {
  if (!tray) return;

  // 托盘 = 保命通道，只留「网页层做不到」的项：
  //   打开设置（鱼被拖到屏幕外时的兜底入口）、重启（app.relaunch）、退出（app.quit）。
  // 日常开关（久坐/定时/余额/通知/间隔/角落）已全部搬进宠物右键菜单 —— 那边才是顺手的地方。
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '大肥鱼桌宠', enabled: false },
      { type: 'separator' },
      { label: '打开设置…', click: openAdmin },
      { type: 'separator' },
      { label: '重启大肥鱼', click: () => restartApp() },
      { label: '退出大肥鱼', click: () => app.quit() },
    ]),
  );
}

// ---------------------------------------------------------------- 启动

app.setName(HOST_NAME);
app.disableHardwareAcceleration();
// 宿主没有任何窗口、不渲染任何东西，GPU 链路纯属多余。
//
// 但光加 disable-gpu 不够：Chromium 仍会拉起一个独立 GPU 进程，而该进程一旦反复崩溃
//（远程桌面 / 虚拟机 / 受限会话环境很常见），Chromium 会判定「GPU 不可用」并 FATAL
// **把整个主进程一起带走** —— 表现就是「宠物突然消失、管理页打不开，日志里一句
// GPU process isn't usable. Goodbye.」。所以这里做三件事：
//   ① in-process-gpu —— GPU 不再单独开进程，没有独立进程可崩
//   ② disable-gpu / disable-gpu-compositing —— 本来也不需要用 GPU
//   ③ disable-gpu-process-crash-limit —— 万一还是崩，也不许它 FATAL
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-process-crash-limit');

// 无窗口的宿主：别让 Electron 因为「没有窗口」而退出
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  log('========================================');
  log('dsh-pet 独立版 启动');

  const { cfg, warn } = loadUserConfig();
  if (warn) log('警告：' + warn);
  userCfg = cfg;
  petConfig = buildPetConfig(userCfg);
  apiKeyInfo = resolveApiKey(userCfg);
  log(`余额密钥来源：${apiKeyInfo.from}`);

  // 前置检查：Electron 与 helper 是否就位
  if (!existsSync(ELECTRON_EXE)) {
    fatal('找不到 Electron 运行时', ELECTRON_EXE);
    return;
  }
  if (!existsSync(HELPER_MAIN)) {
    fatal('找不到宠物渲染进程', HELPER_MAIN);
    return;
  }

  let server;
  try {
    server = await startServer();
  } catch (e) {
    fatal('本地服务启动失败', e && e.message);
    return;
  }
  if (!server) {
    // 端口上已经有本程序在跑：静默退出，别让桌面上出现两只宠物
    app.exit(0);
    return;
  }

  // 运行状态落盘（管理页 / 启动器脚本读取）
  writeFileSync(
    RUNTIME_FILE,
    JSON.stringify({ pid: process.pid, port: httpPort, startedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );

  initReminders();
  startHelper();
  createTray();
});

app.on('before-quit', () => {
  stopping = true;
  if (reminder) {
    reminder.stop();
    try {
      writeFileSync(STATE_FILE, JSON.stringify(reminder.exportState()), 'utf8');
    } catch {
      /* ignore */
    }
  }
  stopHelper();
});

process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
