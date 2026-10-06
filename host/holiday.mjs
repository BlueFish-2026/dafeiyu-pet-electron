/**
 * dsh-pet 独立版 —— 中国法定节假日查询（含调休补班）
 *
 * 用途：定时提醒的「工作日」规则需要知道某天到底算不算工作日。
 *   普通星期判定不够用 —— 调休时周六要上班、放假时周一到周五反而休息。
 *
 * 数据源：timor.tech 免费公开接口（无需注册、无广告、支持 HTTPS）
 *   GET https://timor.tech/api/holiday/year/{year}/   → 返回该年全部节假日 + 调休补班日
 *   响应形如：
 *     { code: 0, holiday: {
 *         "01-01": { holiday: true,  name: "元旦",         date: "2026-01-01" },
 *         "01-04": { holiday: false, name: "元旦后补班",   date: "2026-01-04" }
 *     }}
 *   holiday === true  → 放假（含法定节假日）
 *   holiday === false → 调休补班日（要上班）
 *
 * 设计要点：
 *   1. **纯降级安全**：任何网络/解析失败都不抛异常，只是「查不到节假日」，
 *      调用方退回纯星期判定，提醒功能不受影响。
 *   2. **本地缓存**：按年缓存到 data/holiday-{year}.json。
 *      当年数据在年初还没发布时缓存为空结果，靠 CACHE_RETRY_MS 之后重试。
 *   3. **不阻塞启动**：拉取在后台进行，首次查询若缓存未就绪直接返回 null（降级）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 缓存有效期：成功后 7 天内不重复拉取 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 失败/空结果后的重试间隔：2 小时后再试（避免频繁请求，又能等到官方发布） */
const CACHE_RETRY_MS = 2 * 60 * 60 * 1000;
/** 网络超时 */
const FETCH_TIMEOUT_MS = 10_000;
/** 数据源地址 */
const API_BASE = 'https://timor.tech/api/holiday/year';

export class HolidayCalendar {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir   缓存目录（宿主传 DATA_DIR）
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.log = opts.log ?? (() => {});

    /** year → { holidays: Set<'MM-DD'>, workdays: Set<'MM-DD'>, fetchedAt: number, ok: boolean } */
    this.cache = new Map();
    /** 正在进行的拉取：year → Promise（防并发重复请求） */
    this.inflight = new Map();
  }

  /**
   * 启动时预热：读磁盘缓存 + 后台拉取当年（及次年，应对跨年）。
   * 不 await —— 拉取失败不影响宿主启动。
   */
  warmup() {
    const now = new Date();
    for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
      this.ensureReady(year).catch(() => {});
    }
  }

  /**
   * 判断某天是否为「工作日」（用于提醒规则的 workday 模式）。
   *
   * @param {Date} date
   * @returns {boolean|null} true=工作日 / false=休息日 / null=数据不可用（调用方降级用纯星期判定）
   */
  isWorkday(date) {
    const year = date.getFullYear();
    const key = pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    const entry = this.cache.get(year);

    // 缓存未就绪：触发后台拉取，本次返回 null 让调用方降级
    if (!entry || (!entry.ok && Date.now() - entry.fetchedAt > CACHE_RETRY_MS)) {
      this.ensureReady(year).catch(() => {});
    }
    if (!entry || !entry.ok) return null;

    // 调休补班日：即使落在周末也算工作日
    if (entry.workdays.has(key)) return true;
    // 法定节假日：即使落在周一~周五也不算工作日
    if (entry.holidays.has(key)) return false;

    // 其余按普通星期判定：周一~周五为工作日
    const w = date.getDay();
    return w >= 1 && w <= 5;
  }

  /** 确保某年数据就绪（先磁盘缓存，再网络） */
  async ensureReady(year) {
    const hit = this.cache.get(year);
    if (hit && (hit.ok ? Date.now() - hit.fetchedAt < CACHE_TTL_MS : Date.now() - hit.fetchedAt < CACHE_RETRY_MS)) {
      return hit;
    }
    if (this.inflight.has(year)) return this.inflight.get(year);

    const p = this._load(year).finally(() => this.inflight.delete(year));
    this.inflight.set(year, p);
    return p;
  }

  async _load(year) {
    // 1) 先看磁盘缓存
    const file = join(this.dataDir, `holiday-${year}.json`);
    if (!this.cache.has(year) && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        this.cache.set(year, {
          holidays: new Set(raw.holidays || []),
          workdays: new Set(raw.workdays || []),
          fetchedAt: Number(raw.fetchedAt) || 0,
          ok: raw.ok === true,
        });
        if (raw.ok === true) this.log(`节假日缓存已载入（${year} 年，${(raw.holidays || []).length} 天假期）`);
      } catch (e) {
        this.log(`节假日缓存损坏，忽略：${e.message}`);
      }
    }

    const cached = this.cache.get(year);
    if (cached && (cached.ok ? Date.now() - cached.fetchedAt < CACHE_TTL_MS : Date.now() - cached.fetchedAt < CACHE_RETRY_MS)) {
      return cached;
    }

    // 2) 网络拉取
    try {
      const url = `${API_BASE}/${year}/`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || data.code !== 0 || typeof data.holiday !== 'object' || data.holiday === null) {
        throw new Error('响应格式异常');
      }

      const holidays = [];
      const workdays = [];
      for (const [mmdd, info] of Object.entries(data.holiday)) {
        if (!info || typeof info !== 'object') continue;
        if (info.holiday === true) holidays.push(mmdd);
        else if (info.holiday === false) workdays.push(mmdd);
      }

      const entry = { holidays: new Set(holidays), workdays: new Set(workdays), fetchedAt: Date.now(), ok: true };
      this.cache.set(year, entry);
      this._save(year, holidays, workdays);
      this.log(`节假日数据已更新（${year} 年：${holidays.length} 天假期，${workdays.length} 天补班）`);
      return entry;
    } catch (e) {
      this.log(`节假日拉取失败（${year} 年，本次降级为纯星期判定）：${e.message}`);
      const prev = this.cache.get(year);
      const entry = prev
        ? { ...prev, fetchedAt: Date.now() }
        : { holidays: new Set(), workdays: new Set(), fetchedAt: Date.now(), ok: false };
      this.cache.set(year, entry);
      return entry;
    }
  }

  _save(year, holidays, workdays) {
    try {
      if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(
        join(this.dataDir, `holiday-${year}.json`),
        JSON.stringify({ year, ok: true, fetchedAt: Date.now(), holidays, workdays }, null, 2),
        'utf8',
      );
    } catch (e) {
      this.log(`节假日缓存写入失败（不影响使用）：${e.message}`);
    }
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export { localDateKeyOf };

/** 本地日期串 YYYY-MM-DD */
function localDateKeyOf(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
