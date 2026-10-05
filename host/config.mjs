/**
 * dsh-pet 独立版 —— 配置层
 *
 * 两个配置来源：
 *   config/user-config.json           用户设置（端口 / 密钥 / 提醒 / 久坐间隔）
 *                                     —— 首次运行自动生成，改这个文件或走管理页
 *   config/pet-config.default.json    宠物默认配置（从 DSH 版导出，含 106 个动画的完整动画池
 *                                     + 事件档位 + 物理参数 + 表情包清单）
 *
 * /config 端点返回的成品 = 默认宠物配置 + 用户覆盖（display / 尺寸 / 位置 / 各开关）。
 * 注意：这里**不做字段级兜底**——默认配置已由上游填满，只覆盖用户真正改的那几项。
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
export const CONFIG_DIR = join(ROOT, 'config');
export const DATA_DIR = join(ROOT, 'data');

const USER_CONFIG_PATH = join(CONFIG_DIR, 'user-config.json');
const DEFAULT_PET_CONFIG_PATH = join(CONFIG_DIR, 'pet-config.default.json');

/** 久坐提醒的默认文案池（随机抽一句；{min} 会替换成已坐分钟数） */
const DEFAULT_SEDENTARY_TEXTS = [
  '已经坐了 {min} 分钟啦，起来走两步吧',
  '坐太久了，站起来伸个懒腰？',
  '{min} 分钟没动了，去接杯水吧',
  '久坐伤腰，起来活动一下嘛',
];

/** 用户配置默认值 */
export const DEFAULT_USER_CONFIG = {
  /** 本地服务端口（0 = 自动挑空闲端口）。改动需重启。 */
  port: 34517,
  /** DeepSeek API Key（余额查询用）。留空则尝试从 DSH 凭据自动导入。 */
  deepseekApiKey: '',
  /** 是否自动从 DSH 的 ~/.dsh/.credentials.yaml 导入 Key（仅在上面为空时生效） */
  autoImportKeyFromDsh: true,
  /** 宠物外观 */
  pet: {
    /** 显示尺寸（px，466 是原始素材尺寸） */
    size: 462,
    /** 显示位置：desktop = 只在桌面 / both = 桌面 + 无（独立版没有网页形态，both 等同 desktop） */
    display: 'desktop',
    /** 起始角落 */
    corner: 'top-right',
    marginX: 24,
    marginY: 100,
  },
  /** 余额显示 */
  balance: {
    enabled: true,
    /** 后台刷新间隔（秒），与 DSH 版默认一致（30 分钟） */
    refreshSec: 1800,
  },
  /** 久坐提醒 */
  sedentary: {
    enabled: true,
    /** 连续使用满多少分钟提醒一次 */
    intervalMin: 45,
    /** 离开电脑（无键鼠输入）超过多少分钟算「休息过了」，重新开始计时 */
    awayResetMin: 5,
    /** 提醒后暂停多少分钟再重新计时（点「一会儿再说」的等效值） */
    snoozeMin: 10,
    texts: DEFAULT_SEDENTARY_TEXTS,
  },
  /** 定时提醒列表：{ id, time: "HH:MM", text, repeat: "daily"|"once", enabled } */
  reminders: [],
  /** 定时提醒总开关（右键菜单用；关掉 = 所有定时提醒暂停，条目本身保留） */
  scheduleEnabled: true,
  /** 是否用系统通知（右下角 toast）配合提醒 */
  systemNotification: true,
  /** 提醒气泡停留秒数 */
  bubbleSeconds: 20,
};

/** 深合并：对象递归，数组与标量整体替换（用户配置优先） */
function deepMerge(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(override) || typeof override !== 'object') return override;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = deepMerge(base[k], v);
  return out;
}

/**
 * 读取用户配置；不存在则写入默认值。
 * 解析失败不静默吞掉：备份坏文件后重建，并返回告警供启动日志打印。
 */
export function loadUserConfig() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  let warn;
  let raw;
  if (existsSync(USER_CONFIG_PATH)) {
    try {
      raw = JSON.parse(readFileSync(USER_CONFIG_PATH, 'utf8'));
    } catch (e) {
      const bak = USER_CONFIG_PATH + '.broken-' + Date.now();
      try {
        renameSync(USER_CONFIG_PATH, bak);
      } catch {
        /* 备份失败也要继续，不能让启动挂在这 */
      }
      warn = `用户配置解析失败（${e && e.message}），已备份为 ${bak}，本次使用默认配置`;
    }
  }
  const cfg = deepMerge(DEFAULT_USER_CONFIG, raw ?? {});
  if (!existsSync(USER_CONFIG_PATH)) saveUserConfig(cfg);
  return { cfg, warn };
}

/** 原子写用户配置（先写临时文件再改名，避免中途崩坏） */
export function saveUserConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = USER_CONFIG_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  renameSync(tmp, USER_CONFIG_PATH);
}

/** 读取宠物默认配置（DSH 导出的成品，结构 = { main: ClientConfig }） */
export function loadDefaultPetConfig() {
  const raw = JSON.parse(readFileSync(DEFAULT_PET_CONFIG_PATH, 'utf8'));
  return raw;
}

/**
 * 构造 /config 端点的响应体。
 *
 * 结构 = { main: ClientConfig }，与 DSH 版完全同构（渲染端只认这个形状）。
 * 用户覆盖的三项：
 *   - display：独立版没有网页 overlay，默认 desktop
 *   - workStatusEnabled：**提醒功能走的就是这条通道**，必须 true
 *   - balanceEnabled / size / position：跟用户配置走
 */
export function buildPetConfig(userCfg) {
  const all = loadDefaultPetConfig();
  const out = {};
  for (const [entryId, entry] of Object.entries(all)) {
    const cfg = JSON.parse(JSON.stringify(entry));
    cfg.eventsRefreshSec = { ...(cfg.eventsRefreshSec ?? {}), balance: userCfg.balance.refreshSec };
    const isMain = entryId === 'main';
    cfg.pets = (cfg.pets ?? []).map((p) => {
      if (!isMain) return p;
      return {
        ...p,
        size: userCfg.pet.size,
        display: userCfg.pet.display,
        balanceEnabled: !!userCfg.balance.enabled,
        // 提醒通道：宿主经 /work-status 推 state + task，渲染端播对应档位动画并弹 task 文本
        workStatusEnabled: true,
        // 独立版没有 LLM，碎碎念恒关（否则渲染端会一直轮询一个永远为空的端点）
        whisperEnabled: false,
        // ---- 给右键菜单的「设置」子菜单看的状态 ----
        // 这些是宿主自己的配置（userCfg），渲染端拿不到，但菜单要显示「当前开没开」「当前多少分钟」，
        // 所以随宠物配置一起下发。改完由宿主落盘，下次重启渲染进程时刷新。
        sedentaryEnabled: !!userCfg.sedentary.enabled,
        sedentaryMinutes: Number(userCfg.sedentary.intervalMin) || 45,
        scheduleEnabled: userCfg.scheduleEnabled !== false,
        notifyEnabled: !!userCfg.systemNotification,
        corner: userCfg.pet.corner,
        position: {
          corner: userCfg.pet.corner,
          marginX: userCfg.pet.marginX,
          marginY: userCfg.pet.marginY,
        },
      };
    });
    out[entryId] = cfg;
  }
  return out;
}

/** 建目录（启动时调用一次） */
export function ensureDirs() {
  for (const d of [CONFIG_DIR, DATA_DIR]) mkdirSync(d, { recursive: true });
}
