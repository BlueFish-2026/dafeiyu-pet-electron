/**
 * dsh-pet desktop helper —— 事件联动（余额 / 碎碎念 / 广播 / 工作状态）。
 *
 * 展示与 tick 回调经 PetSprite.prototype 挂载（运行时可解析，顺序无碍）；
 * startLoops 是全部轮询的组装入口（boot 后调用）。依赖 constants.js / sprite.js。
 */
'use strict';

// ---- 工作状态联动（DSH 会话状态，每只宠物按 workStatusEnabled 门控；容器 1s 轮询，ts 变化才递增 tick）----
// 气泡驻留语义与浏览器一致：thinking/working/result/waiting（"事情还没完"）常驻直到状态切走；
//   success/error（"这事结束了"）10s 自动收起；state=null（空闲/回合被打断）收起气泡回待机。
// 动画循环语义：进行中档位循环播（switchTo once=false），终态档位播一遍回 idle 链；
//   回空闲时把正在循环的那段改成"播完即停"（见下面空闲分支），否则 ended 永不触发、链回不去。
PetSprite.prototype.onWorkTick = function onWorkTick(snapshot, tick) {
  if (!this.pet.workStatusEnabled) return; // 未启用工作状态联动 -> 该宠物完全免疫（与浏览器一致）
  if (tick === 0 || tick === this.prevWorkTick) return;
  this.prevWorkTick = tick;
  const state = snapshot && snapshot.state ? snapshot.state : null;
  this.workState = state; // 当前工作状态：互动/事件动画播完恢复档位循环用（与浏览器 workStatusRef 同用途）
  const stateChanged = this.prevWorkState !== state;
  this.prevWorkState = state;
  if (!state) {
    // 回空闲：把正在**循环播**的进行中档位动画改成"播完即停"（与浏览器 src/client/pet.ts 的空闲分支
    // 同一处修复）。进行中档位走 switchTo(name, false)（el.loop=true、el.onended=null），ended 永不
    // 触发；而这里不切动画（原设计"由常规动画链回待机"），链因此拿不到推进信号 —— 宠物会一直卡在
    // 那段工作动画上。只把当前段改成播完即停：它结束后走 handleEnded → resumeWorkStatusAnim() 返回
    // false → playIdle；工作期间的原生 loop 不受影响。
    if (S.poolIncludes(this.animations.events?.workStatus ?? [], this.anim)) {
      const frontEl = this.front === 0 ? this.videoA : this.videoB;
      if (frontEl) {
        frontEl.loop = false;
        frontEl.onended = () => this.handleEnded();
      }
    }
    // 空闲：收起常驻气泡
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = null;
    this.workOn = false;
    this.workText = null;
    this.renderBubble();
    return;
  }
  const pool = this.animations.events?.workStatus;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.workStatus，无法播放工作状态动画');
    return;
  }
  const idx = S.WORK_STATUS_INDEX[state];
  const slot = pool[idx];
  if (slot === undefined) {
    console.error('[dsh-pet] work-status 档位索引越界：state=' + state + ' idx=' + idx);
    return;
  }
  const name = S.pickSlot(slot, this.anim); // 数组槽位档内随机抽 1，且避开当前正播动画（避免连续重复，与浏览器一致）
  console.log(
    '[dsh-pet] ' +
      new Date().toTimeString().slice(0, 8) +
      ' workStatus pet=' +
      this.pet.id +
      ' state=' +
      state +
      ' -> [' +
      idx +
      '] ' +
      name,
  );
  this.stopMove();
  // 气泡文本：任务详情（todo/write 提供）优先，否则从条目级 workStatusTexts[档位]（数组）随机抽一句；
  // 整字段/整档缺失 = 不弹文本，只播动画（与浏览器同一语义）。
  const textGroup = Array.isArray(this.pet.workStatusTexts) ? this.pet.workStatusTexts[idx] : undefined;
  const configuredText =
    Array.isArray(textGroup) && textGroup.length > 0
      ? textGroup[Math.floor(Math.random() * textGroup.length)]
      : undefined;
  this.workText = (snapshot && snapshot.task) || configuredText || null;
  const terminal = state === 'success' || state === 'error';
  // 气泡点亮/收起只在状态变化时动作：同状态后续 tick（todo 文案更新、其它会话事件搅动 ts）
  // 不重新点亮**已自动收起的终态气泡**——否则"任务完成"的气泡会被后续 ts 变化反复弹回（Bug 2，
  // 与浏览器 workBubbleOn 同一语义）。
  if (stateChanged) {
    this.workOn = true;
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = terminal
      ? window.setTimeout(() => {
          this.workOn = false;
          this.renderBubble();
        }, BUBBLE_DURATION_MS)
      : null; // 非终态：常驻，不设自动收起
  }
  this.renderBubble();
  // 循环语义（与浏览器 setOnce 一致）：终态播一遍回 idle；非终态多候选档位播一遍 →
  // ended 由 sprite.handleEnded 轮换到下一候选（长时间状态不单段重复）；非终态单候选档位无限循环。
  const rotating = !terminal && Array.isArray(slot) && slot.length > 1;
  if (terminal || rotating) this.playOnce(name);
  else this.switchTo(name, false); // 进行中循环播（单动画/单候选档位）
};

