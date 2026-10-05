/**
 * dsh-pet 独立版 —— 余额查询
 *
 * 与 DSH 版同一套数据源与返回结构（渲染端按 kind:'deepseek' 消费，字段名必须严格一致）：
 *   GET https://api.deepseek.com/user/balance
 *   → { balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 *   → 归一化为 { ok, provider, kind:'deepseek', data:{ currency, total, granted, toppedUp } }
 *
 * 密钥来源（按优先级）：
 *   1. 用户配置 config/user-config.json 的 deepseekApiKey
 *   2. 自动从 DSH 凭据 ~/.dsh/.credentials.yaml 导入（需 autoImportKeyFromDsh=true）
 * 两处都没有 → 返回 credential-missing（渲染端只弹一句文字说明，不报错、不伪造 0 余额）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const FETCH_TIMEOUT_MS = 20_000;
const RETRIES = 3;
const ENDPOINT = 'https://api.deepseek.com/user/balance';

/** 一次 fetch，带超时 */
async function fetchOnce(key) {
  return fetch(ENDPOINT, {
    headers: { Authorization: 'Bearer ' + key, 'User-Agent': 'dsh-pet-standalone' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/** fetch + 重试（境外端点偶发超时，与 DSH 版同策略） */
async function fetchWithRetry(key) {
  let last;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      return await fetchOnce(key);
    } catch (e) {
      last = e;
      if (i < RETRIES) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function str(value, what) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('余额数据非法字段 ' + what);
  return value;
}

// ---------- DSH 凭据导入 ----------
//
// ~/.dsh/.credentials.yaml 形状（见 dsh-credentials）：
//   version: N
//   refs:
//     DEEPSEEK_API_KEY: <某个 record 名，也可能直接就是 key>
//   records:
//     <record 名>:
//       kind: ...
//       payload:
//         version: ...
//         secret: ...     （或 token）
//
// 这里不引 YAML 依赖：先走「refs → record → payload 取 secret/token」的规范路径，
// 失败再退回全文扫 sk- 开头的串。两条都失败就返回 undefined（上层提示手填）。

const CRED_FILE = join(homedir(), '.dsh', '.credentials.yaml');

/** 极简 YAML 取顶层块下的键值对（只认两级缩进，够用且不引依赖） */
function parseTwoLevel(text) {
  const out = {};
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const top = /^([A-Za-z_][\w-]*):\s*$/.exec(line);
    if (top) {
      current = top[1];
      out[current] = out[current] ?? {};
      continue;
    }
    const kv = /^\s+([A-Za-z_][\w./-]*):\s*(.*)$/.exec(line);
    if (kv && current) {
      const val = kv[2].trim().replace(/^["']|["']$/g, '');
      if (val !== '') out[current][kv[1]] = val;
    }
  }
  return out;
}

/** 从 DSH 凭据文件里尽力取出 DeepSeek Key；取不到返回 undefined */
export function importKeyFromDsh() {
  if (!existsSync(CRED_FILE)) return undefined;
  let text;
  try {
    text = readFileSync(CRED_FILE, 'utf8');
  } catch {
    return undefined;
  }

  const blocks = parseTwoLevel(text);
  const refVal = blocks.refs?.DEEPSEEK_API_KEY;

  // 情况 A：refs 里直接存的就是 key
  if (refVal && /^sk-/.test(refVal)) return refVal;

  // 情况 B：refs 的值是 record 名 —— 在该 record 段里找 payload 字段
  if (refVal) {
    const seg = text.split(new RegExp('^\\s{2}' + refVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':', 'm'))[1];
    if (seg) {
      const cut = seg.split(/\n\s{2}\S/)[0]; // 截到下一个同级条目
      for (const field of ['secret', 'token', 'value', 'key', 'apiKey']) {
        const m = new RegExp('^\\s+' + field + ':\\s*(.+)$', 'm').exec(cut);
        if (m) {
          const v = m[1].trim().replace(/^["']|["']$/g, '');
          if (v) return v;
        }
      }
    }
  }

  // 情况 C：兜底 —— 全文找第一段 sk- 开头的串
  const m = /\bsk-[A-Za-z0-9_-]{16,}\b/.exec(text);
  return m ? m[0] : undefined;
}

/** 解析实际要用的 key + 来源说明（供启动日志，绝不打印 key 本身） */
export function resolveApiKey(userCfg) {
  const own = (userCfg.deepseekApiKey ?? '').trim();
  if (own) return { key: own, from: '用户配置' };
  if (userCfg.autoImportKeyFromDsh) {
    const imported = importKeyFromDsh();
    if (imported) return { key: imported, from: 'DSH 凭据（自动导入）' };
  }
  return { key: undefined, from: '未找到' };
}

// ---------- 查询 ----------

/**
 * 查询余额。
 * @param {string} key DeepSeek API Key（无则直接返回缺凭证）
 * @returns 结构化结果（成功 / 缺凭证 / 抓取失败）；失败带 message，绝不返回伪造数字
 */
export async function queryBalance(key) {
  const provider = 'deepseek-official';
  if (!key) {
    return { ok: false, provider, reason: 'credential-missing', message: '未配置 DeepSeek API Key' };
  }
  try {
    const res = await fetchWithRetry(key);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    const infos = body?.balance_infos;
    if (!Array.isArray(infos) || infos.length === 0) throw new Error('响应缺少 balance_infos');
    const first = infos[0];
    return {
      ok: true,
      provider,
      kind: 'deepseek',
      data: {
        currency: str(first.currency, 'currency'),
        total: str(first.total_balance, 'total_balance'),
        granted: str(first.granted_balance, 'granted_balance'),
        toppedUp: str(first.topped_up_balance, 'topped_up_balance'),
      },
    };
  } catch (e) {
    return { ok: false, provider, reason: 'fetch-error', message: e instanceof Error ? e.message : String(e) };
  }
}
