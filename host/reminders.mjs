/**
 * dsh-pet 独立版 —— 提醒引擎
 *
 * 两类提醒：
 *   久坐提醒（sedentary）：连续使用满 N 分钟触发一次，之后每 snoozeMin 分钟再催一次；
 *                          中途离开电脑（无键鼠输入）超过 awayResetMin 分钟即视为休息，重新计时。
 *   定时提醒（schedule）：用户设定的固定时刻（HH:MM），支持四种重复规则 ——
 *                          daily（每天）/ workday（工作日，跳过法定节假日、补班日算工作日）/
 *                          weekly（自定义星期）/ once（仅一次）。
 *
 * 引擎只负责「什么时候该响」，不负责「怎么响」——由调用方注入 onFire(kind, text)，
 * 宿主拿到后去推 /work-status（切动画 + 弹气泡）并发系统通知。这样引擎可独立测试。
 *
 * 「在不在电脑前」由宿主注入 getIdleSeconds()（Electron 的 powerMonitor 提供），
 * 引擎本身不碰任何平台 API。
 */

const TICK_MS = 20_000;
/** 定时提醒的补触发窗口（秒）：宿主刚启动/电脑刚唤醒时，错过不久的提醒仍补上，太久就算了 */
const CATCHUP_WINDOW_SEC = 600;
/** 一次性提醒的「已用尽」标记 */
const ONCE_USED = '__used__';

/** 把 "HH:MM" 解析为当天的分钟序号；非法返回 null */
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 本地当天日期串 YYYY-MM-DD（用于「今天已触发过」判定） */
function localDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 判断某条提醒「今天该不该响」。
 *
 * repeat 取值：
 *   'once'    仅一次（触发过永久作废，不参与本判定）
 *   'daily'   每天
 *   'workday' 工作日（跳过法定节假日；调休补班日即使周末也算工作日）
 *   'weekly'  自定义星期（按 r.weekdays 数组，0=周日 … 6=周六）
 *
 * 向后兼容：旧配置没有 repeat 或值不认识 → 按每天处理。
 *
 * @param {object} r          提醒条目
 * @param {Date}   d          当前时刻
 * @param {object} holiday    HolidayCalendar 实例（可为 null）
 * @returns {{ok: boolean, reason?: string}}
 */
function shouldFireToday(r, d, holiday) {
  const repeat = r.repeat;

  if (repeat === 'workday') {
    const isWork = holiday ? holiday.isWorkday(d) : null;
    if (isWork === true) return { ok: true };
    if (isWork === false) return { ok: false, reason: '今天休息' };
    // 数据不可用 → 降级为纯星期判定（周一~周五），保证提醒不因断网失灵
    const w = d.getDay();
    return w >= 1 && w <= 5 ? { ok: true, reason: '降级' } : { ok: false, reason: '周末' };
  }

  if (repeat === 'weekly') {
    const days = Array.isArray(r.weekdays) ? r.weekdays.map(Number).filter((n) => n >= 0 && n <= 6) : [];
    if (days.length === 0) return { ok: true }; // 没勾任何一天 = 不当限制，视作每天
    return days.includes(d.getDay()) ? { ok: true } : { ok: false, reason: '非指定星期' };
  }

  // 'daily' 及未知值：每天
  return { ok: true };
}