// ---- 余额事件（每只宠物按 balanceEnabled 门控；档位与气泡内容来自 shared） ----
PetSprite.prototype.onBalanceTick = function onBalanceTick(state, tick) {
  if (!this.pet.balanceEnabled) return; // 未启用余额功能 -> 该宠物对余额事件完全免疫（与浏览器一致）
  if (tick === 0 || tick === this.prevTick) return;
  this.prevTick = tick;
  this.showBalanceNow(state);
};

// 余额不可用（服务商未登记 / 缺凭证 / 抓取失败）：只弹**文字说明**气泡，不播档位动画
// （非 ok 没有百分比语义，档位动画无从映射）。显隐/定时与成功路径同一套（10s 自动消失）；
// 不 stopMove——本次没有动画要抢前台，宠物没必要停下漫游。
PetSprite.prototype.showBalanceNotice = function showBalanceNotice(state) {
  if (!this.pet.balanceEnabled) return; // 门控与成功路径一致（未启用余额的宠物完全免疫）
  if (!state || state.ok) return;
  this.bubbleOn = true;
  this.balanceWrap = true; // 文字说明可能多行：renderBubble 据此套用换行变体（默认 nowrap 会顶出宠物宽度）
  this.balanceView = S.balanceBubbleView(state);
  this.renderBubble();
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
};

// ---- 碎碎念（每只宠物独立：按 eventsRefreshSec.whisper 周期轮询自己的句子，用本种类人设生成） ----
PetSprite.prototype.startWhisperLoop = function startWhisperLoop() {
  if (!this.pet.whisperEnabled || this.whisperLoopTimer !== null) return;
  const intervalMs = Math.max(1000, (this.pet.eventsRefreshSec?.whisper ?? 3600) * 1000);
  const refresh = async () => {
    try {
      const petId = encodeURIComponent(this.pet.id);
      const state = await S.fetchWhisperState(WHISPER_URL + '?pet=' + petId);
      if (!this.whisperBaseline) {
        this.whisperBaseline = true; // 首次仅记基线：避免启动/刷新时重放历史事件
        if (state.ok) {
          this.prevWhisperTs = state.ts;
          this.whisperText = state.text;
        }
        return;
      }
      if (!state.ok) {
        console.warn(
          '[dsh-pet] 碎碎念生成失败 pet=' +
            this.pet.id +
            ' reason=' +
            state.reason +
            (state.message ? ' ' + state.message : ''),
        );
        return;
      }
      if (state.ts !== this.prevWhisperTs) {
        this.prevWhisperTs = state.ts;
        this.whisperText = state.text;
        this.showWhisper(state.text, state.image);
      }
    } catch (e) {
      console.warn('[dsh-pet] 碎碎念拉取异常 pet=' + this.pet.id, e);
    }
  };
  this.whisperLoopTimer = window.setInterval(() => void refresh(), intervalMs);
  void refresh();
};

