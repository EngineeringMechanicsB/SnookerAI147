// ================================================================
//  main.js — 游戏状态机 / 输入 / 主循环 / AI 调度
// ================================================================
(function (SNK) {
  'use strict';

  const C = SNK;
  const R = C.rules;
  const RENDER = C.render;
  const I = C.i18n;
  const t = (key, vars) => (I ? I.t(key, vars) : key);
  const tr = (text) => (I ? I.tr(text) : text);

  // ================================================================
  //  DOM
  // ================================================================
  const $ = (id) => document.getElementById(id);
  const canvas = $('gc');
  const ctx = canvas.getContext('2d');
  canvas.width = C.W;
  canvas.height = C.H;

  // ---------- 3D 台面（俯视正交）----------
  // 两层画布尺寸完全一致，#gc 仍然是最上面的输入层，
  // 所以 cpos() 那套屏幕坐标换算一个字都不用改。
  const canvas3d = $('gc3d');
  let use3d = false;
  let orbitView = false;      // 人类主动进入 3D 轨道视角（第九轮）
  let orbitAimPrev = false;   // 轨道视角下是否显示瞄准光标（第十轮）
  const R3D = C.render3d;
  // ?flat=1 强制 2D（3D 万一在某个机器上出问题，有个后路）
  const force2d = location.search.indexOf('flat') >= 0;
  if (!force2d && canvas3d && R3D && R3D.available()) {
    try {
      R3D.init(canvas3d);
      use3d = true;
      R3D.on = true;
    } catch (e) {
      console.warn('3D 渲染初始化失败，回退到 2D 台面', e);
      use3d = false;
      R3D.on = false;
    }
  }

  const spinPad = $('spinPad');
  const spinCtx = spinPad ? spinPad.getContext('2d') : null;

  const dom = {
    p1Score: $('p1Score'), p2Score: $('p2Score'),
    p1Box: $('p1Box'), p2Box: $('p2Box'),
    p1Name: $('p1Name'), p2Name: $('p2Name'),
    turnLabel: $('turnLabel'),
    powerWrap: $('powerWrap'), powerFill: $('powerFill'),
    powerLabel: $('powerLabel'), powerValue: $('powerValue'),
    powerTrack: $('powerTrack'), powerKnob: $('powerKnob'), shootBtn: $('shootBtn'),
    statusLine: $('statusLine'), statusMain: $('statusMain'), statusPrev: $('statusPrev'),
    aimChip: $('aimChip'),
    ballCount: $('ballCount'),
    modeSelect: $('modeSelect'),
    seatASelect: $('seatASelect'), seatBSelect: $('seatBSelect'),
    speedSelect: $('speedSelect'), pauseBtn: $('pauseBtn'),
    breakLabel: $('breakLabel'), highLabel: $('highLabel'), breakWord: $('breakWord'),
    spinText: $('spinText'), thinkLabel: $('thinkLabel'),
    viewBtn: $('viewBtn'), orbitBtn: $('orbitBtn'),
    // 声音
    soundBtn: $('soundBtn'), volRange: $('volRange'),
    // 光照氛围
    ambienceSelect: $('ambienceSelect'),
    // 辅助线模式
    guideSelect: $('guideSelect'),
    // 语言 / 对话
    langSelect: $('langSelect'),
    chatterBox: $('chatterBox'), chatterName: $('chatterName'), chatterText: $('chatterText'),
    // 存档子菜单
    saveMenuWrap: $('saveMenuWrap'), saveMenuBtn: $('saveMenuBtn'),
    saveMenu: $('saveMenu'), saveSlots: $('saveSlots'),
    saveMenuNote: $('saveMenuNote'),
    exportSaveBtn: $('exportSaveBtn'), importSaveBtn: $('importSaveBtn'),
    importSaveFile: $('importSaveFile'),
    // 观战 / 隐藏 UI
    spectateHint: $('spectateHint'),
    // 结算
    summaryOverlay: $('summaryOverlay'), sumTitle: $('sumTitle'), sumScore: $('sumScore'),
    sumNameA: $('sumNameA'), sumNameB: $('sumNameB'), sumBody: $('sumBody'),
    sumRematch: $('sumRematch'), sumClose: $('sumClose'), sumHint: $('sumHint'),
    // 教学
    tutorialBtn: $('tutorialBtn'),
    tutorialHud: $('tutorialHud'), tutStep: $('tutStep'), tutName: $('tutName'), tutGoal: $('tutGoal'),
    tutRetry: $('tutRetry'), tutMenuBtn: $('tutMenuBtn'), tutExitBtn: $('tutExitBtn'),
    tutorialOverlay: $('tutorialOverlay'), tutorialGrid: $('tutorialGrid'),
    tutKicker: $('tutKicker'), tutTitle: $('tutTitle'), tutClose: $('tutClose'), tutNote: $('tutNote'),
    tutorialResult: $('tutorialResult'), tutResultMark: $('tutResultMark'),
    tutResultTitle: $('tutResultTitle'), tutResultText: $('tutResultText'),
    tutRetryBtn: $('tutRetryBtn'), tutNextBtn: $('tutNextBtn'), tutLessonsBtn: $('tutLessonsBtn'),
  };

  // ================================================================
  //  画布等比适配（第九轮）
  //  两层画布共用一个 1416:736 的盒子：窗口再窄再扁，台面只缩小、不变形、
  //  不裁切。尺寸不写死在 CSS 里 —— grid/flex 的 max-width/max-height 组合
  //  会在某些比例下算出非等比尺寸或溢出被裁。
  // ================================================================
  const stageEl = document.querySelector('.stage');
  const canvasFit = $('canvasFit');
  let fitPending = false;

  function fitCanvases() {
    fitPending = false;
    if (!stageEl || !canvasFit) return;
    const aw = stageEl.clientWidth;
    const ah = stageEl.clientHeight;
    if (aw < 2 || ah < 2) return;            // 隐藏中 / 尚未布局，等下一次
    const s = Math.min(aw / C.W, ah / C.H);
    const w = Math.max(1, Math.floor(C.W * s));
    const h = Math.max(1, Math.floor(C.H * s));
    const ws = w + 'px', hs = h + 'px';
    // CSS 圆角按真实显示比例跟着台面 CORNER_R 走。2D 的桌角是画出来的，
    // 3D 俯视时如果不裁掉画布四角，圆角桌外会露出地毯的直角。
    // ★ 每次 fit 都写，不能只在尺寸变化时写：切换 3D/俯视/H 隐藏 UI 时
    //   宽高可能恰好没变，但合成层和裁剪状态会重建，圆角会丢。
    const radius = Math.max(1, C.CORNER_R * s).toFixed(1) + 'px';
    canvasFit.style.borderRadius = radius;
    canvasFit.style.clipPath = 'inset(0 round ' + radius + ')';
    // 再直接裁两层画布：父级 overflow + clip-path 在某些合成层切换后
    // （尤其 3D/俯视/H 隐藏 UI）会丢掉圆角，直接裁 canvas 最稳。
    for (const cv of [canvas, canvas3d]) {
      if (!cv) continue;
      cv.style.borderRadius = radius;
      cv.style.clipPath = 'inset(0 round ' + radius + ')';
    }
    // 只有真的变了才写尺寸 —— 否则 ResizeObserver 会被自己的写入再触发一轮
    if (canvasFit.style.width === ws && canvasFit.style.height === hs) return;
    canvasFit.style.width = ws;
    canvasFit.style.height = hs;
  }

  function scheduleFit() {
    if (fitPending) return;
    fitPending = true;
    requestAnimationFrame(fitCanvases);
  }

  window.addEventListener('resize', scheduleFit);
  if (typeof ResizeObserver !== 'undefined' && stageEl) {
    new ResizeObserver(scheduleFit).observe(stageEl);
  }
  scheduleFit();

  // ================================================================
  //  游戏状态
  // ================================================================
  const G = {
    balls: [],
    cueBall: null,
    scores: [0, 0],
    breaks: [0, 0],
    highBreak: 0,
    currentPlayer: 0,
    state: 'aim',            // aim | powering | dragging | stroking | placing | moving | over
    aimAngle: 0,
    aimLocked: false,        // 瞄准是否被"定住"（点台面切换）。锁定期间鼠标移动不改方向
    power: 0,
    spinX: 0, spinY: 0,
    pitchDeg: 0,          // 球杆俯仰（0..PITCH_MAX_DEG），第八轮
    cueClear: null,       // 后斯诺克：本杆可击球面（cueclear.js 的 analyze 结果）
    cueBlockNotice: '',   // 本回合已提示过"球杆被挡"的去重键
    tutorial: null,       // 教学模式：{id, stepIndex, waiting, zone} 或 null
    guideMode: 2,         // 辅助线：0 全无 / 1 只有母球 / 2 母球+第一颗 / 3 所有动的球
    stroke: null,         // 出杆动画快照：{angle,power,spinX,spinY,pitchDeg,t,pull,fired}
    needRed: true,
    pottedRedThisTurn: false,
    isRespottedBlack: false,
    gameMode: 'classic',
    opening: true,        // 本局第一杆（只给 AI 开球用）
    cueInHand: false,     // 规则意义上的自由球（可用于限制 P 键摆球）
    negativeStreak: 0,    // 连续"消极/贴球"杆数（用于提示与 AI 反消极）
    negativeNotice: 0,
    noPotStreak: [0, 0],  // 每位选手连续没进球的杆数；到 3 杆强制进攻
    forceNotice: [0, 0],  // 「必须进球」提示去重
    shotStartCue: null,   // 本杆出杆前白球位置，用于判断白球移动量
    poolOpen: true,       // 8-ball：开放球台
    poolGroups: [null, null], // 8-ball：每位选手的 solids / stripes
    players: [
      { type: 'human', level: 'master' },
      { type: 'ai', level: 'master' },
    ],
    draggingCueBall: false,
    dragStartX: 0, dragStartY: 0,
    mx: 0, my: 0,
    keysPressed: {},
    ballsVersion: 0,
    trail: [],
    trailTime: 0,
    aiToken: 0,
    aiThinking: false,
    lastReason: '',
    pendingKind: '',    // AI 决策种类，等 shoot() 取走写进本杆统计
    // ---- AI 对战 ----
    aiVs: 'off',        // 派生缓存：双方都是 AI 时是 'on'，否则 'off'
    aiSpeed: 1,         // 0.5 / 1 / 2 / 4：同时压缩等待时间和搜索预算
    animSpeed: 1,       // 每秒多少组 60Hz 物理步（0.5 / 1 / 2 / 4）
    paused: false,
    autoRestart: true,  // AI 对战模式下打完自动开下一局
    restartTimer: null,
    stats: null,        // [座位1, 座位2] 的本局统计，newSeatStats() 生成
    summaryOpen: false,
    // ---- 提示去重（第十一轮）----
    breakMilestone: 0,       // 本杆已提示过的单杆里程碑（50 / 100）
    maxOnNoticed: false,     // 本杆是否已提示过 “147 on”
    snookerReqNotice: '',    // 上次提示“超分/需要斯诺克”的局面签名
    snookerNotice: '',       // 上次提示“做成斯诺克”的签名
  };

  // 池球模式通过 URL 重新加载，让 constants.js 按 8/9 球桌尺寸初始化。
  if (C.REQUESTED_MODE &&
      ['classic', 'eightball', 'nineball', 'clearance', 'respottedBlack'].indexOf(C.REQUESTED_MODE) >= 0) {
    G.gameMode = C.REQUESTED_MODE;
  }

  // 启动阶段 applySeats()/resetGame() 会跑两次；那时不能写自动档，
  // 否则会把玩家上次留下的 auto 存档在"还没点 Load"之前就覆盖掉。
  let autoSaveEnabled = false;

  function bothAI() {
    return G.players[0].type === 'ai' && G.players[1].type === 'ai';
  }

  // 观战 = 双方都是 AI。整个体验层只认这一个判据：
  // 自由镜头、隐藏 UI、自动开下一局，全部挂在它上面。
  function spectate() {
    return bothAI();
  }

  // 搜索预算直接读画像（每个球员不一样）；AI 对战加速时按倍率缩减，
  // 否则每杆仍要等满 700ms，"极快"根本快不起来。
  function budgetFor(level) {
    const prof = C.ai.PROFILES[level];
    const base = prof ? (prof.budget || 0) : 0;
    if (!base) return 0;
    return Math.max(150, Math.round(base / G.aiSpeed));
  }

  // 与速度倍率联动的延时；再乘球员自己的节奏（奥沙利文 0.45 = 飞快）
  function delayFor(ms, level) {
    const pace = level ? C.ai.paceOf(level) : 1;
    return Math.max(30, Math.round(ms * pace / G.aiSpeed));
  }

  // AI 出杆节奏。宁可慢一点：这段停顿既是"思考时间"，也让玩家看清它想干什么。
  // 加 ±18% 抖动，否则每杆一样长会很机械。
  // ★ 思考停顿和搜索预算是**两笔账**，别叠太多：AI 本身要算 300~1300ms
  //   （见 ai.js 的 budget），期间 "Thinking" 是画出来的，那已经是思考时间了。
  //   这里只留一点点，免得一杆等两秒半；摆瞄准线那段（TRACE）才值得留着看。
  // 观战节奏：AI 不是机器，出杆前留出明显的观察/思考时间。
  // 两个基数都会再乘 ±随机和球员 pace；按 4× 加速时一起缩短。
  const THINK_BASE = 1600;  // 决策前的思考停顿（显示 "Thinking"）
  const TRACE_BASE = 1600;  // 决策后、出杆前：摆好瞄准线让人看清选球
  function paced(base, level) {
    const jitter = 0.82 + Math.random() * 0.36;
    return Math.max(60, Math.round(delayFor(base, level) * jitter));
  }

  const live = {           // 本杆的实时事件累积
    potted: [],
    firstContact: null,
    firstContactBall: null, // 本杆第一次碰到的球对象（3D 跟拍切换目标用）
    pottedByLabel: {},
    kind: '',              // 本杆的决策种类（AI 有，人类为 ''）
    onLabel: null,         // 出杆那一刻的合法目标球（人类"是否尝试进攻"的判据）
  };

  // ================================================================
  //  状态行（HUD 下方通栏，永不遮挡台呢，也不占宽度）
  // ================================================================
  // showMsg 的签名保持不变（title, sub, duration, cls）→ 11 个调用点都不用改。
  // 三代演进：
  //   ① 台面正中弹大字块 —— 观战时正好挡在黑球点上；
  //   ② 台面右侧独立一列 —— 不挡台面，但平白吃掉 300px 宽度，球台被挤窄；
  //   ③ HUD 下方一行（现在）—— 两边都不占，球台铺满整个页面宽度。
  // 左边是最新一条，右边是上一条的灰字残影（"刚才发生了什么"）。
  const STATUS_HOLD = 2200;        // 多久没新消息就把主行淡下去，表示"这条旧了"
  let msgTimer = null;             // 只有一个计时器（不再一卡一个）
  let lastPlain = '';              // 上一条的纯文本，给右侧残影用

  // 残影走纯文本：sub 里带 <em>/<br>，直接塞进 textContent 会把标记也显示出来
  function plainOf(html) {
    return String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '');
  }

  function showMsg(title, sub, duration, cls) {
    title = tr(title);
    sub = tr(sub);
    const line = dom.statusLine, main = dom.statusMain, prev = dom.statusPrev;
    if (!line || !main) return null;

    // 先让上一条沉到右边，再换主行 —— 这样两条永远同时在，读起来是连续的
    if (prev) prev.textContent = lastPlain;
    lastPlain = (title || '') + (sub ? ' · ' + plainOf(sub) : '');

    main.textContent = '';
    const b = document.createElement('b');
    b.textContent = title || '';     // 标题纯文本（与旧卡片一致）
    main.appendChild(b);
    if (sub) {
      const s = document.createElement('span');
      s.className = 's-sub';
      s.innerHTML = ' · ' + sub;     // 说明允许 <em>…</em> 高亮（与旧卡片一致）
      main.appendChild(s);
    }

    // 重置 → 重新打上，动画才会重播（同一个类名不加这步不会再触发）
    line.classList.remove('foul', 'flash');
    main.classList.remove('idle');
    if (cls === 'foul') line.classList.add('foul');
    void line.offsetWidth;           // 强制回流，动画重启
    line.classList.add('flash');

    if (msgTimer) clearTimeout(msgTimer);
    msgTimer = setTimeout(() => {
      msgTimer = null;
      main.classList.add('idle');    // 淡下去，而不是整条消失（消失会闪）
    }, duration || STATUS_HOLD);

    return main;
  }

  function clearMsgPanel() {
    if (msgTimer) { clearTimeout(msgTimer); msgTimer = null; }
    lastPlain = '';
    if (dom.statusMain) { dom.statusMain.textContent = ''; dom.statusMain.classList.remove('idle'); }
    if (dom.statusPrev) dom.statusPrev.textContent = '';
    if (dom.statusLine) dom.statusLine.classList.remove('foul', 'flash');
  }

  // 犯规：整行转红（原样式是台面上方的一个 toast，再之前是红边卡片）
  function showFoul(text) {
    showMsg(text, '', 3200, 'foul');
  }

  // ================================================================
  //  本局统计
  // ================================================================
  // 口径说明（对人类和 AI 必须同样公平，否则数据没法看）：
  //   AI 有 decide().kind（pot/safety/fallback），人类没有。
  //   所以"是否算一次进攻尝试"统一定义为：
  //     AI   = kind === 'pot'
  //     人类 = 本杆第一次接触的球正好是合法目标球（firstContact === onLabel）
  //   两者回答的是同一个问题："这一杆是不是奔着进球去的"，
  //   而且全部来自已有数据 —— 一次额外模拟都不需要。
  //   命中率 = attemptsOk / attempts（UI 上标注 "of shots that first hit the ball on"）。
  function newSeatStats() {
    return {
      shots: 0,          // 出杆数
      pots: 0,           // 进球数（不含白球）
      attempts: 0,       // 进攻尝试
      attemptsOk: 0,     // 尝试中至少进了一颗
      safeties: 0,       // 防守杆
      fallbacks: 0,      // 兜底杆
      fouls: 0,          // 犯规次数
      foulPoints: 0,     // 因己方犯规送给对手的分数
      points: 0,         // 总分
      bestBreak: 0,      // 单杆最高
      visits: 0,         // 上手次数
      visitPoints: 0,    // 手上累计得分（/visits = 每上手均分）
      visitStart: 0,     // 本次上手开始时的累计分
      snookers: 0,       // 做成的斯诺克（只有"铁桶斯诺克"这类才算）
    };
  }

  // 上手 / 下手的簿记：每上手均分必须按"一段连续上手"来切，
  // 按杆平均会被防守杆和薄碰稀释得没有意义。
  function beginVisit(p) {
    if (!G.stats || !G.stats[p]) return;
    const st = G.stats[p];
    st.visits++;
    st.visitStart = st.points;
  }

  function endVisit(p) {
    if (!G.stats || !G.stats[p]) return;
    const st = G.stats[p];
    st.visitPoints += Math.max(0, st.points - st.visitStart);
    st.visitStart = st.points;
  }

  function recordShot(verdict) {
    if (!G.stats) return;
    const p = G.currentPlayer;
    const st = G.stats[p];
    if (!st) return;

    const kind = live.kind;
    const pottedN = verdict.pottedLegal ? verdict.pottedLegal.length : 0;
    // "进攻尝试"的统一口径：AI 看 kind，人类看首触球是不是合法目标球
    const tryingPot = (kind === 'pot') ||
      (!kind && !!live.onLabel && live.firstContact === live.onLabel);

    st.shots++;
    st.pots += pottedN;
    st.points = G.scores[p];
    st.bestBreak = Math.max(st.bestBreak, G.breaks[p]);

    if (tryingPot) {
      st.attempts++;
      if (pottedN > 0) st.attemptsOk++;
    } else if (kind === 'safety') {
      st.safeties++;
      if (G.lastReason.indexOf('Tight snooker') === 0) st.snookers++;
    } else if (kind === 'fallback') {
      st.fallbacks++;
    }

    if (verdict.penalty > 0) {
      st.fouls++;
      st.foulPoints += verdict.penalty;
    }
  }

  // 每上手均分（保留一位小数）
  function visitAvg(st) {
    if (!st || !st.visits) return '—';
    return (st.visitPoints / st.visits).toFixed(1);
  }

  function publicState() {
    return {
      mode: G.gameMode,
      isRespottedBlack: G.isRespottedBlack,
      needRed: G.needRed,
      pottedRedThisTurn: G.pottedRedThisTurn,
      currentPlayer: G.currentPlayer,
      scores: G.scores.slice(),
      opening: !!G.opening,
      negativeStreak: G.negativeStreak || 0,
      noPotStreak: (G.noPotStreak && G.noPotStreak[G.currentPlayer]) || 0,
      forcePot: !!(G.noPotStreak && G.noPotStreak[G.currentPlayer] >= 3),
      poolOpen: G.poolOpen !== false,
      poolGroups: (G.poolGroups || [null, null]).slice(),
    };
  }

  // 座位显示名：人类固定 "Human"，AI 用画像名（已经全英文）
  function seatName(p) {
    if (!p) return 'Player';
    if (p.type === 'human') return t('ui.human');
    return (C.ai.LEVELS[p.level] || {}).name || 'AI';
  }

  function labelText(label) {
    if (I) return I.labelText(label);
    return C.COL_CN[label] || label;
  }

  function updateHUD() {
    const poolMode = (G.gameMode === 'eightball' || G.gameMode === 'nineball');
    document.body.classList.toggle('pool-mode', poolMode);
    dom.p1Score.textContent = G.scores[0];
    dom.p2Score.textContent = G.scores[1];
    dom.p1Box.classList.toggle('active', G.currentPlayer === 0 && G.state !== 'over');
    dom.p2Box.classList.toggle('active', G.currentPlayer === 1 && G.state !== 'over');

    dom.p1Name.textContent = seatName(G.players[0]);
    dom.p2Name.textContent = seatName(G.players[1]);

    // 摆白球时，中央按钮从 Shoot 变成 Confirm，点击等同按空格确认
    if (dom.shootBtn) {
      dom.shootBtn.textContent = G.state === 'placing' ? t('ui.confirm') : t('ui.shoot');
      dom.shootBtn.title = G.state === 'placing' ? 'Confirm cue ball position (Space)' : 'Space';
    }

    if (G.state === 'placing') {
      dom.turnLabel.textContent = t('turn.placing', { seat: G.currentPlayer + 1 });
    } else if (G.isRespottedBlack) {
      dom.turnLabel.textContent = t('turn.respotted', { seat: G.currentPlayer + 1 });
    } else if (G.gameMode === 'eightball') {
      const on = R.ballOn(publicState(), G.balls);
      dom.turnLabel.textContent = t('turn.eight', {
        seat: G.currentPlayer + 1, group: labelText(on.label),
      });
    } else if (G.gameMode === 'nineball') {
      const on = R.ballOn(publicState(), G.balls);
      dom.turnLabel.textContent = t('turn.nine', {
        seat: G.currentPlayer + 1, ball: I ? I.ballName(on.label) : on.label,
      });
    } else if (G.gameMode === 'clearance') {
      dom.turnLabel.textContent = t('turn.clearance', { seat: G.currentPlayer + 1 });
    } else {
      const on = R.ballOn(publicState(), G.balls);
      dom.turnLabel.textContent = t('turn.seatOn', {
        seat: G.currentPlayer + 1, ball: labelText(on.label),
      });
    }

    dom.breakLabel.textContent = String(G.breaks[G.currentPlayer]);
    dom.highLabel.textContent = t('ui.high', { n: G.highBreak });
    const threads = C.aiPool && C.aiPool.size ? C.aiPool.size() : 0;
    const think = G.aiThinking
      ? (t('ui.thinking') + (threads > 1 ? ' · ' + threads + ' ' + t('ui.threads') : ''))
      : (G.paused && G.aiVs !== 'off' ? t('ui.paused') : '');
    dom.thinkLabel.textContent = think;
    dom.thinkLabel.style.opacity = think ? '1' : '0';

    updateBallCount();
  }

  function onHint(label) {
    return `<div class="bc-hint" data-prefix="${t('ui.ballOn')}">${label}</div>`;
  }

  function updateBallCount() {
    if (G.isRespottedBlack) {
      dom.ballCount.innerHTML =
        '<div class="ball-count-group"><span class="ball-count-label" style="color:#ffd93d;">&#9679;</span>'
        + `<span class="ball-count-num" style="color:#ffd93d;">${t('ui.respotted')}</span></div>`
        + onHint(I ? I.ballName('black') : 'Black');
      return;
    }
    const on = R.ballOn(publicState(), G.balls);
    if (G.gameMode === 'nineball') {
      const on = R.ballOn(publicState(), G.balls);
      const left = G.balls.filter(b => C.POOL_NINE.indexOf(b.label) >= 0 && b.isOnTable()).length;
      dom.ballCount.innerHTML =
        `<div class="ball-count-group"><span class="ball-count-label">${t('ui.on')}</span>`
        + `<span class="ball-count-num">${C.COL_CN[on.label] || '—'}</span>`
        + `<span class="ball-count-sep">|</span><span class="ball-count-label">${t('ui.ballsLeft')}</span>`
        + `<span class="ball-count-num">${left}</span></div>`
        + onHint(`${C.COL_CN[on.label] || '—'} · ${t('ui.lowestFirst')}`);
      return;
    }
    if (G.gameMode === 'eightball') {
      const group = G.poolGroups && G.poolGroups[G.currentPlayer];
      const set = group === 'stripes' ? C.POOL_STRIPES : C.POOL_SOLIDS;
      const left = group ? set.filter(l => G.balls.some(b => b.label === l && b.isOnTable())).length : 0;
      const eight = G.balls.some(b => b.label === 'eight' && b.isOnTable()) ? 1 : 0;
      dom.ballCount.innerHTML =
        `<div class="ball-count-group"><span class="ball-count-label">${group ? (group === 'solids' ? t('ui.solids') : t('ui.stripes')) : t('ui.openTable')}</span>`
        + `<span class="ball-count-num">${group ? left : '—'}</span>`
        + `<span class="ball-count-sep">|</span><span class="ball-count-label">${t('ui.eight')}</span>`
        + `<span class="ball-count-num">${eight}</span></div>`
        + onHint(labelText(on.label));
      return;
    }
    const colorLabels = C.COL_ORDER;
    let html = '<div class="ball-count-group">';

    if (G.gameMode === 'clearance') {
      html += `<span class="ball-count-label" style="color:#2ed573;">${t('ui.clearance')}</span>`;
    } else {
      const reds = G.balls.filter(b => b.label === 'red' && b.isOnTable()).length;
      html += `<span class="ball-count-label">${t('ui.reds')}</span>`
        + `<div class="ball-count-item"><span class="ball-count-dot" style="background:${C.COL.red}"></span>`
        + `<span class="ball-count-num">${reds}</span></div>`;
    }

    for (const label of colorLabels) {
      const n = G.balls.filter(b => b.label === label && b.isOnTable()).length;
      if (n > 0) {
        html += '<span class="ball-count-sep">|</span>'
          + `<div class="ball-count-item"><span class="ball-count-dot" style="background:${C.COL[label]}"></span>`
          + `<span class="ball-count-num">${n}</span></div>`;
      }
    }
    html += '</div>';
    html += onHint(labelText(on.label));
    dom.ballCount.innerHTML = html;
  }

  // ================================================================
  //  球员对话
  //
  //  台词数据在 chatter.js，这里只负责"什么时候说、谁说"。
  //  节奏：全局至少隔 18 秒；催促 60 秒最多一次；闲聊 120 秒最多一次。
  // ================================================================
  let chatterHideTimer = null;
  let lastChatterAt = -1e9;
  let lastHurryAt = -1e9;
  let lastIdleAt = -1e9;
  let lastHumanInput = performance.now();

  function aiOpponentSeat(p) {
    const o = 1 - p;
    return G.players[o] && G.players[o].type === 'ai' ? o : -1;
  }

  function say(seat, category, ctx) {
    if (!C.chatter || !G.players[seat]) return false;
    if (G.players[seat].type !== 'ai') return false;
    const nw = performance.now();
    if (nw - lastChatterAt < 18000) return false;
    const level = G.players[seat].level || 'master';
    const text = C.chatter.pick(level, category, ctx || {});
    if (!text) return false;

    dom.chatterName.textContent = seatName(G.players[seat]);
    dom.chatterText.textContent = text;
    dom.chatterBox.hidden = false;
    requestAnimationFrame(() => dom.chatterBox.classList.add('show'));
    if (chatterHideTimer) clearTimeout(chatterHideTimer);
    chatterHideTimer = setTimeout(() => {
      dom.chatterBox.classList.remove('show');
      chatterHideTimer = setTimeout(() => { dom.chatterBox.hidden = true; }, 260);
    }, 5500);
    lastChatterAt = nw;
    return true;
  }

  function chatterAfterShot(verdict, p) {
    if (!C.chatter) return;
    const shooter = seatName(G.players[p]);
    const shooterAI = G.players[p].type === 'ai';
    const opponent = aiOpponentSeat(p);

    if (verdict.gameOver) return;         // 结算弹窗会盖住对话

    // 犯规：对手 AI 反应；没有 AI 对手时，AI 自己嘀咕一句
    if (verdict.penalty > 0 || (verdict.legal === false && verdict.foulReason)) {
      if (opponent >= 0) say(opponent, 'foul', { opponent: shooter });
      else if (shooterAI) say(p, 'selfFoul', { opponent: shooter });
      return;
    }

    // 得分：按单杆高度选语气
    if (verdict.points > 0) {
      const brk = G.breaks[p] || verdict.points;
      if (brk >= 147) {
        if (opponent >= 0) say(opponent, 'max', { opponent: shooter, break: brk });
        else if (shooterAI) say(p, 'selfMax', { opponent: shooter, break: brk });
      } else if (brk >= 100) {
        if (opponent >= 0) say(opponent, 'century', { opponent: shooter, break: brk });
        else if (shooterAI) say(p, 'selfPot', { opponent: shooter, break: brk });
      } else if (brk >= 50) {
        if (opponent >= 0 && Math.random() < 0.25) say(opponent, 'praise', { opponent: shooter });
        else if (shooterAI && Math.random() < 0.12) say(p, 'selfPot', {});
      } else if (Math.random() < 0.06) {
        if (opponent >= 0) say(opponent, 'praise', { opponent: shooter });
        else if (shooterAI && Math.random() < 0.5) say(p, 'selfPot', {});
      }
      return;
    }

    // 没进球：人类打丢时对手偶尔补一句；AI 没有 AI 对手时自己嘀咕
    if (Math.random() < 0.10) {
      if (opponent >= 0) say(opponent, 'miss', { opponent: shooter });
      else if (shooterAI) say(p, 'selfMiss', { opponent: shooter });
    }
  }

  // 人类长时间不击球 → 对手催促 / 闲聊
  document.addEventListener('pointerdown', () => { lastHumanInput = performance.now(); }, true);
  document.addEventListener('keydown', () => { lastHumanInput = performance.now(); }, true);
  setInterval(() => {
    if (!G || G.paused || G.summaryOpen || G.state === 'moving' || G.state === 'stroking') return;
    const nw = performance.now();

    if (spectate()) {
      if (nw - lastIdleAt > 120000 && Math.random() < 0.35) {
        const seat = Math.random() < 0.5 ? 0 : 1;
        if (say(seat, 'idle', {})) lastIdleAt = nw;
      }
      return;
    }

    if (!humanTurn()) return;
    if (nw - lastHumanInput > 25000 && nw - lastHurryAt > 60000) {
      const opp = aiOpponentSeat(G.currentPlayer);
      if (opp >= 0 && say(opp, 'hurry', { opponent: seatName(G.players[G.currentPlayer]) })) {
        lastHurryAt = nw;
      }
    } else if (nw - lastHumanInput > 60000 && nw - lastIdleAt > 120000) {
      const opp = aiOpponentSeat(G.currentPlayer);
      if (opp >= 0 && say(opp, 'idle', {})) lastIdleAt = nw;
    }
  }, 4500);

  // ================================================================
  //  教学模式（GT 驾照式单课练习）
  // ================================================================
  const TUT_DONE_KEY = 'snk.tutorial.done';
  let tutorialMenuWasPaused = false;
  let tutorialNextTimer = null;

  function tutText(o) {
    return C.tutorial ? C.tutorial.txt(o) : ((o && o.en) || '');
  }
  function tutLesson() {
    return G.tutorial && C.tutorial ? C.tutorial.byId(G.tutorial.id) : null;
  }
  function tutStep() {
    const lesson = tutLesson();
    return lesson ? lesson.steps[G.tutorial.stepIndex] : null;
  }
  function tutDoneList() {
    try {
      const raw = localStorage.getItem(TUT_DONE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function tutMarkDone(id) {
    try {
      const arr = tutDoneList();
      if (arr.indexOf(id) < 0) arr.push(id);
      localStorage.setItem(TUT_DONE_KEY, JSON.stringify(arr));
    } catch (e) { /* ignore */ }
  }
  function tutStepLabel() {
    const lesson = tutLesson();
    if (!lesson) return '';
    return t('tut.step', {
      n: G.tutorial.stepIndex + 1,
      total: lesson.steps.length,
    });
  }

  function updateTutorialHud() {
    if (!dom.tutorialHud) return;
    const lesson = tutLesson();
    const step = tutStep();
    if (!G.tutorial || !lesson || !step) {
      dom.tutorialHud.hidden = true;
      return;
    }
    dom.tutorialHud.hidden = false;
    dom.tutStep.textContent = tutStepLabel();
    dom.tutName.textContent = tutText(step.title);
    dom.tutGoal.textContent = tutText(step.goal);
    dom.tutRetry.textContent = t('tut.retry');
    dom.tutMenuBtn.textContent = t('tut.lessons');
    dom.tutExitBtn.textContent = t('tut.exit');
  }

  function renderTutorialGrid() {
    if (!dom.tutorialGrid || !C.tutorial) return;
    const done = tutDoneList();
    dom.tutorialGrid.textContent = '';
    for (const lesson of C.tutorial.lessons) {
      const card = document.createElement('button');
      card.className = 'tut-card' + (done.indexOf(lesson.id) >= 0 ? ' done' : '');
      card.type = 'button';
      const top = document.createElement('div');
      top.className = 'tut-card-top';
      const num = document.createElement('span');
      num.className = 'tut-num';
      num.textContent = done.indexOf(lesson.id) >= 0 ? '✓' : lesson.icon;
      const title = document.createElement('span');
      title.className = 'tut-card-title';
      title.textContent = tutText(lesson.title);
      const check = document.createElement('span');
      check.className = 'tut-check';
      check.textContent = done.indexOf(lesson.id) >= 0 ? '✓' : '';
      top.appendChild(num); top.appendChild(title); top.appendChild(check);
      const desc = document.createElement('div');
      desc.className = 'tut-card-desc';
      desc.textContent = tutText(lesson.intro);
      card.appendChild(top); card.appendChild(desc);
      card.addEventListener('click', () => startTutorial(lesson.id, 0));
      dom.tutorialGrid.appendChild(card);
    }
    if (dom.tutKicker) dom.tutKicker.textContent = t('tut.kicker');
    if (dom.tutTitle) dom.tutTitle.textContent = t('tut.title');
    if (dom.tutNote) {
      dom.tutNote.textContent = done.length >= C.tutorial.lessons.length
        ? t('tut.allDone') : t('tut.note');
    }
  }

  function openTutorialMenu() {
    if (!C.tutorial) return;
    clearTimeout(tutorialNextTimer);
    if (C.TABLE_MODE !== 'snooker') {
      location.href = location.pathname + '?mode=classic&tutorial=1';
      return;
    }
    if (G.state === 'moving' || G.state === 'stroking') {
      showMsg(t('tut.wait'), '', 1600);
      return;
    }
    if (G.tutorial) G.tutorial.waiting = true;
    tutorialMenuWasPaused = G.paused;
    G.paused = true;
    updatePauseBtn();
    renderTutorialGrid();
    dom.tutorialOverlay.hidden = false;
  }

  function closeTutorialMenu() {
    dom.tutorialOverlay.hidden = true;
    if (G.tutorial) {
      loadTutorialStep(G.tutorial.stepIndex);
    } else {
      G.paused = tutorialMenuWasPaused;
      updatePauseBtn();
      if (!G.paused) maybeScheduleAI();
    }
  }

  function clearTutorialResult() {
    if (dom.tutorialResult) dom.tutorialResult.hidden = true;
  }

  function startTutorial(id, stepIndex) {
    if (!C.tutorial) return;
    if (C.TABLE_MODE !== 'snooker') {
      location.href = location.pathname + '?mode=classic&tutorial=1';
      return;
    }
    const lesson = C.tutorial.byId(id);
    if (!lesson) return;
    if (use3d) toggle3d();                 // 目标圈只画在 2D；教学统一用 2D
    dom.tutorialOverlay.hidden = true;
    clearTutorialResult();
    clearTimeout(tutorialNextTimer);
    G.tutorial = {
      id: id,
      stepIndex: C.clamp(stepIndex | 0, 0, lesson.steps.length - 1),
      waiting: false,
      zone: null,
    };
    G.players = [
      { type: 'human', level: 'master' },
      { type: 'human', level: 'master' },
    ];
    G.currentPlayer = 0;
    G.gameMode = 'classic';
    if (dom.modeSelect) dom.modeSelect.value = 'classic';
    G.scores = [0, 0];
    G.breaks = [0, 0];
    G.highBreak = 0;
    G.stats = [newSeatStats(), newSeatStats()];
    G.paused = false;
    G.aiThinking = false;
    G.aiToken++;
    G.pendingKind = '';
    updatePauseBtn();
    loadTutorialStep(G.tutorial.stepIndex);
  }

  function loadTutorialStep(index) {
    clearTimeout(tutorialNextTimer);
    const lesson = tutLesson();
    if (!lesson) return;
    if (!G.tutorial) return;
    const idx = C.clamp(index | 0, 0, lesson.steps.length - 1);
    const step = lesson.steps[idx];
    const spec = step.setup(C);
    if (!spec) return;

    G.tutorial.stepIndex = idx;
    G.tutorial.waiting = false;
    G.tutorial.zone = spec.zone || null;

    G.balls = [];
    G.cueBall = new C.Ball(spec.cue.x, spec.cue.y, 'white');
    G.balls.push(G.cueBall);
    for (const b of (spec.balls || [])) {
      G.balls.push(new C.Ball(b.x, b.y, b.label));
    }

    G.state = 'aim';
    G.paused = false;
    updatePauseBtn();
    G.aimAngle = Number.isFinite(spec.aimAngle) ? spec.aimAngle : 0;
    G.aimLocked = false;
    document.body.classList.remove('aim-locked');
    G.power = Number.isFinite(spec.power) ? spec.power : 14;
    G.spinX = Number.isFinite(spec.spinX) ? spec.spinX : 0;
    G.spinY = Number.isFinite(spec.spinY) ? spec.spinY : 0;
    G.pitchDeg = Number.isFinite(spec.pitchDeg) ? spec.pitchDeg : 0;
    G.guideMode = Number.isFinite(spec.guideMode) ? spec.guideMode : 3;
    if (dom.guideSelect) dom.guideSelect.value = String(G.guideMode);
    G.opening = false;
    G.cueInHand = false;
    G.isRespottedBlack = false;
    G.needRed = true;
    G.pottedRedThisTurn = false;
    G.poolOpen = true;
    G.poolGroups = [null, null];
    G.negativeStreak = 0;
    G.noPotStreak = [0, 0];
    G.forceNotice = [0, 0];
    G.cueClear = null;
    G.trail = [];
    G.trailTime = 0;
    G.shotStartCue = null;
    G.ballsVersion++;
    live.potted = []; live.firstContact = null; live.firstContactBall = null;
    live.pottedByLabel = {}; live.kind = ''; live.onLabel = null;

    updatePowerDisplay();
    updateHUD();
    updateBallCount();
    updateTutorialHud();
    clearTutorialResult();
    lastPlain = '';
    if (dom.statusPrev) dom.statusPrev.textContent = '';
    showMsg(tutText(step.title), tutText(step.tip), 5200);
    if (SNK.bgm) SNK.bgm.duck(false);
  }

  function tutorialOnSettled() {
    const lesson = tutLesson();
    const step = tutStep();
    if (!lesson || !step) return;
    const ctx = {
      potted: live.potted.slice(),
      firstContact: live.firstContact,
      cue: G.cueBall,
      balls: G.balls,
      startCue: G.shotStartCue,
      zone: G.tutorial.zone,
    };
    let result;
    try { result = step.check(ctx, C) || { pass: false }; }
    catch (e) { result = { pass: false, msg: { en: 'Check failed.', zh: '判定出错。' } }; }

    G.state = 'aim';
    G.tutorial.waiting = true;
    updateHUD();

    if (result.pass) {
      if (G.tutorial.stepIndex < lesson.steps.length - 1) {
        const next = G.tutorial.stepIndex + 1;
        showMsg(t('tut.stepClear'), tutText(result.msg), 1800);
        clearTimeout(tutorialNextTimer);
        tutorialNextTimer = setTimeout(() => {
          if (G.tutorial && G.tutorial.id === lesson.id && G.tutorial.stepIndex === next - 1) {
            loadTutorialStep(next);
          }
        }, 1100);
      } else {
        tutMarkDone(lesson.id);
        showTutorialResult(true, tutText(result.msg));
      }
    } else {
      showTutorialResult(false, tutText(result.msg));
    }
  }

  function showTutorialResult(pass, text) {
    const lesson = tutLesson();
    if (!lesson) return;
    G.tutorial.waiting = true;
    if (dom.tutorialResult) {
      dom.tutorialResult.hidden = false;
      dom.tutorialResult.classList.toggle('fail', !pass);
      dom.tutResultMark.textContent = pass ? '✓' : '×';
      dom.tutResultTitle.textContent = pass ? t('tut.pass') : t('tut.fail');
      dom.tutResultText.textContent = text || '';
      dom.tutRetryBtn.textContent = t('tut.retry');
      dom.tutNextBtn.textContent = t('tut.next');
      dom.tutLessonsBtn.textContent = t('tut.lessons');
      const idx = C.tutorial.lessons.indexOf(lesson);
      dom.tutNextBtn.hidden = !pass || idx >= C.tutorial.lessons.length - 1;
    }
    updateTutorialHud();
  }

  function retryTutorialStep() {
    if (!G.tutorial) return;
    clearTutorialResult();
    loadTutorialStep(G.tutorial.stepIndex);
  }

  function nextTutorialLesson() {
    const lesson = tutLesson();
    if (!lesson) return;
    const idx = C.tutorial.lessons.indexOf(lesson);
    const next = C.tutorial.lessons[idx + 1];
    if (next) startTutorial(next.id, 0);
    else openTutorialMenu();
  }

  function exitTutorial() {
    clearTimeout(tutorialNextTimer);
    G.tutorial = null;
    dom.tutorialHud.hidden = true;
    dom.tutorialOverlay.hidden = true;
    clearTutorialResult();
    applySeats();          // 恢复座位下拉里的正常对手，并重开一局
  }

  // ================================================================
  //  开局 / 复位
  // ================================================================
  function initBalls() {
    G.balls = [];

    if (G.gameMode === 'clearance') {
      G.cueBall = new C.Ball(C.CUE_START.x, C.CUE_START.y, 'white');
      G.balls.push(G.cueBall);
      for (const label of C.COL_ORDER) {
        const pos = C.getColorPos(label);
        if (pos) G.balls.push(new C.Ball(pos.x, pos.y, label));
      }
      return;
    }
    if (G.gameMode === 'respottedBlack') {
      G.cueBall = new C.Ball(C.CUE_START.x, C.CUE_START.y, 'white');
      G.balls.push(G.cueBall);
      G.balls.push(new C.Ball(C.BLACK_X, C.CY2, 'black'));
      return;
    }
    if (G.gameMode === 'nineball') {
      G.cueBall = new C.Ball(C.CUE_START.x, C.CUE_START.y, 'white');
      G.balls.push(G.cueBall);
      const rack = [
        ['b1'],
        ['b2', 'b3'],
        ['b4', 'b9', 'b5'],
        ['b6', 'b7'],
        ['b8'],
      ];
      const apexX = C.PINK_X + C.BALL_D + 1;
      const rowStep = Math.round(Math.sqrt(3) / 2 * C.BALL_D * 100) / 100;
      for (let row = 0; row < rack.length; row++) {
        const rx = apexX + row * rowStep;
        for (let col = 0; col < rack[row].length; col++) {
          const py = C.CY2 + (col - (rack[row].length - 1) / 2) * C.BALL_D;
          G.balls.push(new C.Ball(rx, py, rack[row][col]));
        }
      }
      return;
    }
    if (G.gameMode === 'eightball') {
      G.cueBall = new C.Ball(C.CUE_START.x, C.CUE_START.y, 'white');
      G.balls.push(G.cueBall);
      const rack = [
        ['s1'],
        ['t1', 's2'],
        ['s3', 'eight', 't2'],
        ['t3', 's4', 't4', 's5'],
        ['s6', 't5', 's7', 't6', 't7'],
      ];
      const apexX = C.PINK_X + C.BALL_D + 1;
      const rowStep = Math.round(Math.sqrt(3) / 2 * C.BALL_D * 100) / 100;
      for (let row = 0; row < rack.length; row++) {
        const rx = apexX + row * rowStep;
        for (let col = 0; col < rack[row].length; col++) {
          const py = C.CY2 + (col - (rack[row].length - 1) / 2) * C.BALL_D;
          G.balls.push(new C.Ball(rx, py, rack[row][col]));
        }
      }
      G.poolOpen = true;
      G.poolGroups = [null, null];
      return;
    }

    // 经典：15 红三角 + 6 彩 + 白球
    G.cueBall = new C.Ball(C.CUE_START.x, C.CUE_START.y, 'white');
    G.balls.push(G.cueBall);

    const apexX = C.PINK_X + C.BALL_D + 1;
    const rowStep = Math.round(Math.sqrt(3) / 2 * C.BALL_D * 100) / 100;
    for (let row = 0; row < 5; row++) {
      const rx = apexX + row * rowStep;
      for (let col = 0; col <= row; col++) {
        const py = C.CY2 + (col - row / 2) * C.BALL_D;
        G.balls.push(new C.Ball(rx, py, 'red'));
      }
    }
    for (const label of C.COL_ORDER) {
      const pos = C.getColorPos(label);
      if (pos) G.balls.push(new C.Ball(pos.x, pos.y, label));
    }
  }

  function resetAimToDefault() {
    if (G.cueBall && G.cueBall.isOnTable()) G.aimAngle = -Math.PI / 8;
    setAimLock(false, true);          // 新一杆/换人一律回到"跟着鼠标"，不留上一杆的锁定
  }

  function resetGame() {
    // 从教学里点 Restart / 正常开局：把教学 UI 一并收掉
    if (G.tutorial) {
      G.tutorial = null;
      clearTimeout(tutorialNextTimer);
      if (dom.tutorialHud) dom.tutorialHud.hidden = true;
      if (dom.tutorialOverlay) dom.tutorialOverlay.hidden = true;
      clearTutorialResult();
      // 教学把两位都临时设成 human；Restart 时必须按座位下拉恢复
      G.players[0] = makePlayer(seatVal(dom.seatASelect, 'human'));
      G.players[1] = makePlayer(seatVal(dom.seatBSelect, 'master'));
      G.aiVs = bothAI() ? 'on' : 'off';
      G.paused = false;
      updatePauseBtn();
    }
    G.scores = [0, 0];
    G.breaks = [0, 0];
    G.currentPlayer = 0;
    G.state = 'aim';
    G.power = 0;
    G.spinX = 0; G.spinY = 0;
    G.pitchDeg = 0;
    G.stroke = null;
    physAccMs = 0;
    G.needRed = (G.gameMode === 'classic');
    G.pottedRedThisTurn = false;
    G.isRespottedBlack = (G.gameMode === 'respottedBlack');
    G.opening = (G.gameMode === 'classic' || G.gameMode === 'eightball' || G.gameMode === 'nineball');
    G.cueInHand = false;
    G.negativeStreak = 0;
    G.negativeNotice = 0;
    G.noPotStreak = [0, 0];
    G.forceNotice = [0, 0];
    G.shotStartCue = null;
    G.poolOpen = true;
    G.poolGroups = [null, null];
    G.trail = [];
    G.trailTime = 0;
    G.aiThinking = false;
    G.aiToken++;
    G.draggingCueBall = false;
    G.pendingKind = '';
    G.breakMilestone = 0;
    G.maxOnNoticed = false;
    G.snookerReqNotice = '';
    G.snookerNotice = '';
    G.cueBlockNotice = '';
    live.potted = []; live.firstContact = null; live.firstContactBall = null;
    live.pottedByLabel = {};
    live.kind = ''; live.onLabel = null;

    updatePowerDisplay();
    dom.powerWrap.classList.remove('show');
    clearMsgPanel();
    hideSummary();
    // 每开一局都回到俯视位 —— "进入对战默认是俯视图"就是靠这一行保证的。
    // （观战时的斜视巡游是"闲置够久"才自动发生的，跟开局无关。）
    setOrbitView(false);
    if (R3D && R3D.resetView) R3D.resetView();
    if (SNK.bgm) SNK.bgm.duck(false);
    clearTimeout(G.restartTimer);
    G.restartTimer = null;

    // 统计是**整局**口径：抢黑由 startRespottedBlack() 单独开，不重置这里
    G.stats = [newSeatStats(), newSeatStats()];
    beginVisit(0);

    initBalls();
    if (G.gameMode === 'classic') C.separateBalls(G.balls);
    G.ballsVersion++;
    resetAimToDefault();

    if (G.gameMode === 'eightball') {
      showMsg('8-Ball', 'Open table · pot any colour to choose solids or stripes, then the 8-ball', 4200);
    } else if (G.gameMode === 'nineball') {
      showMsg('9-Ball', 'Hit the lowest-numbered ball first · pot the 9 to win', 4200);
    } else if (G.gameMode === 'clearance') {
      showMsg('Clearance', 'Pot the colours in order: yellow &rarr; green &rarr; brown &rarr; blue &rarr; pink &rarr; black', 3400);
    } else if (G.gameMode === 'respottedBlack') {
      showMsg('Respotted black', 'Pot the black to win the frame', 3200);
    } else {
      showMsg('New frame', 'Aim with the mouse · set power on the bar · <em>Shoot</em> with Space', 3400);
    }

    // 斯诺克开球：白球在 D 区内自由摆放。原来一开局就固定放在 CUE_START，
    // 少了"开球前摆球"这一步。人类开球时直接进 placing 状态；
    // AI 开球仍走自己的 breakOff（它本来就会从 D 区出杆）。
    if (G.gameMode === 'classic' && G.players[0].type === 'human' &&
        G.cueBall && G.cueBall.isOnTable()) {
      G.state = 'placing';
      G.draggingCueBall = false;
      showMsg('Cue ball in hand',
        'Drag the white anywhere inside the D, then press <em>Space</em> to confirm', 5200);
    }
    updateHUD();
    autoSaveGame();
    maybeScheduleAI();
  }

  // ================================================================
  //  出杆
  // ================================================================
  // 现在出杆是**独立动作**：鼠标只负责方向，力度和塞由各自控件调，
  // 真正击球要点 "Shoot" 按钮或按空格。
  function canShoot() {
    if (G.tutorial && G.tutorial.waiting) return false;
    return humanTurn() && G.state === 'aim' && G.cueBall && G.cueBall.isOnTable();
  }

  // 出杆动画：先往后拉杆，再加速前送，杆头触球的那一瞬才真正 strike。
  // 这段时间状态是 'stroking'，所有瞄准/力度/再出杆输入都被状态机挡在外面。
  const STROKE_PULL_MS = 180;
  const STROKE_HIT_MS = 90;

  function shoot() {
    if (G.tutorial && G.tutorial.waiting) return;
    if (G.state !== 'aim' && G.state !== 'powering' && G.state !== 'dragging') return;
    if (!G.cueBall || !G.cueBall.isOnTable()) return;
    if (G.power < C.MIN_POWER) {
      G.state = 'aim';
      showMsg('Set some power first', 'Drag the power bar, or press <em>W</em>/<em>S</em> or <em>&uarr;</em>/<em>&darr;</em>', 1800);
      return;
    }

    // 出杆前更新一次可击球面（提示 + 3D 抬杆用）。击点本身不在
    // 这里改，strike() 会按同一份 cueClear 夹紧。
    refreshCueClear();

    live.potted = [];
    live.firstContact = null;
    live.firstContactBall = null;
    live.pottedByLabel = {};
    // 出杆这一刻定下本杆的两个统计要素：目标球（给人类判"是否进攻"）和决策种类（AI 给）
    live.onLabel = R.ballOn(publicState(), G.balls).label;
    live.kind = G.pendingKind || '';
    G.pendingKind = '';
    G.shotStartCue = { x: G.cueBall.x, y: G.cueBall.y };
    G.opening = false;                   // 第一杆已经出杆，后面的 AI 不再走开球逻辑
    G.cueInHand = false;

    // 快照本杆参数。真正发力在动画结束时，改这些值也不会影响已经出杆的这一杆。
    G.stroke = {
      angle: G.aimAngle, power: G.power,
      spinX: G.spinX, spinY: G.spinY,
      pitchDeg: G.pitchDeg,
      t: 0, pull: 0, fired: false,
    };
    G.state = 'stroking';
    setAimLock(false, true);                    // 出杆后解锁：下一杆从"跟着鼠标"开始
    dom.powerWrap.classList.remove('show');
    updateHUD();
  }

  // 由主循环按真实时间推进（不受 0.5×~4× 游戏速度影响：出杆手感必须稳定）
  function updateStroke(dtMs) {
    const s = G.stroke;
    if (!s) return;
    s.t += dtMs;
    if (s.t < STROKE_PULL_MS) {
      const u = s.t / STROKE_PULL_MS;
      s.pull = 1 - (1 - u) * (1 - u);          // ease-out：先快后慢地拉到位
    } else {
      const u = Math.min(1, (s.t - STROKE_PULL_MS) / STROKE_HIT_MS);
      s.pull = 1 - u * u;                      // ease-in：向前加速，触球时速度为最大
      if (u >= 1) strikeNow(s);
    }
  }

  function strikeNow(s) {
    if (s.fired || !G.cueBall) return;
    s.fired = true;
    C.strike(G.cueBall, s.angle, s.power, s.spinX, s.spinY,
      s.pitchDeg * Math.PI / 180, G.balls);
    if (SNK.bgm) SNK.bgm.cueHit(s.power);      // 皮头触球声（与物理事件无关，出杆即有）
    G.trail = G.balls.map(b => ({ label: b.label, pts: [], color: trailColor(b) }));
    G.trailTime = 0;
    physAccMs = 0;                             // 触球这一帧不补跑积压时间
    G.stroke = null;
    G.state = 'moving';
    updateHUD();
  }

  function trailColor(b) {
    const a = { white: '255,255,255', red: '255,71,87', yellow: '255,217,61', green: '46,213,115',
      brown: '192,133,74', blue: '77,171,247', pink: '255,107,157', black: '150,150,150' }[b.label] || '200,200,200';
    return 'rgba(' + a + ',0.55)';
  }

  // ================================================================
  //  物理推进 + 事件收集
  // ================================================================
  // audioOn 是**唯一**打开音效事件采集的开关。AI 搜索（sim.js）和跑分工具
  // 自己造 ev，不带这个字段 → 物理里那两处 `if (ev.audioOn)` 走 falsy 分支，
  // 一次数组 push 都不会发生。tools/bench.js 的数字不变就是这条设计的证明。
  const ev = { potted: [], firstContact: null, bounces: 0, cueBall: null,
               audioOn: true, hits: [], cushions: [] };

  function tickPhysics() {
    ev.potted = [];
    ev.firstContact = null;
    ev.bounces = 0;
    ev.cueBall = G.cueBall;
    ev.hits = [];
    ev.cushions = [];

    const moving = C.stepWorld(G.balls, ev);

    // 当帧的碰撞翻成声音（撞球 / 撞库 / 进袋）
    if (SNK.bgm && SNK.bgm.audible()) SNK.bgm.shot(ev);

    // 收集落袋
    for (const label of ev.potted) {
      live.potted.push(label);
      live.pottedByLabel[label] = (live.pottedByLabel[label] || 0) + 1;
    }
    if (ev.firstContact && !live.firstContact) {
      live.firstContact = ev.firstContact.label;
      live.firstContactBall = ev.firstContact;
    }

    // 轨迹录制（每移动 3px 记一个点，别把内存刷爆）
    for (let i = 0; i < G.balls.length; i++) {
      const t = G.trail[i];
      if (!t) continue;
      const b = G.balls[i];
      if (!b.isOnTable()) continue;
      const last = t.pts[t.pts.length - 1];
      if (!last || Math.hypot(b.x - last.x, b.y - last.y) > 3) {
        t.pts.push({ x: b.x, y: b.y });
      }
    }

    if (!moving) {
      for (const b of G.balls) {
        b.vx = 0; b.vy = 0;
        b.wx = 0; b.wy = 0; b.wz = 0;
      }
      onSettled();
    }
  }

  // ================================================================
  //  局势提示（第十一轮）：斯诺克 / 超分 / 147 / 单杆里程碑
  // ================================================================
  // 台面还能打出多少分。
  //   有红球时：每颗红球最多再配一颗黑球（8 分），加六颗彩球 27 分。
  //   没红球时：台面上剩余彩球的分值之和（清彩阶段每颗只算一次）。
  function pointsOnTable() {
    const reds = R.countOnTable(G.balls, 'red');
    if (reds > 0) return reds * 8 + 27;
    let sum = 0;
    for (const b of G.balls) {
      if (b.isOnTable() && b.isColor) sum += R.valOf(b.label);
    }
    return sum;
  }

  // 白球到目标球中心线 + 左右各一个球半径的边线，只要有一条干净就算能打到。
  // 这是"有没有被完全斯诺克"的几何判据；不模拟，所以不会拖慢主循环。
  function canSeeTarget(cue, t) {
    const dx = t.x - cue.x, dy = t.y - cue.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return true;
    const ox = -dy / d * C.BALL_R, oy = dx / d * C.BALL_R;
    for (let k = -1; k <= 1; k++) {
      const tx = t.x + ox * k, ty = t.y + oy * k;
      if (!C.pathBlocked(G.balls, cue.x, cue.y, tx, ty, cue, t, 0)) return true;
    }
    return false;
  }

  function isSnookered() {
    const cue = G.cueBall;
    if (!cue || !cue.isOnTable()) return false;
    const targets = R.legalTargets(publicState(), G.balls);
    if (!targets.length) return false;
    for (const t of targets) {
      if (canSeeTarget(cue, t)) return false;
    }
    return true;
  }

  // 一杆结束、轮到下一位时调用。inHand = 白球在手中（可自由摆 D 区），
  // 这时不存在"被斯诺克"。
  function notifyTurnStart(inHand) {
    if (G.state === 'over' || G.isRespottedBlack ||
        G.gameMode === 'eightball' || G.gameMode === 'nineball') return;
    if (inHand) { G.snookerNotice = ''; return; }

    if (isSnookered()) {
      const key = G.currentPlayer + '|' + G.stats[G.currentPlayer].visits;
      if (key !== G.snookerNotice) {
        G.snookerNotice = key;
        showMsg('Snooker',
          `${seatName(G.players[G.currentPlayer])} is snookered — no direct line to a legal ball`,
          3800);
        const opp = aiOpponentSeat(G.currentPlayer);
        if (opp >= 0) {
          say(opp, 'snooker', { opponent: seatName(G.players[G.currentPlayer]) });
        }
      }
    } else {
      G.snookerNotice = '';
    }
  }

  // 每次得分/罚分后调用：超分 / 147 / 50+ / 100+
  function notifyScoreState(p, scored, endFrame) {
    if (G.state === 'over') return;

    const br = G.breaks[p] || 0;
    const rem = pointsOnTable();
    const canMakeMax = G.gameMode === 'classic' && br >= 8 && (br + rem) === 147;

    if (scored) {
      // 第一次红+黑之后提示 "147 on"，本杆只提示一次。
      if (canMakeMax && !G.maxOnNoticed) {
        G.maxOnNoticed = true;
        if (br < 50) {
          showMsg('147 on',
            `${seatName(G.players[p])} is on for a maximum — ${br} scored, ${rem} left`,
            3600);
        }
      }

      if (br >= 147) {
        G.breakMilestone = 147;
        showMsg('Maximum 147', `${seatName(G.players[p])} has made a 147`, 6500);
      } else if (br >= 100) {
        if (G.breakMilestone < 100) {
          G.breakMilestone = 100;
          showMsg('Century', `${seatName(G.players[p])} breaks 100`, 3200);
        }
      } else if (br >= 50) {
        if (G.breakMilestone < 50) {
          G.breakMilestone = 50;
          showMsg('Half-century', `${seatName(G.players[p])} passes 50`, 2800);
        }
      }
    }

    // 超分：领先方分数 > 落后方分数 + 台面剩余分 → 落后方只能靠斯诺克追。
    // 只在一进入这个局面时提示一次；分数/剩余分变化后可以再提示。
    // 终局/抢黑时没有"剩余分"概念，跳过。
    if (endFrame || G.isRespottedBlack) { G.snookerReqNotice = ''; return; }
    const diff = G.scores[0] - G.scores[1];
    if (Math.abs(diff) > rem) {
      const leader = diff > 0 ? 0 : 1;
      const trailer = 1 - leader;
      const key = leader + '|' + Math.abs(diff) + '|' + rem;
      if (key !== G.snookerReqNotice) {
        G.snookerReqNotice = key;
        showMsg('Snookers required',
          `${seatName(G.players[trailer])} trails by ${Math.abs(diff)} with ${rem} on the table`,
          4400);
      }
    } else {
      G.snookerReqNotice = '';
    }
  }

  // ================================================================
  //  球停稳 → 判罚 → 结算
  // ================================================================
  function onSettled() {
    // 教学模式：不进正常判罚/换人流程，只走课程判定
    if (G.tutorial) { tutorialOnSettled(); return; }

    const pool = (G.gameMode === 'eightball' || G.gameMode === 'nineball');
    const afterLabels = [];
    for (const b of G.balls) if (b.isOnTable()) afterLabels.push(b.label);

    const pre = publicState();
    const verdict = R.judge(pre, {
      firstContactLabel: live.firstContact,
      pottedLabels: live.potted.slice(),
      cuePotted: G.cueBall.potted,
      afterLabels: afterLabels,
    });

    const p = G.currentPlayer;

    // 8-ball 开球打进黑八：重开一局，不直接判负
    if (pool && verdict.rerack) {
      showMsg('8-Ball break', '8-ball potted on the break — re-racking', 2600);
      resetGame();
      return;
    }

    // ---- 得分 ----
    if (verdict.points > 0) {
      G.scores[p] += verdict.points;
      G.breaks[p] += verdict.points;
      if (G.breaks[p] > G.highBreak) G.highBreak = G.breaks[p];
    }
    if (verdict.penalty > 0) {
      G.scores[1 - p] += verdict.penalty;
      showFoul(`${verdict.foulReason} · ${verdict.penalty} away`);
    } else if (pool && !verdict.legal && verdict.foulReason) {
      showFoul(verdict.foulReason);
    }

    // 统计与对话放在加分之后：否则最后一杆的得分/单杆会被漏记。
    recordShot(verdict);
    chatterAfterShot(verdict, p);

    // ---- 彩球复位 ----
    // 规则 7(f)：多颗彩球同时复位时，分值高的先放。
    // C.respotColor 会处理"自己的点位被白球/别的球占住"的情况：
    // 先找最高分值空点位，再沿顶库方向找最近空位，不会让球凭空消失。
    const respotOrder = pool ? [] : verdict.respot.slice().sort((a, b) => (C.COL_VAL[b] || 0) - (C.COL_VAL[a] || 0));
    for (const label of respotOrder) {
      for (const b of G.balls) {
        if (b.label === label && b.potted) {
          C.respotColor(G.balls, b, label);
          break;
        }
      }
    }

    // ---- 白球 ----
    if (verdict.cueBallInHand || G.cueBall.potted) {
      if (pool) C.placeCueBallInHand(G.balls, G.cueBall);
      else C.placeCueBallInDZ(G.balls, G.cueBall);
      G.cueInHand = true;
    }

    // ---- 消极/贴球判断 ----
    // 斯诺克没有"消极打球"的正式罚则（只有超时/不当行为的裁判警告），
    // 所以这里不罚分：只记录"连续没有进球、白球几乎没走或停在别的球旁边"
    // 的杆数，用于提示对手和让 AI 主动打开局面。
    let negative = false;
    if (!pool && live.potted.length === 0 && G.cueBall && G.cueBall.isOnTable() && G.shotStartCue) {
      const travel = Math.hypot(G.cueBall.x - G.shotStartCue.x, G.cueBall.y - G.shotStartCue.y);
      const negLabel = G.isRespottedBlack ? 'black' : 'red';
      let nearTarget = Infinity;
      for (const b of G.balls) {
        if (b.label !== negLabel || !b.isOnTable()) continue;
        const d = Math.hypot(b.x - G.cueBall.x, b.y - G.cueBall.y);
        if (d < nearTarget) nearTarget = d;
      }
      // 只看"白球贴着红球堆"（抢黑时看黑球）。白球贴着台底彩球做斯诺克
      // 是正常防守，不算消极。
      negative = travel < 55 || nearTarget < C.BALL_R * 2.6;
    }
    if (negative) {
      G.negativeStreak++;
      if (G.negativeStreak >= 3 && G.negativeNotice < 3) {
        G.negativeNotice = 3;
        showMsg('Negative play',
          'Repeated short safeties / cue ball left in the pack — open the table', 3600);
      }
    } else {
      G.negativeStreak = 0;
      G.negativeNotice = 0;
    }

    // ---- 连续不进球计数 ----
    // 和上面的"消极/贴球"不是一回事：只要这杆没得分就算一次，不管它是
    // 主动防守还是尝试进攻。到 3 杆后 AI 会进入强制进球模式（forcedPot）。
    if (!G.noPotStreak) G.noPotStreak = [0, 0];
    if (!G.forceNotice) G.forceNotice = [0, 0];
    if (verdict.points > 0) {
      G.noPotStreak[p] = 0;
      G.forceNotice[p] = 0;
    } else {
      G.noPotStreak[p] = (G.noPotStreak[p] || 0) + 1;
      const shooter = G.players[p];
      if (shooter && shooter.type === 'ai' && G.noPotStreak[p] >= 3 && G.forceNotice[p] < 3) {
        G.forceNotice[p] = 3;
        showMsg('Must score',
          seatName(shooter) + ' has gone three shots without a pot — forcing the attack', 3200);
      }
    }

    G.ballsVersion++;
    G.trailTime = performance.now();

    // ---- 得分提示（147 / 百分杆 / 50+ / 超分）----
    if (!pool && (verdict.points > 0 || verdict.penalty > 0)) {
      notifyScoreState(p, verdict.points > 0, verdict.gameOver || verdict.tie);
    }

    // ---- 终局 ----
    if (verdict.gameOver) {
      G.state = 'over';
      G.aiThinking = false;
      endVisit(p);
      // 终局也留一句：赢家 AI 说 win，输家 AI 说 lose
      const winnerSeat = verdict.winner;
      if (winnerSeat === 0 || winnerSeat === 1) {
        const winnerP = G.players[winnerSeat];
        const loserP = G.players[1 - winnerSeat];
        if (winnerP && winnerP.type === 'ai') {
          say(winnerSeat, 'win', { opponent: seatName(loserP) });
        } else if (loserP && loserP.type === 'ai') {
          say(1 - winnerSeat, 'lose', { opponent: seatName(winnerP) });
        }
      }
      const auto = G.autoRestart && spectate() && !G.paused;
      showSummary(verdict.winner, auto);
      updateHUD();
      // 观战：自动开下一局，方便挂着看对局。4.2s 是给总结弹窗留的阅读时间，
      // 而且走 delayFor() → 仍然受"极快"档缩放。
      if (auto) {
        clearTimeout(G.restartTimer);
        G.restartTimer = setTimeout(() => {
          if (G.state === 'over' && G.autoRestart && !G.paused) resetGame();
        }, delayFor(4200));
      }
      return;
    }
    if (verdict.tie) {
      endVisit(p);
      startRespottedBlack();
      return;
    }

    // ---- 阶段推进 ----
    if (pool) {
      G.poolOpen = verdict.poolOpen !== false;
      G.poolGroups = (verdict.poolGroups || [null, null]).slice();
      G.needRed = false;
      G.pottedRedThisTurn = false;
    } else {
      G.needRed = verdict.nextNeedRed;
      G.pottedRedThisTurn = verdict.nextPottedRedThisTurn;
    }

    if (verdict.turnContinues) {
      G.state = 'aim';
      resetAimToDefault();
      updateHUD();
      autoSaveGame();
      maybeScheduleAI();
      return;
    }

    switchPlayer(verdict.cueBallInHand);
  }

  function switchPlayer(inHand) {
    endVisit(G.currentPlayer);             // 这一段上手结束，结算它的得分
    G.breaks[G.currentPlayer] = 0;         // 本杆结束，单杆得分归零
    G.breakMilestone = 0;
    G.maxOnNoticed = false;
    G.cueInHand = !!(inHand || (G.cueBall && G.cueBall.potted));
    G.currentPlayer = 1 - G.currentPlayer;
    G.needRed = R.countOnTable(G.balls, 'red') > 0;
    G.pottedRedThisTurn = false;
    G.state = 'aim';
    resetAimToDefault();
    live.potted = []; live.firstContact = null; live.firstContactBall = null;
    live.pottedByLabel = {};
    live.kind = ''; live.onLabel = null;
    beginVisit(G.currentPlayer);           // 新的一段上手开始
    updateHUD();
    notifyTurnStart(!!inHand);
    autoSaveGame();
    maybeScheduleAI();
  }

  function startRespottedBlack() {
    G.isRespottedBlack = true;
    G.needRed = false;
    G.pottedRedThisTurn = false;
    G.opening = false;
    G.negativeStreak = 0;
    G.negativeNotice = 0;
    G.balls = [];
    G.cueBall = new C.Ball(C.CUE_START.x, C.CUE_START.y, 'white');
    G.balls.push(G.cueBall);
    G.balls.push(new C.Ball(C.BLACK_X, C.CY2, 'black'));
    G.state = 'aim';
    G.breaks = [0, 0];
    resetAimToDefault();
    // 统计**不重置**（整局口径），但上手簿记要重新开一段
    beginVisit(G.currentPlayer);
    updateHUD();
    showMsg('Respotted black', `Scores level at ${G.scores[0]} : ${G.scores[1]} — black respotted, first pot wins`, 4200);
    autoSaveGame();
    maybeScheduleAI();
  }

  // ================================================================
  //  一局总结
  // ================================================================
  function showSummary(winner, auto) {
    const ov = dom.summaryOverlay;
    if (!ov) return;
    const a = G.stats[0], b = G.stats[1];

    dom.sumTitle.textContent = (G.highBreak >= 147) ? t('summary.max') : t('summary.frame');
    dom.sumScore.textContent = G.scores[0] + ' : ' + G.scores[1];
    const nameA = seatName(G.players[0]), nameB = seatName(G.players[1]);
    dom.sumNameA.textContent = nameA;
    dom.sumNameB.textContent = nameB;
    dom.sumNameA.className = winner === 0 ? 'win' : '';
    dom.sumNameB.className = winner === 1 ? 'win' : '';

    const rate = (st) => st.attempts ? Math.round(st.attemptsOk / st.attempts * 100) + '%' : '—';
    const rows = [
      [t('summary.points'), a.points, b.points, true],
      [t('summary.shots'), a.shots, b.shots],
      [t('summary.pots'), a.pots, b.pots],
      [t('summary.rate'), rate(a), rate(b)],
      [t('summary.best'), a.bestBreak, b.bestBreak],
      [t('summary.fouls'), a.fouls, b.fouls],
      [t('summary.foulPoints'), a.foulPoints, b.foulPoints],
      [t('summary.safeties'), a.safeties, b.safeties],
      [t('summary.snookers'), a.snookers, b.snookers],
      [t('summary.visits'), a.visits, b.visits],
      [t('summary.avg'), visitAvg(a), visitAvg(b)],
    ];
    let html = '';
    for (const [k, va, vb, hl] of rows) {
      html += `<tr${hl ? ' class="hl"' : ''}><td class="k">${k}</td>`
        + `<td class="v">${va}</td><td class="v">${vb}</td></tr>`;
    }
    dom.sumBody.innerHTML = html;

    dom.sumHint.textContent = auto
      ? t('summary.nextAuto')
      : t('summary.hint');
    if (!ov.hidden) {
      // 已经是开着的（连打两局）：不重播动画，只换内容
      return;
    }
    ov.hidden = false;
    G.summaryOpen = true;
    requestAnimationFrame(() => ov.classList.add('show'));
  }

  function hideSummary() {
    const ov = dom.summaryOverlay;
    if (!ov || ov.hidden) { G.summaryOpen = false; return; }
    ov.classList.remove('show');
    G.summaryOpen = false;
    const done = () => { ov.hidden = true; };
    setTimeout(done, 220);
  }

  // ================================================================
  //  AI 调度
  // ================================================================
  function maybeScheduleAI() {
    if (G.tutorial) return;
    const p = G.players[G.currentPlayer];
    if (!p || p.type !== 'ai') return;
    if (G.state !== 'aim') return;
    if (G.paused) return;                 // 暂停中：不再排下一杆

    const token = ++G.aiToken;
    G.pendingKind = '';                   // 新的决策排期 → 上一杆留下的 kind 作废
    G.aiThinking = true;
    updateHUD();

    // 先让"思考中"提示画出来，再搜索。有 Worker 时搜索在线程池里跑，
    // 主线程只等结果；没有 Worker 时自动退回原来的同步 decide()。
    setTimeout(async () => {
      if (token !== G.aiToken) return;
      if (G.state !== 'aim') return;
      if (G.paused) return;
      if (G.players[G.currentPlayer].type !== 'ai') return;

      let decision = null;
      const opts = { level: p.level, budgetMs: budgetFor(p.level) };
      try {
        decision = (C.aiPool && C.aiPool.available())
          ? await C.aiPool.decide(publicState(), G.balls, opts)
          : C.ai.decide(publicState(), G.balls, opts);
      } catch (e) {
        console.warn('AI 决策异常，改用兜底', e);
      }
      if (token !== G.aiToken) return;
      if (G.state !== 'aim') return;
      if (!decision || !decision.shot) {
        decision = { shot: { angle: G.aimAngle, power: 9, spinX: 0, spinY: 0 }, kind: 'fallback', reason: 'Nothing found — playing a basic shot' };
      }

      G.aiThinking = false;
      applyAIShot(decision, token);
    }, paced(THINK_BASE * (0.78 + Math.random() * 0.75) *
      (0.9 + Math.min(0.5, G.balls.reduce((n, b) => n + (b.isOnTable() ? 1 : 0), 0) / 40)),
      p.level));
  }

  function applyAIShot(d, token) {
    const shot = d.shot;
    G.aimAngle = shot.angle;
    G.spinX = shot.spinX || 0;
    G.spinY = shot.spinY || 0;
    G.pitchDeg = 0;             // AI 的搜索假设平杆，绝不能继承人类设的俯仰
    G.power = C.clamp(shot.power, 0, C.MAX_POWER);
    G.lastReason = d.reason || '';
    updatePowerDisplay();
    updateHUD();

    const tag = d.kind === 'safety' ? 'Safety · ' : (d.kind === 'pot' ? 'Pot · ' : 'Shot · ');
    showMsg(tag + (d.reason || 'AI shot'), '', 1600);

    // 让玩家看清瞄准线和走位预览，再出杆
    setTimeout(() => {
      if (token !== G.aiToken) return;
      if (G.state !== 'aim') return;
      if (G.paused) return;
      // kind 只在这里、shoot() 前一行写：aiToken 一失效这段排期就作废，
      // 脏 kind 不会留到下一杆去污染统计。
      G.pendingKind = d.kind || '';
      G.state = 'powering';
      shoot();
    }, paced(TRACE_BASE * (0.85 + Math.random() * 0.55), G.players[G.currentPlayer].level));
  }

  // ================================================================
  //  瞄准预览（真实模拟）
  // ================================================================
  let previewCache = null;
  let previewKey = '';

  function getPreview() {
    if (G.guideMode === 0) return null;                 // 全无：连模拟都不跑
    if (!G.cueBall || !G.cueBall.isOnTable()) return null;
    if (G.state === 'moving' || G.state === 'placing' || G.state === 'over') return null;
    // 俯仰、后斯诺克夹紧、cos 力度损失全部在 strike() 里做。
    // 预览只要把**同一组原始参数**交给 sim.js，就不会和实机算出两种结果。
    const base = G.power < C.MIN_POWER ? 8 : G.power;

    const key = [
      G.aimAngle.toFixed(4), base.toFixed(2),
      G.spinX.toFixed(3), G.spinY.toFixed(3), G.pitchDeg,
      G.currentPlayer, G.ballsVersion, G.cueBall.x.toFixed(2), G.cueBall.y.toFixed(2),
    ].join('|');
    if (key === previewKey && previewCache) return previewCache;
    previewKey = key;
    previewCache = C.sim.simulateShot(
      G.balls,
      {
        angle: G.aimAngle, power: base,
        spinX: G.spinX, spinY: G.spinY, pitchDeg: G.pitchDeg,
      },
      { track: true }
    );
    previewCache.angle = G.aimAngle;
    return previewCache;
  }

  // ================================================================
  //  绘制
  // ================================================================
  function render() {
    ctx.clearRect(0, 0, C.W, C.H);
    const effSpin = effectiveSpin();

    // 3D 模式：台面/球/球杆全交给 three.js，#gc 只当透明输入层
    if (use3d) {
      R3D.render({
        balls: G.balls,
        cueBall: G.cueBall,
        aimAngle: G.aimAngle,
        power: G.power,
        spinX: effSpin.sx, spinY: effSpin.sy,
        state: G.state,
        preview: (G.state === 'aim' || G.state === 'powering' || G.state === 'dragging' || G.state === 'stroking') ? getPreview() : null,
        guideMode: G.guideMode,
        pitchDeg: effSpin.pitchDeg,
        strokePull: G.stroke ? G.stroke.pull : 0,
        trail: G.trail,
        trailTime: G.trailTime,
        firstContact: live.firstContactBall,
        onLabel: (G.state === 'over') ? null : R.ballOn(publicState(), G.balls).label,
      });
      return;
    }

    RENDER.drawTable(ctx);

    // 教学目标圈：白球最终位置 / 袋口 / 需要碰到的球
    if (G.tutorial && G.tutorial.zone) {
      const z = G.tutorial.zone;
      ctx.save();
      ctx.beginPath();
      ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,217,61,0.10)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,217,61,0.75)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 开球摆白球：把 D 区淡淡地高亮出来，提示"只能放在这里"
    if (G.state === 'placing' && C.TABLE_MODE === 'snooker') {
      ctx.save();
      ctx.beginPath();
      ctx.arc(C.BAULK_X, C.CY2, C.DR, Math.PI / 2, Math.PI * 1.5, false);
      ctx.lineTo(C.BAULK_X, C.CY2);
      ctx.closePath();
      ctx.fillStyle = 'rgba(110, 210, 255, 0.10)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(150, 225, 255, 0.35)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }

    const on = (G.state === 'over') ? null : R.ballOn(publicState(), G.balls);

    if (G.state === 'aim' || G.state === 'powering' || G.state === 'dragging' || G.state === 'stroking') {
      RENDER.drawTargets(ctx, G.balls, on);
      if (G.guideMode > 0) RENDER.drawPreview(ctx, G.cueBall, getPreview(), G.aimAngle, G.guideMode);
    }

    RENDER.drawBalls(ctx, G.balls, G.cueBall, effSpin.sx, effSpin.sy, G.aimAngle, effSpin.pitchDeg);

    // 上一杆轨迹回放：停杆后 1.6 秒内淡出
    if (G.trailTime && G.trail.length && G.state !== 'moving') {
      const age = (performance.now() - G.trailTime) / 1000;
      if (age < 1.6) RENDER.drawTrail(ctx, G.trail, 0.55 * (1 - age / 1.6));
      else { G.trail = []; G.trailTime = 0; }
    }

    if (G.state === 'aim' || G.state === 'powering' || G.state === 'dragging' || G.state === 'stroking') {
      // 球杆按实际仰角画（被挡时已由 fitContact 抬到最低安全角）
      RENDER.drawCue(ctx, G.cueBall, G.aimAngle, G.power, G.state,
        effSpin.pitchDeg, G.stroke ? G.stroke.pull : 0);
    }

    // 白球脉冲
    if (G.cueBall && G.cueBall.isOnTable() &&
        (G.state === 'aim' || G.state === 'powering' || G.state === 'placing' || G.state === 'dragging')) {
      ctx.save();
      const pulse = Math.sin(Date.now() * 0.004) * 0.15 + 0.25;
      const g = ctx.createRadialGradient(G.cueBall.x, G.cueBall.y, C.BALL_R * 0.5,
        G.cueBall.x, G.cueBall.y, C.BALL_R * 3);
      g.addColorStop(0, `rgba(255,255,255,${pulse * 0.4})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(G.cueBall.x, G.cueBall.y, C.BALL_R * 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  function renderSpinPad() {
    if (!spinCtx) return;
    const human = G.players[G.currentPlayer].type === 'human';
    const eff = effectiveSpin();
    RENDER.drawSpinPad(spinCtx, spinPad.width, eff.sx, eff.sy, human,
      eff.pitchDeg, eff);
    if (dom.spinText) {
      let txt = tr(RENDER.spinText(eff.sx, eff.sy));
      if (eff.raised && eff.requiredDeg >= (SNK.cueClear ? SNK.cueClear.NOTICE_DEG : 6)) {
        txt += ' · ' + t('ui.cueRaised', { deg: Math.round(eff.pitchDeg) });
      }
      dom.spinText.textContent = txt;
    }
  }

  // ================================================================
  //  主循环
  // ================================================================
  // 物理固定 60 Hz：一“帧”物理永远是 1/60 秒，与显示器刷新率/CPU 快慢无关。
  // 旧版一帧推一步：170 Hz 屏幕上球速是 60 Hz 的 2.8 倍 —— 用户实测到了。
  const PHYS_HZ = 60;
  const PHYS_STEP_MS = 1000 / PHYS_HZ;
  const MAX_FRAME_MS = 100;         // 切标签页/断点回来时，别补跑几秒的物理
  const MAX_CATCHUP_STEPS = 8;      // 4× 速度 + 30 fps 正好 8 步
  let lastFrameMs = performance.now();
  let physAccMs = 0;

  function loop(ts) {
    const now = typeof ts === 'number' ? ts : performance.now();
    const dtMs = C.clamp(now - lastFrameMs, 0, MAX_FRAME_MS);
    lastFrameMs = now;

    // 动画速度 = 每秒多少组 60Hz 物理步。物理参数本身一步都不改。
    if (G.state === 'moving') {
      physAccMs += dtMs * G.animSpeed;
      let steps = Math.floor(physAccMs / PHYS_STEP_MS);
      if (steps > MAX_CATCHUP_STEPS) {
        steps = MAX_CATCHUP_STEPS;
        physAccMs = 0;                 // 积压太多就丢弃，宁可卡一下也不要暴走
      } else {
        physAccMs -= steps * PHYS_STEP_MS;
      }
      while (steps-- > 0 && G.state === 'moving') {
        tickPhysics();
      }
      if (G.state !== 'moving') physAccMs = 0;   // 停稳/结算，别把余量带进下一杆
    } else {
      physAccMs = 0;
    }

    // 出杆动画走真实时间（不跟 0.5×~4× 缩放）
    if (G.state === 'stroking') updateStroke(dtMs);

    // 按住方向键持续调力度（瞄准状态一直有效）。按 60Hz 的步长折算成真实时间，
    // 这样 170Hz 屏幕上不会变成 3 倍速。
    if (G.state === 'aim' && humanTurn() && G.cueBall && G.cueBall.isOnTable()) {
      const step = 0.12 * (dtMs / PHYS_STEP_MS);
      const shift = !!G.keysPressed['Shift'];
      let d = 0;
      if (!shift) {
        if (G.keysPressed['w'] || G.keysPressed['W'] || G.keysPressed['ArrowUp']) d += step;
        if (G.keysPressed['s'] || G.keysPressed['S'] || G.keysPressed['ArrowDown']) d -= step;
      }
      if (d) { G.power = C.clamp(G.power + d, 0, C.MAX_POWER); updatePowerDisplay(); }
    }

    // 后斯诺克：每帧按当前瞄准方向重算"背后有没有东西挡杆"。
    // 显示和预览用 effectiveSpin() 夹；真正的击球由 strike() 再夹一次。
    refreshCueClear();

    // 力度条：人类回合、瞄准中就显示（里面还有 "Shoot" 按钮）
    dom.powerWrap.classList.toggle('show',
      humanTurn() && (G.state === 'aim' || G.state === 'placing'));

    // 3D Orbit 里人类回合可以瞄准了：光标从"抓镜头"切成准星，
    // 但真的按住拖拽时仍由 .dragging 覆盖成 grabbing（见 CSS）。
    const orbitAim = orbitView && humanTurn() && G.state === 'aim';
    if (orbitAim !== orbitAimPrev) {
      orbitAimPrev = orbitAim;
      document.body.classList.toggle('orbit-aim', orbitAim);
    }

    render();
    renderSpinPad();
    requestAnimationFrame(loop);
  }

  function updatePowerDisplay() {
    const pct = Math.round(G.power / C.MAX_POWER * 100);
    dom.powerFill.style.width = pct + '%';
    dom.powerValue.textContent = pct + '%';
    dom.powerLabel.style.opacity = G.power >= C.MIN_POWER ? '0' : '1';
    if (dom.powerKnob) dom.powerKnob.style.left = 'calc(' + pct + '% - 6px)';
  }

  // ================================================================
  //  输入：台面
  // ================================================================
  function cpos(e) {
    const rect = canvas.getBoundingClientRect();
    const scX = canvas.width / rect.width, scY = canvas.height / rect.height;
    const cx = (e.touches ? e.touches[0].clientX : e.clientX);
    const cy = (e.touches ? e.touches[0].clientY : e.clientY);
    return { x: (cx - rect.left) * scX, y: (cy - rect.top) * scY };
  }

  function humanTurn() {
    return G.players[G.currentPlayer].type === 'human';
  }

  // ----------------------------------------------------------------
  //  后斯诺克：本杆可击球面
  // ----------------------------------------------------------------
  // 只在这几个"要出杆"的状态下算；球在动/结算时没有意义。
  function refreshCueClear() {
    G.cueClear = null;
    if (!SNK.cueClear || !G.cueBall || !G.cueBall.isOnTable()) return null;
    if (G.state !== 'aim' && G.state !== 'powering' &&
        G.state !== 'dragging' && G.state !== 'stroking') return null;
    G.cueClear = SNK.cueClear.analyze(G.balls, G.cueBall, G.aimAngle);

    // 自动抬杆：把当前击点、当前俯仰交给同一份 fitContact，算出实际仰角。
    const fit = SNK.cueClear.fitContact(G.cueClear, G.spinX, G.spinY,
      G.pitchDeg * Math.PI / 180);
    G.cueClear.fit = fit;
    G.cueClear.hardSy = SNK.cueClear.minReachableSy(G.cueClear, fit.sx);

    // 被迫抬杆且角度明显时提示一次（远处的库边 2° 不算）。
    const raised = fit.raised && fit.requiredDeg >= SNK.cueClear.NOTICE_DEG &&
      humanTurn() && !G.snookerNotice;
    const visit = (G.stats && G.stats[G.currentPlayer])
      ? (G.stats[G.currentPlayer].visits || 0) : 0;
    const key = raised
      ? G.currentPlayer + '|' + visit + '|' + (fit.kind || '')
      : '';
    if (raised && key !== G.cueBlockNotice) {
      G.cueBlockNotice = key;
      showMsg(t('msg.cueBlockedTitle'), t('msg.cueBlocked', {
        deg: Math.ceil(fit.requiredDeg),
      }), 3200);
    }
    return G.cueClear;
  }

  // 实际生效的击点/仰角。**不改 G.spinX/G.spinY 本身**——否则玩家只是
  // 把瞄准线扫过挡球，设置就会被永久顶到高杆，转开以后也回不来。
  function effectiveSpin() {
    const f = G.cueClear && G.cueClear.fit;
    if (f) {
      // 玩家主动抬杆还会带来高杆增量；盘面显示的是最终真正打到的点。
      const tip = C.effectiveTip(f.sx, f.sy, G.pitchDeg * Math.PI / 180);
      return {
        sx: tip.sx, sy: tip.sy,
        pitchDeg: f.pitchRad * 180 / Math.PI,
        requiredDeg: f.requiredDeg,
        raised: f.raised,
        clamped: f.clamped,
        hardSy: G.cueClear.hardSy,
      };
    }
    const tip = C.effectiveTip(G.spinX, G.spinY, G.pitchDeg * Math.PI / 180);
    return {
      sx: tip.sx, sy: tip.sy, pitchDeg: G.pitchDeg,
      requiredDeg: 0, raised: false,
      clamped: false, hardSy: -C.SPIN_MAX,
    };
  }

  function aimAt(px, py) {
    if (!G.cueBall || !G.cueBall.isOnTable()) return;
    const dx = px - G.cueBall.x, dy = py - G.cueBall.y;
    if (Math.hypot(dx, dy) < 6) return;
    const target = Math.atan2(dy, dx);
    let diff = C.normAngle(target - G.aimAngle);
    G.aimAngle = C.normAngle(G.aimAngle + diff * 0.15);
  }

  // ---------- 瞄准锁定 ----------
  // 玩法：鼠标移动 = 连续瞄准；点一下台面 = 把当前方向**定住**；
  // 再点一下 = 解锁，又能重新移动。走的是成熟台球游戏的"锁定/释放"，不是拖拽出杆。
  // 锁定期间鼠标怎么移都不改方向（mousemove 里挡掉），所以必须给视觉反馈 ——
  // 左上角那块 chip + 光标的形状变化，见 css 的 .aim-chip / body.aim-locked。
  // 微调（滚轮、Shift+←→）会**自动锁定**：不锁的话下一次 mousemove 会用 0.15 的插值
  // 把刚调好的角度瞬间拽回鼠标位置，微调等于白做。
  let aimChipTimer = null;

  // silent = 用户没主动锁定（出杆后复位、开局、换人），只改状态，不弹提示
  function setAimLock(on, silent) {
    if (G.aimLocked === on) return;
    G.aimLocked = on;
    document.body.classList.toggle('aim-locked', on);

    const chip = dom.aimChip;
    if (chip && silent) { chip.classList.remove('show'); return; }
    if (chip) {
      chip.textContent = on
        ? tr('Aim locked · click to move · wheel or ← → to fine-tune')
        : tr('Click the table to lock the aim');
      chip.classList.toggle('locked', on);
      chip.classList.add('show');
      if (aimChipTimer) clearTimeout(aimChipTimer);
      // 解锁后的提示只是"教一次"，1.8s 就收；锁定中则常驻（状态提示）
      aimChipTimer = setTimeout(() => {
        aimChipTimer = null;
        if (!G.aimLocked) chip.classList.remove('show');
      }, 1800);
    }
  }

  // 所有"微调方向"的入口都走这里：先锁定，再加法。
  // dir=+1 顺时针、dir=-1 逆时针（屏幕坐标 y 向下，所以 +角度 = 顺时针，看着就是往右转）。
  function nudgeAim(dir, step) {
    setAimLock(true);
    G.aimAngle = C.normAngle(G.aimAngle + dir * step);
  }

  // 拖力度条时不要顺便改瞄准方向——两个控件都压在台面上。
  let powerDragging = false;

  canvas.addEventListener('mousemove', e => {
    const p = cpos(e);
    G.mx = p.x; G.my = p.y;
    // 轨道视角下鼠标优先属于镜头，但**人类回合仍然可以瞄准**：
    // 透视机不能用屏幕坐标直接当台面坐标，改由 R3D.pickTable() 射线求交。
    // 按住拖拽时 pointermove 在转镜头，这里不抢 —— 松手后悬停即可继续瞄。
    if (orbitEnabled()) {
      if (orbitView && !orbitDrag && humanTurn() && G.state === 'aim' &&
          G.cueBall && G.cueBall.isOnTable() &&
          R3D && R3D.pickTable) {
        const q = R3D.pickTable(e.clientX, e.clientY);
        if (q) { G.mx = q.x; G.my = q.y; aimAt(q.x, q.y); }
      }
      return;
    }
    if (!humanTurn() || powerDragging) return;

    // 鼠标（含按住拖动）**只改方向**，永远不出杆。
    // 锁定期间直接跳过 —— 这就是"按下后就定住、再按一下才能继续移动"的那一半。
    if (G.state === 'aim' && G.cueBall.isOnTable() && !G.aimLocked) {
      aimAt(G.mx, G.my);
    }
    if (G.state === 'placing' && G.cueBall.isOnTable() && G.draggingCueBall) {
      const dx = G.mx - C.BAULK_X, dy = G.my - C.CY2;
      if (Math.hypot(dx, dy) <= C.DR && G.mx <= C.BAULK_X) {
        if (!C.ballOverlaps(G.balls, G.mx, G.my, G.cueBall)) {
          G.cueBall.x = G.mx; G.cueBall.y = G.my;
        }
      }
    }
  });

  canvas.addEventListener('mousedown', e => {
    if (orbitEnabled()) return;
    if (e.button !== 0 || !humanTurn()) return;
    // 瞄准中：点台面 = 锁定 / 解锁（切换），不出杆。出杆只认空格和 Shoot 按钮，
    // 免得"想定住方向"的那一下把球打出去。
    if (G.state === 'aim' && G.cueBall.isOnTable()) {
      setAimLock(!G.aimLocked);
      return;
    }
    // 摆白球：点 D 区任意位置就把球放过去，然后可以继续按住拖。
    // 旧版必须先点中球才能开始拖，开球时很容易以为"不能摆"。
    if (G.state === 'placing' && G.cueBall.isOnTable()) {
      const dx = G.mx - C.BAULK_X, dy = G.my - C.CY2;
      const inD = Math.hypot(dx, dy) <= C.DR && G.mx <= C.BAULK_X;
      const hitBall = Math.hypot(G.mx - G.cueBall.x, G.my - G.cueBall.y) <= C.BALL_R + 8;
      if (inD && !C.ballOverlaps(G.balls, G.mx, G.my, G.cueBall)) {
        G.cueBall.x = G.mx;
        G.cueBall.y = G.my;
        G.draggingCueBall = true;
      } else if (hitBall) {
        G.draggingCueBall = true;
      }
    }
  });

  canvas.addEventListener('mouseup', () => {
    if (G.state === 'placing') G.draggingCueBall = false;
  });
  // 在画布外松手也要结束拖球，否则白球会一直跟着光标
  window.addEventListener('mouseup', () => { G.draggingCueBall = false; });

  canvas.addEventListener('mouseleave', () => { /* 瞄准状态不因移出画面而改变 */ });

  // 滚轮微调方向（成熟台球游戏的标配）。第八轮把步长收细到 ≈ 0.046° / 0.011°。
  // 滚轮上 = 逆时针（往左转），下 = 顺时针。
  // 观战时的滚轮是轨道相机缩放 —— 那个监听器一开始就 `if (!orbitEnabled()) return`，
  // 而 orbitEnabled() 要求 spectate()，所以两边不会同时命中。
  canvas.addEventListener('wheel', e => {
    if (orbitEnabled()) return;          // 轨道视角的滚轮是缩放镜头
    if (!humanTurn() || G.state !== 'aim' || !G.cueBall.isOnTable()) return;
    e.preventDefault();                       // 别让页面跟着滚
    const step = e.shiftKey ? 0.0002 : 0.0008;
    nudgeAim(e.deltaY < 0 ? -1 : 1, step);
  }, { passive: false });

  // 触摸：未锁定时按下拖动 = 瞄准，**抬手即定住**（触摸没有"悬停瞄准"这东西）；
  // 已锁定时点一下 = 解锁。和鼠标是同一套语义，只是"按下/抬起"分了工。
  // touchAimed：本次触摸到底是不是在瞄准 —— 不解锁那次抬手不能再把它锁回去，
  // 否则"点一下解锁"会被同一次触摸的 touchend 立刻撤销，等于点不动。
  let touchAimed = false;

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    if (orbitEnabled() || !humanTurn()) return;
    const p = cpos(e); G.mx = p.x; G.my = p.y;
    if (G.state === 'aim' && G.cueBall.isOnTable()) {
      if (G.aimLocked) { touchAimed = false; setAimLock(false); return; }
      touchAimed = true;
      aimAt(G.mx, G.my);
    } else if (G.state === 'placing' && G.cueBall.isOnTable()) {
      const dx = G.mx - C.BAULK_X, dy = G.my - C.CY2;
      const inD = Math.hypot(dx, dy) <= C.DR && G.mx <= C.BAULK_X;
      if (inD && !C.ballOverlaps(G.balls, G.mx, G.my, G.cueBall)) {
        G.cueBall.x = G.mx;
        G.cueBall.y = G.my;
        G.draggingCueBall = true;
      }
    }
  }, { passive: false });

  canvas.addEventListener('touchend', () => {
    G.draggingCueBall = false;
    if (!touchAimed) return;
    touchAimed = false;
    if (!humanTurn()) return;
    if (G.state === 'aim' && G.cueBall.isOnTable()) setAimLock(true);
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (orbitEnabled() || !humanTurn()) return;
    const p = cpos(e); G.mx = p.x; G.my = p.y;
    if (G.state === 'aim' && G.cueBall.isOnTable() && !G.aimLocked) aimAt(G.mx, G.my);
    else if (G.state === 'placing' && G.cueBall.isOnTable() && G.draggingCueBall) {
      const dx = G.mx - C.BAULK_X, dy = G.my - C.CY2;
      if (Math.hypot(dx, dy) <= C.DR && G.mx <= C.BAULK_X &&
          !C.ballOverlaps(G.balls, G.mx, G.my, G.cueBall)) {
        G.cueBall.x = G.mx;
        G.cueBall.y = G.my;
      }
    }
  }, { passive: false });

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  // ================================================================
  //  输入：力度条（拖动改力度）+ 出杆按钮
  // ================================================================
  function setPowerFromClientX(clientX) {
    if (!dom.powerTrack) return;
    const rect = dom.powerTrack.getBoundingClientRect();
    const t = (clientX - rect.left) / Math.max(1, rect.width);
    G.power = C.clamp(t, 0, 1) * C.MAX_POWER;
    updatePowerDisplay();
  }

  if (dom.powerTrack) {
    const onDown = (e) => {
      if (!humanTurn() || G.state !== 'aim') return;
      powerDragging = true;
      setPowerFromClientX(e.touches ? e.touches[0].clientX : e.clientX);
      e.preventDefault();
    };
    dom.powerTrack.addEventListener('mousedown', onDown);
    dom.powerTrack.addEventListener('touchstart', onDown, { passive: false });
    window.addEventListener('mousemove', e => { if (powerDragging) setPowerFromClientX(e.clientX); });
    window.addEventListener('touchmove', e => {
      if (powerDragging) setPowerFromClientX(e.touches[0].clientX);
    }, { passive: true });
    window.addEventListener('mouseup', () => { powerDragging = false; });
    window.addEventListener('touchend', () => { powerDragging = false; });
  }

  if (dom.shootBtn) {
    dom.shootBtn.addEventListener('click', () => {
      if (G.state === 'placing') {
        if (isCueBallInDZ()) { G.state = 'aim'; updateHUD(); maybeScheduleAI(); }
        else showFoul('The cue ball must be inside the D');
        return;
      }
      if (canShoot()) shoot();
    });
  }

  // 方向微调按钮（← →）。单击一步；**按住连发**（成熟台球游戏的常规手感：
  // 先 350ms 延迟再每 60ms 一步，免得手一抖就过头）。
  function nudgeHold(btn, dir) {
    if (!btn) return;
    let delay = null, rep = null, lastDown = 0;
    const ready = () => humanTurn() && G.state === 'aim' && G.cueBall && G.cueBall.isOnTable();
    const stop = () => {
      if (delay) { clearTimeout(delay); delay = null; }
      if (rep) { clearInterval(rep); rep = null; }
    };
    const step = (fine) => {
      if (!ready()) return;
      nudgeAim(dir, fine ? 0.0002 : 0.0008);
    };
    // 键盘可达性：Tab 到按钮后按 Enter/Space 只会触发 click，没有 pointer 事件。
    // 而 pointerdown 那一下之后浏览器**还会**补一个 click —— 用时间戳把那个尾巴认出来，
    // 否则点一下会走两步（单击 + click 各一次）。
    btn.addEventListener('click', e => {
      if (Date.now() - lastDown < 500) return;
      step(e.shiftKey);
    });
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      lastDown = Date.now();
      step(e.shiftKey);
      delay = setTimeout(() => {
        delay = null;
        // 连发固定用中等步长：连发时还要按住 Shift 手会很别扭
        rep = setInterval(() => { if (!ready()) { stop(); return; } nudgeAim(dir, 0.0008); }, 60);
      }, 350);
    });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
  }
  nudgeHold($('aimLeftBtn'), -1);
  nudgeHold($('aimRightBtn'), 1);

  // ================================================================
  //  输入：加塞盘
  // ================================================================
  if (spinPad) {
    let dragMode = null;            // 'spin' | 'pitch'
    const PAD_BALL_R = 0.30;        // 与 render.drawSpinPad 同一套比例
    const PAD_RING_R = 0.42;
    const PAD_RING_W = 9;

    const padCoords = (e) => {
      const rect = spinPad.getBoundingClientRect();
      const px = e.touches ? e.touches[0].clientX : e.clientX;
      const py = e.touches ? e.touches[0].clientY : e.clientY;
      const size = spinPad.width;
      return {
        size, cx: size / 2, cy: size / 2,
        x: (px - rect.left) * (size / rect.width),
        y: (py - rect.top) * (size / rect.height),
      };
    };

    const canEdit = () => humanTurn() && (G.state === 'aim' || G.state === 'powering');

    const applySpin = (p) => {
      // 球面半径 r 对应 **1 个球半径**的击点偏移；但超过 0.75R 会跳球，
      // 所以有效范围是内侧的虚线圆（半径 0.75r）。
      // 以前除以 r*SPIN_MAX 又把结果夹到 ±1，等于把有效圈缩到 0.56r，
      // 盘面外侧 44% 是死区 —— 这里直接换算成物理单位。
      const r = p.size * PAD_BALL_R;
      let sx = (p.x - p.cx) / r;
      // 纵轴反号：屏幕上往上拖 = 打高杆（物理里 spinY>0 = 跟杆）
      let sy = (p.cy - p.y) / r;
      const m = Math.hypot(sx, sy);
      if (m > C.SPIN_MAX) { const k = C.SPIN_MAX / m; sx *= k; sy *= k; }
      G.spinX = sx;
      G.spinY = sy;
    };

    const applyPitch = (p) => {
      // 下半圆：左端 0°，右端 60°。角度只在 [0, π] 内有效。
      let th = Math.atan2(p.y - p.cy, p.x - p.cx);
      // 拖到上半圆（没有环）时夹到较近的一端：右端 = 60°，左端 = 0°
      if (th < 0) th = (th > -Math.PI / 2) ? 0 : Math.PI;
      const t = C.clamp(th / Math.PI, 0, 1);
      G.pitchDeg = (1 - t) * C.PITCH_MAX_DEG;
    };

    const onDown = (e) => {
      if (!canEdit()) return;
      const p = padCoords(e);
      const d = Math.hypot(p.x - p.cx, p.y - p.cy);
      const ringR = p.size * PAD_RING_R;
      // 先判外圈半环，再判球面 —— 否则点击环会瞬间把加塞甩到边缘
      if (p.y >= p.cy - 2 && Math.abs(d - ringR) <= PAD_RING_W / 2 + 6) {
        dragMode = 'pitch'; applyPitch(p);
      } else if (d <= p.size * PAD_BALL_R + 6) {
        dragMode = 'spin'; applySpin(p);
      } else {
        dragMode = null;
      }
    };
    const onMove = (e) => {
      if (!dragMode) return;
      const p = padCoords(e);
      if (dragMode === 'pitch') applyPitch(p); else applySpin(p);
    };
    const onUp = () => { dragMode = null; };

    spinPad.addEventListener('mousedown', e => { e.preventDefault(); onDown(e); });
    spinPad.addEventListener('mousemove', e => { if (dragMode) onMove(e); });
    window.addEventListener('mouseup', onUp);
    spinPad.addEventListener('touchstart', e => { e.preventDefault(); onDown(e); }, { passive: false });
    spinPad.addEventListener('touchmove', e => { e.preventDefault(); if (dragMode) onMove(e); }, { passive: false });
    spinPad.addEventListener('touchend', onUp);
    spinPad.addEventListener('contextmenu', e => e.preventDefault());
  }

  // 点 “Centre / Left …” 文字 → 加塞归中（用户要求的快捷归零）
  if (dom.spinText) {
    dom.spinText.style.cursor = 'pointer';
    dom.spinText.title = 'Click to centre the spin';
    dom.spinText.addEventListener('click', () => {
      if (!humanTurn()) return;
      G.spinX = 0; G.spinY = 0;
    });
  }

  // ================================================================
  //  输入：键盘
  // ================================================================
  document.addEventListener('keydown', e => {
    // 输入框/下拉框获得焦点时，键盘归控件（音量条、语言选择等）
    if (/^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) return;
    G.keysPressed[e.key] = true;

    const isAim = G.state === 'aim' && G.cueBall.isOnTable();
    const isPower = G.state === 'powering' && G.cueBall.isOnTable();
    const isDrag = G.state === 'dragging' && G.cueBall.isOnTable();
    const isPlacing = G.state === 'placing' && G.cueBall.isOnTable();

    // ---- 结算弹窗开着时的快捷键（优先级最高：Esc 先关弹窗）----
    if (G.summaryOpen) {
      if (e.key === 'Escape') { e.preventDefault(); if (!e.repeat) hideSummary(); return; }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); if (!e.repeat) resetGame(); return; }
    }

    // ---- 观战热键（与回合无关）----
    if (spectate()) {
      if (e.key === 'h' || e.key === 'H' || e.key === 'Escape') {
        e.preventDefault();
        if (!e.repeat) toggleUiHidden();
        return;
      }
      if (use3d && R3D && R3D.setSpectate) {
        if (e.key === 'c' || e.key === 'C') { e.preventDefault(); R3D.orbitReset(); return; }
        if (e.key === '=' || e.key === '+') { e.preventDefault(); R3D.orbitZoom(0.9); return; }
        if (e.key === '-' || e.key === '_') { e.preventDefault(); R3D.orbitZoom(1.1); return; }
        if (e.key === 'ArrowLeft') { e.preventDefault(); R3D.orbitNudge(-0.08, 0, 0); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); R3D.orbitNudge(0.08, 0, 0); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); R3D.orbitNudge(0, -0.05, 0); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); R3D.orbitNudge(0, 0.05, 0); return; }
      }
    }

    // ---- 主动 3D 轨道视角（手打也能看房间）----
    if (orbitView) {
      if (e.key === 'Escape') { e.preventDefault(); setOrbitView(false); return; }
      if (e.key === 'c' || e.key === 'C') { e.preventDefault(); R3D.orbitReset(); return; }
      if (e.key === '=' || e.key === '+') { e.preventDefault(); R3D.orbitZoom(0.9); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); R3D.orbitZoom(1.1); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); R3D.orbitNudge(-0.08, 0, 0); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); R3D.orbitNudge(0.08, 0, 0); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); R3D.orbitNudge(0, -0.05, 0); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); R3D.orbitNudge(0, 0.05, 0); return; }
    }
    if ((e.key === 'o' || e.key === 'O') && use3d && !spectate() && !e.repeat) {
      e.preventDefault();
      setOrbitView(!orbitView);
      return;
    }

    // ---- 辅助线切换（任何时候都能用，纯显示）----
    if ((e.key === 'g' || e.key === 'G') && !e.repeat) {
      e.preventDefault();
      setGuideMode((G.guideMode + 1) % 4);
      return;
    }

    // ★ 回合守卫必须放在空格分支**之前**。
    //   原来它在下面（:872 那行），于是 AI 思考中按空格会走 shoot() ——
    //   shoot() 自己没有回合守卫，会用人类残留的力度/角度替 AI 出杆，
    //   然后 AI 的排期再打一次。观战 UI 下这个 bug 会直接毁掉整局。
    if (!humanTurn()) return;

    if (e.key === ' ' || e.key === 'Space') {
      if (e.repeat) return;
      e.preventDefault();
      if (isPlacing) {
        if (isCueBallInDZ()) { G.state = 'aim'; updateHUD(); maybeScheduleAI(); }
        else showFoul('The cue ball must be inside the D');
      } else if (isDrag || isPower) shoot();
      else if (isAim) shoot();          // 空格 = 出杆（力度用 ← → 或力度条调）
      return;
    }

    // ---- 加塞：Shift + 方向键 / WASD；Q/E 仍保留为左右塞快捷键 ----
    if (isAim || isPower) {
      const s = 0.10;
      const leftKey = e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft';
      const rightKey = e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight';
      const upKey = e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp';
      const downKey = e.key === 's' || e.key === 'S' || e.key === 'ArrowDown';

      if (e.shiftKey) {
        if (leftKey) { G.spinX = C.clamp(G.spinX - s, -C.SPIN_MAX, C.SPIN_MAX); e.preventDefault(); }
        if (rightKey) { G.spinX = C.clamp(G.spinX + s, -C.SPIN_MAX, C.SPIN_MAX); e.preventDefault(); }
        if (upKey) { G.spinY = C.clamp(G.spinY + s, -C.SPIN_MAX, C.SPIN_MAX); e.preventDefault(); }
        if (downKey) { G.spinY = C.clamp(G.spinY - s, -C.SPIN_MAX, C.SPIN_MAX); e.preventDefault(); }
      }
      // Q/E 是老键位，仍然直接控制左右塞
      if (e.key === 'q' || e.key === 'Q') {
        G.spinX = C.clamp(G.spinX - s, -C.SPIN_MAX, C.SPIN_MAX); e.preventDefault();
      }
      if (e.key === 'e' || e.key === 'E') {
        G.spinX = C.clamp(G.spinX + s, -C.SPIN_MAX, C.SPIN_MAX); e.preventDefault();
      }
      if (e.key === 'x' || e.key === 'X') { G.spinX = 0; G.spinY = 0; e.preventDefault(); }
    }

    // ---- 默认键位：W/S 与 ↑/↓ 调力度；A/D 与 ←/→ 调方向 ----
    // 力度由 loop() 按按住状态连续推进；这里只阻止页面滚动，不重复加。
    if (isAim && !e.shiftKey) {
      if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp' ||
          e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') {
        e.preventDefault();
      } else if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') {
        e.preventDefault();
        nudgeAim(-1, 0.0012);
      } else if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') {
        e.preventDefault();
        nudgeAim(1, 0.0012);
      }
    }

    if (isAim && G.gameMode === 'classic' && (e.key === 'p' || e.key === 'P') && !e.repeat &&
        (G.opening || G.cueInHand)) {
      e.preventDefault();
      G.state = 'placing';
      G.draggingCueBall = false;
      setAimLock(false, true);           // 摆白球时瞄准锁定没有意义，顺手清掉
      G.cueBall.vx = 0; G.cueBall.vy = 0;
      G.cueBall.wx = 0; G.cueBall.wy = 0; G.cueBall.wz = 0;
      updateHUD();
      showMsg('Placing the cue ball', 'Drag inside the D, then press Space to confirm', 5000);
    }
  });

  document.addEventListener('keyup', e => { G.keysPressed[e.key] = false; });
  // 切走窗口时不会收到 keyup；清空按住状态，避免回来还在自动加力
  window.addEventListener('blur', () => { G.keysPressed = {}; });

  function isCueBallInDZ() {
    if (!G.cueBall) return false;
    const dx = G.cueBall.x - C.BAULK_X, dy = G.cueBall.y - C.CY2;
    return Math.hypot(dx, dy) <= C.DR && G.cueBall.x <= C.BAULK_X;
  }

  // ================================================================
  //  模式 / 对手选择
  // ================================================================
  dom.modeSelect.addEventListener('change', () => {
    const val = dom.modeSelect.value;
    if (val === 'restart') {
      resetGame();
      dom.modeSelect.value = G.gameMode;
      return;
    }
    // 池球和斯诺克台面几何不同，切换时重新加载页面让 constants.js
    // 按对应官方尺寸初始化，而不是在运行时硬改所有常量。
    if (val === 'eightball' || val === 'nineball' || C.IS_POOL_TABLE) {
      window.location.search = '?mode=' + encodeURIComponent(val);
      return;
    }
    G.gameMode = val;
    resetGame();
  });

  // ---- 两个座位：各自独立选 Human / 任意一档 AI ----
  // 单一数据源：选项列表由 SNK.ai.LEVELS 生成，新增画像不用改 HTML。
  const SEAT_OPTIONS = [['human', 'Human']].concat(
    Object.keys(C.ai.LEVELS).map(k => [k, C.ai.LEVELS[k].name || k])
  );

  function fillSeatSelect(sel) {
    if (!sel) return;
    sel.innerHTML = '';
    for (const [val, text] of SEAT_OPTIONS) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = text;
      sel.appendChild(o);
    }
  }
  fillSeatSelect(dom.seatASelect);
  fillSeatSelect(dom.seatBSelect);

  function seatVal(sel, fallback) {
    return (sel && sel.value) ? sel.value : fallback;
  }

  // 把一个下拉的取值变成球员对象；level 对 Human 无意义但保留字段
  function makePlayer(val) {
    return val === 'human'
      ? { type: 'human', level: 'master' }
      : { type: 'ai', level: val };
  }

  let seatSync = false;                  // 防止两个下拉互相触发死循环
  function applySeats() {
    if (seatSync) return;
    seatSync = true;
    G.players[0] = makePlayer(seatVal(dom.seatASelect, 'human'));
    G.players[1] = makePlayer(seatVal(dom.seatBSelect, 'master'));
    // aiVs 退化成派生缓存：既有的 `G.aiVs !== 'off'` 守卫全部继续有效
    G.aiVs = bothAI() ? 'on' : 'off';
    if (dom.seatASelect) dom.seatASelect.value = G.players[0].type === 'human' ? 'human' : G.players[0].level;
    if (dom.seatBSelect) dom.seatBSelect.value = G.players[1].type === 'human' ? 'human' : G.players[1].level;
    if (G.aiVs === 'off') G.paused = false;
    if (SNK.bgm) SNK.bgm.duck(G.paused);     // 换座位一律解除降音

    G.aiToken++;
    G.aiThinking = false;
    G.pendingKind = '';
    clearTimeout(G.restartTimer);
    G.restartTimer = null;

    applySpectateMode();
    updatePauseBtn();
    seatSync = false;
    resetGame();
  }

  if (dom.seatASelect) dom.seatASelect.addEventListener('change', applySeats);
  if (dom.seatBSelect) dom.seatBSelect.addEventListener('change', applySeats);

  function updatePauseBtn() {
    if (!dom.pauseBtn) return;
    dom.pauseBtn.style.display = G.aiVs === 'off' ? 'none' : '';
    dom.pauseBtn.textContent = G.paused ? t('ui.resume') : t('ui.pause');
  }

  // ---- 观战模式：切透视轨道相机 + 提示条 + 光标 ----
  function applySpectateMode() {
    const on = spectate();
    document.body.classList.toggle('spectating', on);
    if (on) {
      if (use3d && R3D && R3D.setSpectate) R3D.setSpectate(true);
      showSpectateHint();
    } else {
      document.body.classList.remove('ui-hidden');
      if (R3D && R3D.setSpectate) R3D.setSpectate(false);
      if (dom.spectateHint) dom.spectateHint.classList.remove('show');
    }
    // 观战自己管镜头；切进/切出观战时把主动轨道状态清掉，免得两套状态打架
    orbitView = false;
    document.body.classList.remove('orbit-view');
    refreshOrbitBtn();
  }

  // ================================================================
  //  存档 / 读档
  //
  //  只在“球停稳、等出杆”时快照，所以不用保存计时器、出杆动画和本杆事件。
  //  自动档每杆结算后写一次；手动槽位和导入导出都在控制条的 Saves 子菜单里。
  // ================================================================
  const SAVE_SLOT_NAMES = { auto: 'Auto', slot1: 'Slot 1', slot2: 'Slot 2', slot3: 'Slot 3' };
  function slotName(slot) {
    if (slot === 'auto') return t('save.auto');
    return t('save.slot', { n: String(slot).replace(/\D/g, '') });
  }

  function canSnapshot() {
    return G.state === 'aim' && !!G.cueBall;
  }

  function fmtSaveTime(ts) {
    if (!ts) return t('save.empty');
    const d = new Date(ts);
    const p = n => (n < 10 ? '0' + n : String(n));
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function setSaveNote(text, kind) {
    if (!dom.saveMenuNote) return;
    dom.saveMenuNote.textContent = text || '';
    dom.saveMenuNote.className = 'save-menu-note' + (kind ? ' ' + kind : '');
  }

  function renderSaveSlots() {
    if (!dom.saveSlots) return;
    dom.saveSlots.innerHTML = '';
    const allowSave = canSnapshot();

    for (const slot of C.save.SLOTS) {
      const info = C.save.slotInfo(slot);
      const row = document.createElement('div');
      row.className = 'save-slot';

      const label = document.createElement('div');
      const name = document.createElement('span');
      name.className = 'save-slot-name';
      name.textContent = slotName(slot);
      const time = document.createElement('span');
      time.className = 'save-slot-time';
      time.textContent = info.empty ? t('save.empty') : fmtSaveTime(info.savedAt);
      label.appendChild(name);
      label.appendChild(time);
      row.appendChild(label);

      // Auto 档只读：它由每杆结算自动写入，避免玩家手滑覆盖回退点。
      if (slot !== 'auto') {
        const saveBtn = document.createElement('button');
        saveBtn.className = 'save-slot-btn';
        saveBtn.textContent = t('save.save');
        saveBtn.disabled = !allowSave;
        saveBtn.title = allowSave ? t('save.saveTo', { slot: slotName(slot) }) : t('save.wait');
        saveBtn.addEventListener('click', () => {
          const res = C.save.write(slot, C.save.serialize(G));
          if (res.ok) {
            setSaveNote(t('save.savedTo', { slot: slotName(slot) }), 'ok');
            renderSaveSlots();
          } else {
            setSaveNote('Save failed: ' + res.error, 'err');
          }
        });
        row.appendChild(saveBtn);
      }

      const loadBtn = document.createElement('button');
      loadBtn.className = 'save-slot-btn';
      loadBtn.textContent = t('save.load');
      loadBtn.disabled = info.empty;
      loadBtn.title = info.empty ? 'Empty slot' : 'Load this game';
      loadBtn.addEventListener('click', () => loadSlot(slot));
      row.appendChild(loadBtn);

      dom.saveSlots.appendChild(row);
    }
  }

  function setSaveMenu(open) {
    if (!dom.saveMenu) return;
    dom.saveMenu.hidden = !open;
    if (dom.saveMenuBtn) dom.saveMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      setSaveNote('');
      renderSaveSlots();
    }
  }

  function autoSaveGame() {
    if (G.tutorial) return;
    if (!autoSaveEnabled || !canSnapshot() || G.summaryOpen) return;
    C.save.write('auto', C.save.serialize(G));
  }

  // 读档：先把所有异步排期作废，再整体替换状态。
  function restoreGame(data, label) {
    let s;
    try {
      s = C.save.deserialize(data);
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'Bad save' };
    }
    const savedPool = (s.mode === 'eightball' || s.mode === 'nineball');
    if (savedPool !== C.IS_POOL_TABLE ||
        (savedPool && s.mode !== C.TABLE_MODE)) {
      return { ok: false, error: 'Switch to ' + s.mode + ' table first' };
    }

    G.aiToken++;                       // 作废旧 AI 的 setTimeout
    G.aiThinking = false;
    clearTimeout(G.restartTimer);
    G.restartTimer = null;
    G.stroke = null;
    G.paused = false;
    if (SNK.bgm) SNK.bgm.duck(false);

    G.balls = s.balls;
    G.cueBall = s.cueBall;
    G.gameMode = s.mode;
    // 提示状态不能跟着上一局残留
    G.breakMilestone = 0;
    G.maxOnNoticed = false;
    G.snookerReqNotice = '';
    G.snookerNotice = '';
    G.players = s.players;
    G.currentPlayer = s.currentPlayer;
    G.scores = s.scores;
    G.breaks = s.breaks;
    G.highBreak = s.highBreak;
    G.needRed = s.needRed;
    G.pottedRedThisTurn = s.pottedRedThisTurn;
    G.isRespottedBlack = s.isRespottedBlack;
    G.opening = s.opening;
    G.cueInHand = !!s.cueInHand;
    G.negativeStreak = s.negativeStreak || 0;
    G.negativeNotice = 0;
    G.noPotStreak = (s.noPotStreak || [0, 0]).slice(0, 2);
    G.forceNotice = [0, 0];
    G.shotStartCue = null;
    G.poolOpen = s.poolOpen !== false;
    G.poolGroups = (s.poolGroups || [null, null]).slice();
    G.aimAngle = s.aimAngle;
    G.power = s.power;
    G.spinX = s.spinX;
    G.spinY = s.spinY;
    G.pitchDeg = s.pitchDeg;
    G.stats = s.stats;

    G.state = 'aim';
    G.pendingKind = '';
    G.lastReason = '';
    G.draggingCueBall = false;
    G.trail = [];
    G.trailTime = 0;
    G.ballsVersion++;
    previewCache = null;
    previewKey = '';
    physAccMs = 0;
    live.potted = []; live.firstContact = null; live.firstContactBall = null;
    live.pottedByLabel = {};
    live.kind = ''; live.onLabel = null;

    if (dom.modeSelect) dom.modeSelect.value = G.gameMode;
    dom.powerWrap.classList.remove('show');
    hideSummary();
    clearMsgPanel();
    setGuideMode(s.guideMode || 0);
    syncSeatUi();
    setAimLock(false, true);
    setOrbitView(false);
    if (R3D && R3D.resetView) R3D.resetView();
    updatePowerDisplay();
    updateHUD();
    showMsg('Game loaded', label || 'Saved game', 2400);
    maybeScheduleAI();
    return { ok: true };
  }

  function loadSlot(slot) {
    const data = C.save.read(slot);
    if (!data) {
      setSaveNote('That slot is empty or unreadable', 'err');
      return;
    }
    const res = restoreGame(data, slotName(slot) + ' · ' + fmtSaveTime(data.savedAt));
    if (res.ok) setSaveMenu(false);
    else setSaveNote('Load failed: ' + res.error, 'err');
  }

  function syncSeatUi() {
    if (dom.seatASelect) {
      dom.seatASelect.value = G.players[0].type === 'human' ? 'human' : G.players[0].level;
    }
    if (dom.seatBSelect) {
      dom.seatBSelect.value = G.players[1].type === 'human' ? 'human' : G.players[1].level;
    }
    G.aiVs = bothAI() ? 'on' : 'off';
    if (G.aiVs === 'off') G.paused = false;
    applySpectateMode();
    updatePauseBtn();
  }

  function exportSave() {
    if (!canSnapshot()) {
      setSaveNote('Wait for the balls to stop before exporting', 'err');
      return;
    }
    const data = C.save.serialize(G);
    const text = JSON.stringify(data, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const p = n => (n < 10 ? '0' + n : String(n));
    a.href = url;
    a.download = 'snooker-save-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    setSaveNote('Exported ' + a.download, 'ok');
  }

  function importSave(file) {
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setSaveNote('Save file is too large', 'err');
      return;
    }
    file.text().then(text => {
      let data;
      try { data = JSON.parse(text); }
      catch (e) { setSaveNote('Not valid JSON', 'err'); return; }
      const res = restoreGame(data, 'Imported · ' + file.name);
      if (res.ok) setSaveMenu(false);
      else setSaveNote('Import failed: ' + res.error, 'err');
    }).catch(() => setSaveNote('Could not read the file', 'err'));
  }

  if (dom.saveMenuBtn) {
    dom.saveMenuBtn.setAttribute('aria-expanded', 'false');
    dom.saveMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setSaveMenu(dom.saveMenu.hidden);
    });
  }
  if (dom.exportSaveBtn) dom.exportSaveBtn.addEventListener('click', exportSave);
  if (dom.importSaveBtn) dom.importSaveBtn.addEventListener('click', () => {
    if (dom.importSaveFile) dom.importSaveFile.click();
  });
  if (dom.importSaveFile) {
    dom.importSaveFile.addEventListener('change', () => {
      const f = dom.importSaveFile.files && dom.importSaveFile.files[0];
      importSave(f);
      dom.importSaveFile.value = '';
    });
  }
  document.addEventListener('click', (e) => {
    if (!dom.saveMenu || dom.saveMenu.hidden) return;
    if (dom.saveMenuWrap && !dom.saveMenuWrap.contains(e.target)) setSaveMenu(false);
  });
  // 捕获阶段先关菜单：Esc 在游戏里还负责退出 3D Orbit，不该一次按两件事。
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dom.saveMenu && !dom.saveMenu.hidden) {
      e.stopPropagation();
      setSaveMenu(false);
    }
  }, true);

  let hintTimer = null;
  function showSpectateHint() {
    const el = dom.spectateHint;
    if (!el) return;
    const txt = use3d
      ? 'Idle a minute and the camera takes over · Drag to orbit · Wheel to zoom · C for the top view · H to hide the UI'
      : 'Spectating (2D view) · H to hide the UI';
    el.textContent = tr(txt);
    el.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => el.classList.remove('show'), 4200);
  }

  // H / Esc 切换"隐藏全部 UI"。
  // .spectate-hint 故意不在隐藏名单里（见 CSS），否则按完 H 就没人知道怎么操作了。
  function toggleUiHidden() {
    const hidden = document.body.classList.toggle('ui-hidden');
    if (!hidden) showSpectateHint();
    scheduleFit();           // 台面槽位从四行网格变成整屏，重新等比适配
  }

  // ---- 2D / 3D 视角切换 ----
  function viewBtnText() {
    return use3d ? t('ui.view2d') : t('ui.view3d');
  }

  // ---- 主动 3D 轨道视角（第九轮）----
  // 默认的 3D 是"正上方正交俯视"，看起来仍像 2D；这个按钮把人送进斜视透视图，
  // 手打时也能看房间/家具/球的立体感。轨道视角下鼠标归镜头，瞄准先回俯视。
  function orbitBtnText() {
    return orbitView ? t('ui.topView') : t('ui.orbit');
  }

  function refreshOrbitBtn() {
    if (!dom.orbitBtn) return;
    const show = use3d && !spectate() && R3D && R3D.available();
    dom.orbitBtn.style.display = show ? '' : 'none';
    dom.orbitBtn.textContent = orbitBtnText();
  }

  function setOrbitView(on) {
    on = !!on && use3d && R3D && R3D.on;
    orbitView = on;
    if (R3D && R3D.setOrbit) R3D.setOrbit(on);
    document.body.classList.toggle('orbit-view', on);
    if (dom.orbitBtn) dom.orbitBtn.textContent = orbitBtnText();
    if (on) {
      // 轨道视角里没有"点台面锁定"这个动作（左键要留给镜头拖拽），
      // 所以进来先解锁，悬停即瞄准；出去后维持正常锁定逻辑。
      setAimLock(false, true);
      showMsg('Orbit view', 'Move mouse to aim · drag to look around · wheel zoom · Space/Shoot to play · C reset · Esc top view', 4200);
    }
  }

  function toggle3d() {
    if (!canvas3d || !R3D || !R3D.available()) {
      showMsg('3D unavailable', 'three.js not found, or this browser has no WebGL', 2600);
      return;
    }
    if (!use3d && !R3D.on) {
      try { R3D.init(canvas3d); R3D.on = true; }
      catch (e) { console.warn('3D 初始化失败', e); return; }
    }
    use3d = !use3d;
    R3D.on = use3d;
    canvas3d.style.display = use3d ? '' : 'none';
    if (dom.viewBtn) dom.viewBtn.textContent = viewBtnText();
    if (!use3d) {
      setOrbitView(false);                          // 2D 下没有镜头可转
      if (R3D.resetView) R3D.resetView();
    }
    refreshAmbienceUI();
    applySpectateMode();     // 观战中切视角：重挂/摘掉轨道相机
    refreshOrbitBtn();
    scheduleFit();           // 画布显示切换后重新按槽位等比适配
  }

  dom.speedSelect.addEventListener('change', () => {
    G.aiSpeed = Number(dom.speedSelect.value) || 1;
    G.animSpeed = G.aiSpeed;      // 球速与节奏一起变，不然 4× 时球还是慢的
    G.aiToken++;                  // 打断当前这一杆的延时链，按新速度重排
    G.aiThinking = false;
    G.pendingKind = '';
    maybeScheduleAI();
  });

  dom.pauseBtn.addEventListener('click', () => {
    if (G.aiVs === 'off') return;
    G.paused = !G.paused;
    updatePauseBtn();
    if (SNK.bgm) SNK.bgm.duck(G.paused);     // 暂停：音乐压低、音效静掉
    if (G.paused) {
      G.aiToken++;                // 作废已排队的出杆
      G.aiThinking = false;
      G.pendingKind = '';
      clearTimeout(G.restartTimer);
      updateHUD();
    } else {
      maybeScheduleAI();
    }
  });

  // ---- 结算弹窗按钮 ----
  if (dom.sumRematch) dom.sumRematch.addEventListener('click', () => resetGame());
  if (dom.sumClose) dom.sumClose.addEventListener('click', () => hideSummary());

  // ---- 教学：菜单 / 目标条 / 结果 ----
  if (dom.tutorialBtn) dom.tutorialBtn.addEventListener('click', openTutorialMenu);
  if (dom.tutClose) dom.tutClose.addEventListener('click', closeTutorialMenu);
  if (dom.tutRetry) dom.tutRetry.addEventListener('click', retryTutorialStep);
  if (dom.tutMenuBtn) dom.tutMenuBtn.addEventListener('click', openTutorialMenu);
  if (dom.tutExitBtn) dom.tutExitBtn.addEventListener('click', exitTutorial);
  if (dom.tutRetryBtn) dom.tutRetryBtn.addEventListener('click', retryTutorialStep);
  if (dom.tutNextBtn) dom.tutNextBtn.addEventListener('click', nextTutorialLesson);
  if (dom.tutLessonsBtn) dom.tutLessonsBtn.addEventListener('click', () => {
    clearTutorialResult();
    openTutorialMenu();
  });

  // ================================================================
  //  观战镜头手势（全部挂在 #gc 上；非观战时一律直接 return）
  //  #gc 上现有的 mousemove/mousedown 都以 humanTurn() 开头，
  //  而观战时双方都是 AI → humanTurn() 恒为 false，所以两套手势不会打架。
  // ================================================================
  let orbitDrag = false, orbitPanning = false, orbitLX = 0, orbitLY = 0;

  // 自由镜头：观战自动开，人类回合由 3D Orbit 按钮主动开。
  // 第十轮起，主动轨道视角下人类**也能瞄准**：透视机不能用屏幕坐标直当台面坐标，
  // 改走 R3D.pickTable() 的射线-台面求交；拖拽仍是转镜头，悬停即瞄准。
  // 观战的镜头输入照旧不碰球杆 —— 那边没有"人类回合"。
  function orbitEnabled() {
    return !!use3d && (spectate() || orbitView);
  }

  if (canvas && R3D) {
    canvas.addEventListener('wheel', e => {
      if (!orbitEnabled()) return;
      e.preventDefault();
      R3D.orbitZoom(e.deltaY > 0 ? 1.08 : 0.93);
    }, { passive: false });

    canvas.addEventListener('pointerdown', e => {
      if (!orbitEnabled()) return;
      orbitDrag = true;
      orbitPanning = (e.button === 2) || e.shiftKey;
      orbitLX = e.clientX; orbitLY = e.clientY;
      document.body.classList.add('dragging');
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 不支持就算了 */ }
    });

    canvas.addEventListener('pointermove', e => {
      if (!orbitDrag) return;
      const dx = (e.movementX || (e.clientX - orbitLX));
      const dy = (e.movementY || (e.clientY - orbitLY));
      orbitLX = e.clientX; orbitLY = e.clientY;
      if (orbitPanning) R3D.orbitPan(dx, dy);
      else R3D.orbitDrag(dx, dy);
    });

    const orbitEnd = (e) => {
      if (!orbitDrag) return;
      orbitDrag = false;
      document.body.classList.remove('dragging');
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* 同上 */ }
    };
    canvas.addEventListener('pointerup', orbitEnd);
    canvas.addEventListener('pointercancel', orbitEnd);
  }

  // ================================================================
  //  声音：开关 / 音量（首次用户操作前，浏览器不允许出声）
  // ================================================================
  function refreshSoundUI() {
    if (!dom.soundBtn || !SNK.bgm) return;
    const on = SNK.bgm.enabled();
    const audible = SNK.bgm.audible();
    dom.soundBtn.textContent = on
      ? (audible ? t('ui.soundOn') : t('ui.soundClick'))
      : t('ui.soundOff');
    dom.soundBtn.classList.toggle('on', on);
    if (dom.volRange) dom.volRange.value = String(SNK.bgm.volume());
  }

  if (dom.soundBtn && SNK.bgm) {
    dom.soundBtn.addEventListener('click', () => {
      // 开关已经是"开"、但浏览器还没解锁音频时（页面刚打开、尚未有用户手势），
      // 这一下应该用来 resume()，而不是把声音关掉。
      if (SNK.bgm.enabled() && !SNK.bgm.unlocked()) {
        SNK.bgm.resume();
      } else {
        SNK.bgm.setEnabled(!SNK.bgm.enabled());
        SNK.bgm.resume();
      }
      refreshSoundUI();
    });
    if (dom.volRange) {
      dom.volRange.addEventListener('input', () => {
        SNK.bgm.setVolume(Number(dom.volRange.value));
      });
    }
    SNK.bgm.onchange(refreshSoundUI);
    // 浏览器的自动播放策略：AudioContext 必须在一次真实用户操作里 resume()。
    // 挂一次性监听，第一次点/按键就把音乐接上（如果开关是开的）。
    const arm = () => {
      SNK.bgm.resume();
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
      setTimeout(refreshSoundUI, 120);
    };
    window.addEventListener('pointerdown', arm);
    window.addEventListener('keydown', arm);
    refreshSoundUI();
  }

  // ================================================================
  //  光照氛围：下拉切换（Match / Day / Evening / Night）
  //  选项文案写死在 index.html，但**当前值**从 render3d 读回来 ——
  //  它自己会从 localStorage 恢复上次选的，这里只负责让下拉显示一致。
  // ================================================================
  function refreshAmbienceUI() {
    if (!dom.ambienceSelect) return;
    dom.ambienceSelect.disabled = !use3d;
    dom.ambienceSelect.style.opacity = use3d ? '' : '0.35';
  }

  if (dom.ambienceSelect && R3D && R3D.setAmbience) {
    dom.ambienceSelect.value = R3D.ambience ? R3D.ambience() : 'match';
    dom.ambienceSelect.addEventListener('change', () => {
      R3D.setAmbience(dom.ambienceSelect.value);
    });
    if (R3D.onAmbience) R3D.onAmbience((name) => { dom.ambienceSelect.value = name; });
    refreshAmbienceUI();
  }

  // ================================================================
  //  辅助线模式：0 全无 / 1 只有母球 / 2 母球+第一颗碰到的球 / 3 所有动的球
  //  下拉与 G 键同步；选择写进 localStorage。
  // ================================================================
  function setGuideMode(mode) {
    G.guideMode = C.clamp(mode | 0, 0, 3);
    try { localStorage.setItem('snk.guide', String(G.guideMode)); } catch (_) {}
    if (dom.guideSelect) dom.guideSelect.value = String(G.guideMode);
  }

  if (dom.guideSelect) {
    let saved = 2;
    try {
      const v = localStorage.getItem('snk.guide');
      if (v !== null) saved = C.clamp(parseInt(v, 10) || 0, 0, 3);
    } catch (_) {}
    setGuideMode(saved);
    dom.guideSelect.addEventListener('change', () => {
      setGuideMode(parseInt(dom.guideSelect.value, 10) || 0);
    });
  }

  // ================================================================
  //  观战闲置检测：有人操作就把"自动巡游"推后
  //  只推迟、不改机位 —— 观战本来就不需要用户操作，太敏感会让巡游永远不启动。
  //  （真正"接管镜头"是拖拽/滚轮/方向键，那些走 R3D 的 orbit* 接口。）
  // ================================================================
  (function () {
    const bump = () => {
      if (use3d && spectate() && R3D && R3D.notifyActivity) R3D.notifyActivity();
    };
    window.addEventListener('pointermove', bump, { passive: true });
    window.addEventListener('pointerdown', bump, { passive: true });
    window.addEventListener('wheel', bump, { passive: true });
    window.addEventListener('keydown', bump);
  })();

  // ================================================================
  //  启动
  // ================================================================
  // ================================================================
  //  语言切换
  // ================================================================
  function setOptions(sel, map) {
    if (!sel) return;
    for (const opt of sel.options) {
      if (map[opt.value]) opt.textContent = map[opt.value];
    }
  }

  function applyLanguage() {
    if (!I) return;
    if (dom.langSelect) dom.langSelect.value = I.lang;
    if (dom.breakWord) dom.breakWord.textContent = t('ui.break');
    if (dom.pauseBtn) dom.pauseBtn.textContent = G.paused ? t('ui.resume') : t('ui.pause');
    if (dom.saveMenuBtn) dom.saveMenuBtn.innerHTML = t('ui.saves') + ' &#9662;';
    const restart = $('restartBtn');
    if (restart) restart.textContent = t('ui.restart');
    if (dom.viewBtn) dom.viewBtn.textContent = viewBtnText();
    if (dom.orbitBtn) dom.orbitBtn.textContent = orbitBtnText();
    if (dom.powerLabel) dom.powerLabel.textContent = t('ui.powerDrag');
    const spinTitle = document.querySelector('.spin-title');
    if (spinTitle) spinTitle.textContent = t('ui.spinTitle');
    const spinHint = document.querySelector('.spin-hint');
    if (spinHint) spinHint.innerHTML = t('ui.spinHint').replace(/\n/g, '<br>');
    if (dom.volRange) dom.volRange.title = t('ui.volume');
    if (dom.sumRematch) dom.sumRematch.textContent = t('summary.rematch');
    if (dom.sumClose) dom.sumClose.textContent = t('summary.close');
    if (dom.tutorialBtn) dom.tutorialBtn.textContent = t('ui.tutorial');
    if (dom.tutorialOverlay && !dom.tutorialOverlay.hidden) renderTutorialGrid();
    updateTutorialHud();
    const saveTitle = document.querySelector('.save-menu-title');
    if (saveTitle) saveTitle.textContent = t('save.title');
    if (dom.exportSaveBtn) dom.exportSaveBtn.textContent = t('save.export');
    if (dom.importSaveBtn) dom.importSaveBtn.textContent = t('save.import');

    setOptions($('modeSelect'), {
      restart: t('mode.restart'), classic: t('mode.classic'),
      eightball: t('mode.eight'), nineball: t('mode.nine'),
      clearance: t('mode.clearance'), respottedBlack: t('mode.respotted'),
    });
    setOptions($('speedSelect'), {
      '0.5': t('speed.slow'), '1': t('speed.normal'),
      '2': t('speed.fast'), '4': t('speed.turbo'),
    });
    setOptions($('ambienceSelect'), {
      auto: t('amb.auto'), match: t('amb.match'), day: t('amb.day'),
      evening: t('amb.evening'), night: t('amb.night'),
    });
    setOptions($('guideSelect'), {
      0: t('guide.off'), 1: t('guide.cue'), 2: t('guide.first'), 3: t('guide.all'),
    });
    for (const sel of [dom.seatASelect, dom.seatBSelect]) {
      if (!sel) continue;
      const op = sel.querySelector('option[value="human"]');
      if (op) op.textContent = t('ui.human');
    }

    if (dom.statusPrev) dom.statusPrev.textContent = '';
    updateHUD();
    updateBallCount();
    refreshSoundUI();
    refreshOrbitBtn();
    renderSpinPad();
  }

  if (dom.langSelect) {
    dom.langSelect.addEventListener('change', () => {
      if (!I) return;
      I.setLang(dom.langSelect.value);
      applyLanguage();
      dom.langSelect.blur();
      showMsg('Language / 语言', I.lang === 'zh' ? '界面已切换为中文' : 'Interface switched to English', 1800);
    });
  }

  window.SNK.game = {
    G: G,
    resetGame: resetGame,
    publicState: publicState,
    showMsg: showMsg,
    toggle3d: toggle3d,
    is3d: function () { return use3d; },
    spectate: spectate,
    toggleUiHidden: toggleUiHidden,
    showSummary: showSummary,
    // 调试/测试入口：直接让某个座位说一句，不参与正式逻辑
    chat: function (seat, category, ctx) { return say(seat, category, ctx); },
  };

  // 起始座位：座位 1 = Human，座位 2 = 大师 147（跟改版前一致）
  if (dom.seatASelect) dom.seatASelect.value = 'human';
  if (dom.seatBSelect) dom.seatBSelect.value = 'master';
  applySeats();
  applyLanguage();

  if (dom.viewBtn) {
    dom.viewBtn.textContent = viewBtnText();
    if (!R3D || !R3D.available()) dom.viewBtn.style.display = 'none';
  }
  if (dom.orbitBtn) {
    dom.orbitBtn.addEventListener('click', () => setOrbitView(!orbitView));
  }
  refreshOrbitBtn();
  if (canvas3d && !use3d) canvas3d.style.display = 'none';
  if (dom.modeSelect) dom.modeSelect.value = G.gameMode;

  resetGame();
  // 启动期的两次 resetGame 已经跑完，从这里开始才允许写 auto 档。
  autoSaveEnabled = true;
  autoSaveGame();
  loop();

  // 从 8/9 球模式点教程时自动切回斯诺克并直接打开课程菜单
  if (location.search.indexOf('tutorial=1') >= 0) {
    setTimeout(openTutorialMenu, 350);
  }

  // 注意：selftest.js 在本文件之后加载，所以判断必须放进回调里再查一次
  if (location.search.indexOf('selftest') >= 0) {
    setTimeout(() => {
      if (C.selftest && C.selftest.run) C.selftest.run();
    }, 200);
  }
})(window.SNK = window.SNK || {});