export class ReminderEngine {
  /**
   * @param {object} opts
   * @param {() => object} opts.getConfig   返回最新用户配置（热改配置无需重启引擎）
   * @param {() => number} opts.getIdleSeconds 系统空闲秒数（无人操作时长）
   * @param {(kind: string, text: string) => void} opts.onFire 触发回调
   * @param {(msg: string) => void} [opts.log]
   * @param {object} [opts.holiday] 节假日日历（HolidayCalendar 实例，可选——缺省则 workday 规则降级为纯星期）
   */
  constructor(opts) {
    this.getConfig = opts.getConfig;
    this.getIdleSeconds = opts.getIdleSeconds;
    this.onFire = opts.onFire;
    this.log = opts.log ?? (() => {});
    this.holiday = opts.holiday ?? null;

    /** 本次连续「在座」的起点（ms）；null = 当前判定为已离开 */
    this.seatStart = null;
    /** 下次允许久坐提醒的时刻（ms）——实现 snooze */
    this.nextSedentaryAt = 0;
    /** 定时提醒最近一次触发记录：id → 日期串 */
    this.firedOn = new Map();
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
    this.log(`提醒引擎已启动（每 ${TICK_MS / 1000}s 检查一次）`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 供管理页/测试用：立刻触发一次（不改变计时状态） */
  fireNow(kind, text) {
    try {
      this.onFire(kind, text);
    } catch (e) {
      this.log('触发回调异常：' + (e && e.message));
    }
  }

  /**
   * 手动重置久坐计时（托盘 / 宠物右键菜单「重置久坐计时」）：
   * 把本次连续就座时间归零、从「现在」重新开始计时，并清掉超时提醒的下次触发时间。
   *
   * 为什么直接置 seatStart = now 而不是 null：
   *   null 表示「已离开」，角标会立刻隐藏、要等下一次 tick(20s) 重新置位才发现「有人在座」；
   *   而现在人就在电脑前点按钮，直接记「此刻开始坐」最符合直觉 —— 角标立即归零为 0 分，
   *   满 1 分钟后重新现身（与「刚坐下」的规则一致）。
   * 注意久坐功能本身关掉时（enabled=false）不重置：那时本就没有计时语义。
   */
  resetSeat() {
    const cfg = this.getConfig();
    const s = cfg.sedentary ?? {};
    if (!s.enabled) return { ok: false, reason: 'sedentary-disabled' };
    const now = Date.now();
    this.seatStart = now;
    const intervalMs = Math.max(1, Number(s.intervalMin) || 45) * 60_000;
    this.nextSedentaryAt = now + intervalMs;
    this.log('久坐计时已手动重置，从现在重新计时');
    return { ok: true, minutes: 0 };
  }

  /**
   * 供 UI 用的久坐计时快照（宠物头顶计时角标每秒来取一次）。
   *
   * on=false 表示当前不计时：久坐提醒被关掉，或已判定为「离开电脑」（seatStart 为 null）。
   * minutes 是本次连续就座的整分钟数；over 表示已达到设定时长（角标据此转红）。
   * 注意 seatStart 由 20s 一次的 tick 维护，所以「刚坐下」最多有 20s 的识别延迟，属预期。
   */
  getSeatInfo() {
    const cfg = this.getConfig();
    const s = cfg.sedentary ?? {};
    if (!s.enabled || this.seatStart === null) {
      return { on: false, minutes: 0, interval: 0, over: false };
    }
    const interval = Math.max(1, Math.round(Number(s.intervalMin) || 45));
    const minutes = Math.floor((Date.now() - this.seatStart) / 60_000);
    return { on: true, minutes, interval, over: minutes >= interval };
  }

  /**
   * 导出可持久化的状态（宿主定期写盘）。
   * 只存「哪条提醒何时触发过」——久坐计时是纯内存语义，重启后重新计时更符合直觉。
   */
  exportState() {
    return { firedOn: Object.fromEntries(this.firedOn) };
  }

  /** 载入持久化状态（宿主启动时调用；形状不对就忽略，不让脏数据影响运行） */
  importState(state) {
    if (!state || typeof state !== 'object' || typeof state.firedOn !== 'object') return;
    for (const [k, v] of Object.entries(state.firedOn ?? {})) {
      if (typeof v === 'string') this.firedOn.set(k, v);
    }
  }

  tick() {
    const cfg = this.getConfig();
    const now = Date.now();
    this.tickSedentary(cfg, now);
    this.tickSchedules(cfg, now);
  }

  // ---------- 久坐 ----------

  tickSedentary(cfg, now) {
    const s = cfg.sedentary ?? {};
    if (!s.enabled) {
      this.seatStart = null;
      return;
    }
    const awaySec = Math.max(1, Number(s.awayResetMin) || 5) * 60;
    const intervalMs = Math.max(1, Number(s.intervalMin) || 45) * 60_000;
    const snoozeMs = Math.max(0, Number(s.snoozeMin) || 0) * 60_000;

    let idle = 0;
    try {
      idle = this.getIdleSeconds();
    } catch {
      idle = 0; // 取不到空闲时长就退化成纯计时（偏保守：宁可多提醒）
    }

    if (idle >= awaySec) {
      // 判定为已离开：清空本次就座计时，回来后从零开始
      if (this.seatStart !== null) this.log('检测到离开电脑，久坐计时归零');
      this.seatStart = null;
      return;
    }

    // 在座（含刚从离开状态回来）
    if (this.seatStart === null) {
      this.seatStart = now;
      this.nextSedentaryAt = now + intervalMs;
      return;
    }

    if (now >= this.nextSedentaryAt) {
      const minutes = Math.round((now - this.seatStart) / 60_000);
      const texts = Array.isArray(s.texts) && s.texts.length > 0 ? s.texts : ['坐太久了，起来动动吧'];
      const text = texts[Math.floor(Math.random() * texts.length)].replace(/\{min\}/g, String(minutes));
      this.fireNow('sedentary', text);
      this.nextSedentaryAt = now + snoozeMs;
    }
  }

  // ---------- 定时 ----------

  /** 生产入口：按当前真实时间判定。测试用 tickSchedulesAt 传入假时钟。 */
  tickSchedules(cfg, now) {
    return this.tickSchedulesAt(cfg, new Date(now));
  }

  /**
   * 带可注入时钟的判定核心（测试用）。
   * @param {object} cfg
   * @param {Date}   d 视为「当前时刻」
   * @returns {boolean} 本次是否有条目被触发
   */
  tickSchedulesAt(cfg, d) {
    // 总开关（右键菜单「定时提醒」）：关掉时所有条目一起暂停，条目本身保留不删
    if (!cfg || cfg.scheduleEnabled === false) return false;
    const list = Array.isArray(cfg.reminders) ? cfg.reminders : [];
    if (list.length === 0) return false;

    let firedAny = false;
    const todayKey = localDateKey(d);
    const nowMin = d.getHours() * 60 + d.getMinutes();
    const nowSec = d.getSeconds();

    for (const r of list) {
      if (!r || r.enabled === false) continue;
      const target = parseHHMM(r.time);
      if (target === null) continue;

      // 距目标时刻已过去的秒数（目标只有分钟精度，秒按 0 算）。负值 = 还没到，跳过。
      // 正值但 ≤ 补触发窗口 = 刚错过（宿主启动/电脑唤醒晚了），照样补上。
      const elapsedSec = (nowMin - target) * 60 + nowSec;
      if (elapsedSec < 0 || elapsedSec > CATCHUP_WINDOW_SEC) continue;

      if (r.repeat === 'once') {
        // 一次性：触发过就永久作废（换天也不复活），置 __used__ 标记
        if (this.firedOn.get(r.id) === ONCE_USED) continue;
        this.firedOn.set(r.id, ONCE_USED);
      } else {
        // 重复类：先过「今天该不该响」的规则（工作日 / 自定义星期），不过就跳过
        const verdict = shouldFireToday(r, d, this.holiday);
        if (!verdict.ok) continue;
        // 同一天只触发一次（跨天自动解禁，靠日期串比对）
        if (this.firedOn.get(r.id) === todayKey) continue;
        this.firedOn.set(r.id, todayKey);
      }

      const text = String(r.text || '提醒时间到了').trim();
      this.fireNow('schedule', text);
      firedAny = true;
    }
    return firedAny;
  }
}

export { parseHHMM };