// 命令触发气泡（/chat 斜杠命令）：1s 轻量轮询 /broadcast?pet=<id>，ts 变化即弹气泡。
// 与碎碎念周期轮询独立（host 广播缓存是另一条通道）：手动触发语义不受 whisperEnabled 门控
PetSprite.prototype.startBroadcastLoop = function startBroadcastLoop() {
  if (this.broadcastLoopTimer !== null) return;
  const refresh = async () => {
    try {
      const petId = encodeURIComponent(this.pet.id);
      const res = await fetch(BASE + '/broadcast' + '?pet=' + petId, { cache: 'no-store' });
      if (!res.ok) return;
      const d = (await res.json().catch(() => null)) || {};
      const ts = typeof d.ts === 'number' ? d.ts : 0;
      if (!this.broadcastBaseline) {
        // 首拉无条件记基线（含 ts=0）：若 ts=0 提前 return 会跳过基线建立，
        // 导致第一条命令广播被当成基线吃掉（该条永不弹）
        this.broadcastBaseline = true;
        this.prevBroadcastTs = ts;
        return;
      }
      if (ts === 0 || ts === this.prevBroadcastTs) return; // 无广播 / 无变化
      this.prevBroadcastTs = ts;
      if (typeof d.text === 'string' && d.text) {
        // image：host 侧抽定/模型选定的配图名（未开配图则 undefined）——与 /whisper 同契约
        this.showWhisper(d.text, typeof d.image === 'string' ? d.image : '');
      }
    } catch (e) {
      console.warn('[dsh-pet] 广播拉取异常 pet=' + this.pet.id, e);
    }
  };
  this.broadcastLoopTimer = window.setInterval(() => void refresh(), 1000);
  void refresh();
};

// 碎碎念展示（本宠物）：随机抽 events.whisper 动画 + 弹文本气泡（10s 消失，与余额同一语义）
// image：host 随机抽定的配图名称（未开配图/池为空则空串，与浏览器端同一契约）
PetSprite.prototype.showWhisper = function showWhisper(text, image) {
  const pool = this.animations.events?.whisper;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.whisper，无法播放碎碎念动画');
    return;
  }
  // 整池随机抽 1 槽（避开当前正播动画，避免连续重复）；槽位若为数组候选再档内随机（与浏览器一致）
  const name = S.pickSlot(S.pick(pool, this.anim), this.anim);
  console.log(
    '[dsh-pet] ' +
      new Date().toTimeString().slice(0, 8) +
      ' whisper pet=' +
      this.pet.id +
      ' -> [' +
      name +
      '] 「' +
      text +
      '」' +
      (image ? ' [' + image + ']' : ''),
  );
  this.stopMove();
  this.whisperOn = true;
  this.whisperView = S.whisperBubbleView({ ok: true, text, ts: 0 });
  this.whisperImage = typeof image === 'string' ? image : '';
  this.renderBubble();
  // 气泡 10s 定时消失（与动画解耦，与余额同一语义；重复触发先清旧定时器）
  if (this.whisperTimer !== null) window.clearTimeout(this.whisperTimer);
  this.whisperTimer = window.setTimeout(() => {
    this.whisperOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
  this.playOnce(name);
};

// 余额展示（档位动画 + 气泡）：周期轮询与菜单点播共用同一展示路径，视觉/行为严格一致
PetSprite.prototype.showBalanceNow = function showBalanceNow(state) {
  if (!state || !state.ok) return;
  const p = S.balancePercent(state);
  if (p === undefined) return; // 当前数据源没有百分比语义：不触发档位动画
  const pool = this.animations.events?.balance;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.balance，无法播放余额事件动画');
    return;
  }
  const idx = S.balanceEventIndex(p);
  const slot = pool[idx];
  if (!slot) {
    console.error('[dsh-pet] balance 档位索引越界：p=' + p + ' idx=' + idx);
    return;
  }
  const name = S.pickSlot(slot, this.anim); // 数组槽位档内随机抽 1，且避开当前正播动画（避免连续重复，与浏览器一致）
  this.stopMove();
  this.bubbleOn = true;
  this.balanceWrap = false; // 正常余额气泡是单行（nowrap），别继承上一次文字说明的换行变体
  this.balanceView = S.balanceBubbleView(state);
  this.renderBubble();
  // 气泡 10s 定时消失（与动画解耦：即使动画被点击/拖拽打断，气泡也按时收起；重复触发先清旧定时器）
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
  this.playOnce(name);
};

// ---------- 轮询组装（容器统一拉取/触发，与浏览器 PetMulti 同一套路径；boot 成功后调用） ----------

// 余额不可用 → 文字说明气泡（周期轮询与手动 /balance 触发共用这一条路径；判定在 shared，与浏览器同一份）：
// explicit=true（手动触发）一律弹——用户问了就该有答复，包括"服务商不支持"这件事；
// 自动轮询仅在原因（含服务商）变化时弹一次，避免每 30 分钟反复刷同一句话。
function applyBalanceNotice(state, explicit) {
  const notice = S.decideBalanceNotice(state, balanceNoticeKey, explicit);
  balanceNoticeKey = notice.key;
  if (notice.show) for (const s of sprites) s.showBalanceNotice(state);
  // 未登记服务商是配置事实（已由气泡说明），不再刷 console；其余原因照旧显式报错，绝不伪造余额
  if (state.reason !== 'unsupported') {
    console.error('[dsh-pet] 余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''));
  }
}

function startLoops() {
  if (loopsStarted) return;
  loopsStarted = true;

  // 是否存在启用余额功能的宠物：全禁用时跳过余额轮询（不拉取，避免无意义的周期请求——与浏览器一致）
  const anyBalanceEnabled = sprites.some((s) => s.pet.balanceEnabled);

  // 余额周期轮询：eventsRefreshSec.balance（秒），成功递增 balanceTick 触发事件动画
  if (anyBalanceEnabled) {
    const intervalMs = Math.max(1000, (config.refreshSec?.balance ?? 1800) * 1000);
    const balanceLoop = async () => {
      try {
        const state = await S.fetchBalanceState(BALANCE_URL);
        balance = state;
        window.__dshPetDebug.lastBalanceOk = state && state.ok === true;
        if (state.ok) {
          balanceTick++;
          for (const s of sprites) s.onBalanceTick(state, balanceTick);
        } else {
          // 不可用：按 shared 的判定决定是否弹文字说明（自动轮询仅在原因变化时弹一次）
          applyBalanceNotice(state, false);
        }
      } catch (e) {
        console.error('[dsh-pet] 余额拉取异常', e);
      }
      setTimeout(() => void balanceLoop(), intervalMs);
    };
    void balanceLoop();
  }

  // 碎碎念：每只启用宠物独立轮询（startWhisperLoop）——各自周期、各自人设、各自一句话（与浏览器一致）
  for (const s of sprites) s.startWhisperLoop();
  // 命令触发气泡：每只宠物独立 1s 轻轮询（startBroadcastLoop）——/chat 命令写入即展示
  for (const s of sprites) s.startBroadcastLoop();

  // 手动 /balance 触发：1s 轻量轮询触发计数（端点已禁止缓存），计数变化且余额启用时立即刷新余额并递增 tick
  let triggerBaseline = null;
  const triggerLoop = async () => {
    try {
      const count = await S.fetchTriggerCount(TRIGGER_URL);
      if (count < 0) return;
      if (triggerBaseline === null) {
        triggerBaseline = count; // 首次仅记基线：避免启动时重放历史触发
      } else if (count !== triggerBaseline) {
        triggerBaseline = count;
        if (anyBalanceEnabled) {
          const state = await S.fetchBalanceState(BALANCE_URL);
          balance = state;
          if (state.ok) {
            balanceTick++;
            for (const s of sprites) s.onBalanceTick(state, balanceTick);
          } else {
            // 手动 /balance：显式请求，不可用也必弹文字说明
            applyBalanceNotice(state, true);
          }
        }
      }
    } catch {
      /* 轻量轮询失败静默：下一周期再试 */
    }
    setTimeout(() => void triggerLoop(), 1000);
  };
  if (anyBalanceEnabled) void triggerLoop();

  // 工作状态联动：任一宠物启用才轮询 /work-status（1s；避免无意义的周期请求——与浏览器一致）。
  // ts 变化（含回到空闲：host 在状态变化时更新 ts，切走 = 新 ts，用于收起常驻气泡）才递增 workTick →
  // 各启用宠物播档位动画+气泡；首拉仅记基线，启动/刷新不重放历史状态。
  const anyWorkStatusEnabled = sprites.some((s) => s.pet.workStatusEnabled);
  if (anyWorkStatusEnabled) {
    let workBaseline = null;
    const workLoop = async () => {
      try {
        const snap = await S.fetchWorkStatus(WORK_STATUS_URL);
        const ts = snap && typeof snap.ts === 'number' ? snap.ts : 0;
        if (workBaseline === null) {
          workBaseline = ts; // 首拉仅记基线
        } else if (ts !== workBaseline) {
          workBaseline = ts;
          workTick++;
          for (const s of sprites) s.onWorkTick(snap, workTick);
        }
      } catch {
        /* 轻量轮询失败静默：下一周期再试 */
      }
      setTimeout(() => void workLoop(), 1000);
    };
    void workLoop();
  }

  // >>> 大肥鱼独立版注入（由 _dsh_probe/apply_pet_patch.py 管理，勿手改）>>>
  // 头顶久坐计时角标（对齐旧版大肥鱼）：常驻胶囊 + 小闹钟 + 「已坐 M/N 分」，到点整颗转红。
  // 数据来自宿主 /api/seat-timer（久坐提醒关掉、或已判定「离开电脑」时 on=false → 自动隐藏）。
  // 为什么不复用 /work-status：那条通道是「DSH 会话状态」的专属语义（气泡常驻/档位动画都由它
  // 驱动），混进每秒钟都在变的计时数字会让两者互相牵制；独立 1s 轻轮询最省心，出问题也好定位。
  // 样式全部走 var(--pet-size) 等比缩放（与气泡同一套约定），改宠物大小它自己跟着缩放。
  //
  // 🎯 位置铁律（2026-10-03 踩了三轮才定死）：
  //   **水平：居中在角色头顶正上方，`left:50%` + `transform:translateX(-50%)`**（-50% 是元素自身宽度的一半）。
  //   🧨 绝不能用 `right`/`top` 靠 CB 右边缘算 —— CB 是 .pet-sprite，宽 = 整个 16:9 视频帧（= size），
  //   而角色本体只占帧宽约 29%、居中；帧之外窗口每侧还留 ~231px 空白。三层叠加后，
  //   `right:-0.32×size` 算出来离角色右肩 300+px（"飘在窗口右上角"）；
  //   退一步改成 `left:50% + margin-left:0.25×size` 又矫枉过正，孤零零贴到右肩外侧（"位置还是偏的"）。
  //   → **居中才是用户要的**（气泡平时不显示，为避让气泡而长期偏右是本末倒置）。
  //   **垂直：`-0.106×size`** —— 让角标底边停在余额气泡顶边之上约 3px
  //   （实测：气泡底边固定 el顶+50px、高 ~54px → 顶边 el顶-4px；角标高 ~0.094×size；
  //    故 top = -4 - 3 - 0.094×size ≈ -0.106×size）。此时角标底边距角色头顶约 7px，
  //   不带气泡时看着就是"头顶正上方贴着"，带气泡时两者上下叠放、零重叠。
  //   角标自身高 ≈ 0.094×size（font 0.039 + 上下 padding 0.026×2 + border 0.002×2）。
  //   📏 尺寸调整史：0.04（初版）→ 0.055（用户嫌小，×1.375）→ **0.039（用户嫌大，×0.709，当前）**。
  //      仍是 var(--pet-size) 等比，所以调大肥鱼时角标跟着变大、与气泡的比例不变。
  //      🧨 **改任一处系数，top 必须按新高度重算**（否则底边会撞上气泡）。
  //   ⚠️ 气泡是多行时会向上长高（bottom 定位），可能轻微压到角标，可接受。
  if (!window.__dshPetTimerPillCss) {
    window.__dshPetTimerPillCss = true;
    const pillStyle = document.createElement('style');
    pillStyle.textContent = [
      '.pet-timer{position:absolute;left:50%;transform:translateX(-50%);',
      'top:calc(var(--pet-size,462px) * -0.106);display:flex;align-items:center;',
      'gap:calc(var(--pet-size,462px) * 0.02);',
      'padding:calc(var(--pet-size,462px) * 0.026) calc(var(--pet-size,462px) * 0.049)',
      ' calc(var(--pet-size,462px) * 0.026) calc(var(--pet-size,462px) * 0.037);',
      'border-radius:999px;background:rgba(74,144,226,0.88);',
      'border:calc(var(--pet-size,462px) * 0.002) solid rgba(167,211,247,0.9);color:#fff;',
      "font-family:'Microsoft YaHei UI','Segoe UI',sans-serif;",
      'font-size:calc(var(--pet-size,462px) * 0.039);font-weight:700;line-height:1;',
      'white-space:nowrap;pointer-events:none;z-index:4;opacity:0;',
      'box-shadow:0 1px 3px rgba(0,0,0,0.22);',
      'transition:opacity .25s ease,background-color .25s ease,border-color .25s ease}',
      '.pet-timer.is-on{opacity:1}',
      '.pet-timer.is-over{background:rgba(208,42,42,0.9);border-color:rgba(255,143,179,0.9)}',
      '.pet-timer-clock{width:1em;height:1em;flex:0 0 auto}',
    ].join('');
    document.head.appendChild(pillStyle);
  }

  PetSprite.prototype.mountTimerPill = function mountTimerPill() {
    if (this.timerPill || !this.el) return;
    const pill = document.createElement('div');
    pill.className = 'pet-timer';
    // 小闹钟矢量绘制（不依赖 emoji 字体，跟旧版同一个造型）
    pill.innerHTML =
      '<svg class="pet-timer-clock" viewBox="0 0 16 16" aria-hidden="true">' +
      '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<path d="M8 8V4.6M8 8h2.8" fill="none" stroke="currentColor" stroke-width="1.8"' +
      ' stroke-linecap="round"/></svg>' +
      '<span class="pet-timer-text"></span>';
    this.el.appendChild(pill);
    this.timerPill = pill;
    this.timerPillText = pill.querySelector('.pet-timer-text');
    this.timerPillShown = false;
  };

  PetSprite.prototype.renderTimerPill = function renderTimerPill(info) {
    if (!this.timerPill) return;
    const on = !!(info && info.on);
    const minutes = Math.max(0, Math.round(Number(info && info.minutes) || 0));
    const interval = Math.max(1, Math.round(Number(info && info.interval) || 45));
    const over = on && (info.over === true || minutes >= interval);
    // 与旧版一致：坐满 1 分钟才现身，免得刚坐下就冒一个「已坐 0/N 分」
    const show = on && minutes >= 1;
    if (show && this.timerPillText) {
      this.timerPillText.textContent = '已坐 ' + minutes + '/' + interval + ' 分';
      this.timerPill.classList.toggle('is-over', over);
    }
    if (show !== this.timerPillShown) {
      this.timerPill.classList.toggle('is-on', show);
      this.timerPillShown = show;
    }
  };

  for (const s of sprites) s.mountTimerPill();
  // 轮询只启一次：boot 可能重试，重复启动会让请求翻倍（闭包读的是模块级 sprites，自动跟新）
  if (!window.__dshPetTimerLoop) {
    window.__dshPetTimerLoop = true;
    const timerPillLoop = async () => {
      try {
        const res = await fetch(ORIGIN + '/api/seat-timer', { cache: 'no-store' });
        if (res.ok) {
          const info = await res.json();
          for (const s of sprites) s.renderTimerPill(info);
        }
      } catch {
        /* 轻量轮询失败静默：下一周期再试 */
      }
      setTimeout(() => void timerPillLoop(), 1000);
    };
    void timerPillLoop();
  }
  // <<< 大肥鱼独立版注入 <<<
}
