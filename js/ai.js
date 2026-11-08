// ================================================================
//  ai.js — AI 对手
//
//  核心思想：AI 不做任何"近似估计"。它枚举候选杆法，用 sim.js 把
//  每一杆**真跑一遍物理**，再用 rules.js 的裁判函数判定结果。
//  因为物理和规则都只有一份实现，AI 说"这杆能进"就是真的能进。
//
//  正是这一点让「大师·147」成立：
//    · 每一杆都经过模拟验证才出手 → 不失误
//    · 出手前递归检查"下一杆还有没有解" → 不会进一颗就断
//    · 真的无解（几何上不可能）→ 转入斯诺克搜索，做对手最难解的球
//
//  难度档位：easy / medium / hard / master
// ================================================================
(function (SNK) {
  'use strict';

  const C = SNK;
  const R = C.rules;
  const S = C.sim;

  // ================================================================
  //  时钟：可以切换成「虚拟时钟」
  //
  //  正式游戏用 performance.now()：预算是毫秒，保证界面不卡。
  //  但这个预算有个要命的副作用 —— **同一局面两次跑出的决策不一样**：
  //  机器忙一点，搜索就早停一点，选的杆就变了。于是每次 A/B 都要重测，
  //  而且同一个 AI 在慢机器上会明显变弱。
  //
  //  测试时切成虚拟时钟：每真模拟一杆 +1，预算的含义从"毫秒"变成"模拟杆数"。
  //  好处：
  //    · 完全可复现（同局面 → 同决策），A/B 一次就是一次；
  //    · 预算是工作量而不是机器速度，跑多快结果都一致；
  //    · 想跑多细由 ticks 说了算，不用为了省时间牺牲搜索质量。
  //  代码里 10 处 now() > cfg.deadline 一行都不用改。
  // ================================================================
  let clockVirtual = false;
  let clockTicks = 0;
  const now = () => (clockVirtual ? clockTicks
    : (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  function tick(n) { clockTicks += (n === undefined ? 1 : n); }
  function setVirtualClock(on, start) {
    clockVirtual = !!on;
    clockTicks = start || 0;
  }

  // ================================================================
  //  基础几何
  // ================================================================
  function findCue(balls) {
    for (let i = 0; i < balls.length; i++) if (balls[i].label === 'white') return balls[i];
    return null;
  }

  // 白球到任意合法目标有没有干净直线
  function hasDirectLine(state, balls) {
    const cue = findCue(balls);
    if (!cue || !cue.isOnTable()) return false;
    const targets = R.legalTargets(state, balls);
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!C.pathBlocked(balls, cue.x, cue.y, t.x, t.y, cue, t, 0)) return true;
    }
    return false;
  }

  function angBetween(ax, ay, bx, by) {
    let c = ax * bx + ay * by;
    if (c > 1) c = 1; else if (c < -1) c = -1;
    return Math.acos(c);
  }

  // 行程模型必须与 physics.js 严格一致：击球后先滑动、再纯滚动。
  // C.speedForDistance(dist, vEnd) 是那条 d(v0, vEnd) 曲线的反函数。
  // 旧版按纯滚动 sqrt(2·a·d) 估算，会把初速低估 10~15%，
  // AI 以为力度够了，球却停在袋口前 —— 物理换模型后必须同步。
  function speedFor(dist) {
    return C.speedForDistance(dist, 0);
  }

  // 让白球走到接触点、并让目标球走到袋口，需要多大力度
  function estimatePower(dist, pocketDist, cutRad) {
    const arrive = 1.6;                     // 目标球到袋口时还剩的速度
    const cosCut = Math.max(0.22, Math.cos(cutRad));
    const vAtContact = (speedFor(pocketDist) + arrive) / (C.BALL_RESTITUTION * cosCut);
    // 白球要"走完 dist"**并且**"到那儿时还带着 vAtContact 的速度"。
    // 恒定减速度下两段是速度平方相加；滑动段同理，只是系数不同。
    const v0 = C.speedForDistance(dist, vAtContact);
    return C.clamp(v0, 1.5, C.MAX_POWER);
  }

  const MAX_CUT = 1.36;   // 78°，再薄就打不动了
  // 瞄准线路要求的额外间隙（px）。不许"擦着别的球过去"。
  const AIM_CLEAR = C.BALL_R * 0.4;      // 4px

  // ----------------------------------------------------------------
  //  出杆容错（comfort）
  //
  //  实测出来的问题：原来的估值只认 v.points，于是 AI 会去捡那些
  //  "角度容差只有 0.35px" 的极限薄球——模拟里它确实进，但真人（和有
  //  误差的画像）根本打不出来。量到的结果是进攻成功率只有 38%，
  //  跟"职业球员"完全不搭。
  //
  //  真实球员的选球常识是：先挑舒服的球打。舒服 = 切角小 + 离袋近。
  //  所以把这两个量折算成一个 0~1.2 的容错分加进估值。
  //  注意这是**选球**的偏好，不是把球打进去的能力：
  //  准度无限的大师（noise=0）不需要它，comfortW 给 0 即可。
  // ----------------------------------------------------------------
  function comfortOf(cand) {
    const cutT = Math.max(0, 1 - cand.cut / MAX_CUT);                 // 1 = 正球，0 = 极限薄球
    const distT = Math.max(0, 1 - Math.min(cand.pocketDist, 900) / 900); // 1 = 贴袋口
    return cutT * 0.75 + distT * 0.45;
  }

  // ----------------------------------------------------------------
  //  出杆稳健性（robust）
  //
  //  实测出来的问题：comfortOf 那套静态近似不够用。
  //  把 ronnie 的 noise/powerErr 清零，进攻成功率 97.2%；
  //  只把误差加回去（σ_angle ≈ 0.02°、σ_power ≈ 0.7%，小到肉眼看不见），
  //  成功率立刻掉到 71.4%。也就是说 AI 挑的球**本身就贴着几何容差的边**——
  //  模拟里恰好进，差一丁点就全丢。真人打球是会挑"有富余"的球的。
  //
  //  所以这里让 AI 用**自己的误差模型**去验算候选杆：
  //  取几组固定的误差偏移各打一遍（不摇骰子，保证可复现），
  //  统计"打进 **并且** 下一杆还有得打"的比例。
  //  最后按**期望值**选杆：期望 = 成功率 × 成功时的价值。
  //  失败不是 0 分，是把上手机会白送出去，所以这个折扣必须算进去。
  //
  //  ★ 幅度必须覆盖到**实际抽样的极值**：applyHumanError 用的是
  //    tri() = rnd−rnd（范围 ±1，σ≈0.41），所以角度最大能偏到
  //    noise·2.4·1.0 ≈ 2.4σ。只验 ±1.5σ 的话，真正把球打丢的那一段
  //    根本不在样本里——实测这样验等于没验（71.7% → 71.7%）。
  //    下面取到 2.4σ（≈极值）和 1.2σ 两圈，7 个样本。
  // ----------------------------------------------------------------
  const ERR_LEVELS = [
    [0, 0],
    [2.4, 2.4], [-2.4, -2.4],
    [2.4, -2.4], [-2.4, 2.4],
    [1.2, 1.2], [-1.2, -1.2],
  ];
  const ROBUST_TOP = 8;          // 只对最有希望的 8 杆做验算（每杆 7 次模拟）

  function noisyShot(shot, prof, la, lp) {
    const sa = (prof.noise || 0) * 2.4 * 0.41;      // 与 applyHumanError 同源的 σ
    const sp = (prof.powerErr || 0) * 2.2 * 0.41;
    return {
      angle: shot.angle + sa * la,
      power: C.clamp(shot.power * (1 + sp * lp), 1.5, C.MAX_POWER),
      spinX: shot.spinX, spinY: shot.spinY,
    };
  }

  // 这杆"真打出来"有多稳？（K 次带误差复算的成功率）
  function robustRate(state, balls, e, prof) {
    let ok = 0;
    for (let i = 0; i < ERR_LEVELS.length; i++) {
      const s = noisyShot(e.shot, prof, ERR_LEVELS[i][0], ERR_LEVELS[i][1]);
      const r = tryPot(state, balls, s, e.tIdx, e.cueIdx);
      if (!r) continue;
      // 进了，但走位把自己打死 → 对单杆来说是失败
      const ns = nextStateOf(state, r.verdict);
      const world = advanceWorld(r.res, r.verdict);
      const tg = R.legalTargets(ns, world);
      if (tg.length) {
        const g = geomPot(world, tg, ns.needRed, AIM_CLEAR);
        if (g.count < 1) continue;
      }
      ok++;
    }
    return ok / ERR_LEVELS.length;
  }

  // 按"成功率 × 价值"重排前几杆
  function rerankRobust(state, balls, top, prof) {
    const n = Math.min(ROBUST_TOP, top.length);
    let pick = null;
    for (let i = 0; i < n; i++) {
      const t = top[i];
      const rate = robustRate(state, balls, t.entry, prof);
      const score = t.value * (0.12 + 0.88 * rate);
      if (!pick || score > pick.score) {
        pick = { score: score, value: t.value, entry: t.entry, sub: t.sub, kind: t.kind, rate: rate };
      }
    }
    return pick;
  }

  // ================================================================
  //  球球 throw 补偿
  //
  //  刚性球相撞时接触点切向摩擦会把目标球**拉向白球的来球一侧**，
  //  也就是减小切角（cut-induced throw）。量级：
  //      δ = atan( min( tanα/(7e), μ ) )
  //  α = 切角，e = 恢复系数，μ = 球球摩擦。
  //  薄球时 Jt 被 μ·Jn 钳住，δ 饱和在 atan(μ) ≈ 3.4°。
  //
  //  幽灵点仍按"目标球 → 袋口"的连线放，但把接触法线反向转过 −s·δ
  //  （s = 白球来球在袋口连线的哪一侧）。转完以后目标球实际出球方向
  //  才和袋口重合。不做补偿的话大师在 20° 切角上会偏 3° 以上，
  //  模拟里怎么调角度都进不了 —— 力度够也没用。
  //
  //  注意 δ 只取决于切角（Jn 与 Jt 都与来球速度成正比，速度约掉），
  //  所以不需要知道力度，纯几何即可。
  // ================================================================
  function throwDeviation(cut) {
    const ratio = Math.tan(cut) / (7 * C.BALL_RESTITUTION);
    return Math.atan(Math.min(ratio, C.MU_BALL));
  }

  // ================================================================
  //  候选杆法枚举（纯几何，极廉价）
  //  幽灵球法：目标球 T 要进袋 P，白球必须停在 C = T - unit(P-T)*2R
  // ================================================================
  function candidatesFor(balls, targets, cue, maxCut, aimClear) {
    const CUT_LIMIT = maxCut === undefined ? MAX_CUT : maxCut;
    const clear = aimClear || 0;
    const out = [];
    for (let ti = 0; ti < targets.length; ti++) {
      const t = targets[ti];
      for (let pi = 0; pi < C.pockets.length; pi++) {
        const p = C.pockets[pi];
        const ux0 = p.x - t.x, uy0 = p.y - t.y;
        const uLen = Math.hypot(ux0, uy0);
        if (uLen < 1e-6) continue;
        const ux = ux0 / uLen, uy = uy0 / uLen;

        let gx = t.x - ux * C.BALL_D;
        let gy = t.y - uy * C.BALL_D;
        if (gx < C.L + C.BALL_R || gx > C.R - C.BALL_R) continue;
        if (gy < C.T + C.BALL_R || gy > C.B - C.BALL_R) continue;

        let dx = gx - cue.x, dy = gy - cue.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 1e-6) continue;
        const cut = angBetween(dx / dist, dy / dist, ux, uy);
        if (cut > CUT_LIMIT) continue;

        // throw 补偿：白球来球在袋口线的哪一侧，幽灵点就绕目标球往同侧多转 δ。
        // 转完目标球实际出球方向才和袋口重合（见 throwDeviation 注释）。
        if (cut > 1e-4) {
          const side = (ux * dy - uy * dx) >= 0 ? 1 : -1;
          const rot = -side * throwDeviation(cut);
          const cr = Math.cos(rot), sr = Math.sin(rot);
          const nx = ux * cr - uy * sr, ny = ux * sr + uy * cr;
          gx = t.x - nx * C.BALL_D;
          gy = t.y - ny * C.BALL_D;
          if (gx < C.L + C.BALL_R || gx > C.R - C.BALL_R) continue;
          if (gy < C.T + C.BALL_R || gy > C.B - C.BALL_R) continue;
          dx = gx - cue.x; dy = gy - cue.y;
          dist = Math.hypot(dx, dy);
          if (dist < 1e-6) continue;
        }

        if (C.pathBlocked(balls, cue.x, cue.y, gx, gy, cue, t, clear)) continue;
        if (C.pathBlocked(balls, t.x, t.y, p.x, p.y, t, cue, clear * 0.6)) continue;

        out.push({
          ball: t, pocket: p, pocketIdx: pi,
          angle: Math.atan2(dy, dx),
          ghost: { x: gx, y: gy },
          cut: cut,
          dist: dist,
          pocketDist: uLen,
          // 静态难度：切角越薄、路程越长越难
          score: cut * 2.2 + dist * 0.004 + uLen * 0.004,
        });
      }
    }
    out.sort((a, b) => a.score - b.score);
    return out;
  }

  // ================================================================
  //  一次模拟 + 一次判罚
  // ================================================================
  function judgeShot(state, res) {
    return R.judge(
      {
        mode: state.mode,
        isRespottedBlack: state.isRespottedBlack,
        needRed: state.needRed,
        pottedRedThisTurn: state.pottedRedThisTurn,
        currentPlayer: state.currentPlayer,
        scores: state.scores,
        opening: !!state.opening,
        poolOpen: state.poolOpen !== false,
        poolGroups: state.poolGroups ? state.poolGroups.slice() : [null, null],
      },
      {
        firstContactLabel: res.firstContactLabel,
        pottedLabels: res.pottedLabels,
        cuePotted: res.cuePotted,
        afterLabels: res.afterLabels,
      }
    );
  }

  function runShot(state, balls, shot, abort) {
    tick();                     // 虚拟时钟：一次真模拟 = 一个预算单位
    const res = S.simulateShot(balls, shot, abort ? { abort: abort } : null);
    if (!res.ok) return { res: res, verdict: null };
    return { res: res, verdict: judgeShot(state, res) };
  }

  // ================================================================
  //  打进球搜索
  // ================================================================
  const BASE_ANGLES = [-0.012, -0.008, -0.0045, -0.002, 0, 0.002, 0.0045, 0.008, 0.012];
  // 宽角度瞄准：幽灵点是**理论**瞄准，实际有力度误差、球球摩擦等模型偏差。
  // 727px 的长台，0.012rad 只等于 8.7px 横向——不到半个球径，一旦理论
  // 瞄准偏了半点就整条线扫空。这一组给"不顾一切"那一轮用。
  const WIDE_AIM = [-0.034, -0.027, -0.021, -0.016, -0.011, -0.007, -0.004, -0.002,
                    0, 0.002, 0.004, 0.007, 0.011, 0.016, 0.021, 0.027, 0.034];

  // 目标球落袋 = 成功；否则尽早退出（省时间）
  function potAbort(ballIdx, cueIdx) {
    return function (ev, world) {
      if (ev.firstContact && ev.firstContact.__i !== ballIdx) return true;
      if (world[cueIdx].potted) return true;
      return false;
    };
  }

  function tryPot(state, balls, shot, tIdx, cueIdx) {
    const r = runShot(state, balls, shot, potAbort(tIdx, cueIdx));
    if (!r.verdict) return null;
    const res = r.res, v = r.verdict;
    if (res.aborted) return null;
    if (v.cueBallInHand || res.cuePotted) return null;
    if (!v.legal || v.points <= 0) return null;
    return { res: res, verdict: v };
  }

  // 多找几杆：同一目标球多给几组力度/角度，走位才有得挑
  function potPass(state, balls, targets, cfg) {
    const cue = findCue(balls);
    if (!cue || !cue.isOnTable()) return [];
    const cueIdx = balls.indexOf(cue);
    let cands = candidatesFor(balls, targets, cue, cfg.maxCut, cfg.aimClear).slice(0, cfg.maxCands);
    // 多线程：根层候选也切片，避免每个 worker 都把整张候选表重跑一遍
    if (cfg.candSlice) {
      const sl = cfg.candSlice;
      cands = cands.filter((c, i) => (i % sl.total) === sl.index);
    }
    const out = [];
    const mults = cfg.powerMults || [1.0, 1.28, 1.6];
    const angles = cfg.angles || BASE_ANGLES;

    for (let ci = 0; ci < cands.length; ci++) {
      if (now() > cfg.deadline) break;
      const cand = cands[ci];
      const tIdx = balls.indexOf(cand.ball);
      const p0 = estimatePower(cand.dist, cand.pocketDist, cand.cut);
      let found = 0;
      for (let mi = 0; mi < mults.length; mi++) {
        const power = C.clamp(p0 * mults[mi], 1.5, C.MAX_POWER);
        for (let ai = 0; ai < angles.length; ai++) {
          const shot = { angle: cand.angle + angles[ai], power: power, spinX: 0, spinY: 0 };
          const r = tryPot(state, balls, shot, tIdx, cueIdx);
          if (r) {
            out.push({ shot: shot, res: r.res, verdict: r.verdict, cand: cand, tIdx: tIdx, cueIdx: cueIdx });
            found++;
            break;                        // 这个力度已经找到角度，换力度
          }
        }
        if (found >= (cfg.perCand || 2)) break;
        if (now() > cfg.deadline) break;
      }
    }
    return out;
  }

  // 对已成功的杆法试加塞，改善停球位置
  const SPIN_PRESETS = [
    { x: 0, y: 0, name: 'Centre' },
    { x: 0, y: 0.6, name: 'Top' },
    { x: 0, y: -0.6, name: 'Bottom' },
    { x: -0.5, y: 0, name: 'Left' },
    { x: 0.5, y: 0, name: 'Right' },
    { x: 0.35, y: 0.5, name: 'Top + Right' },
    { x: -0.35, y: 0.5, name: 'Top + Left' },
    { x: 0.35, y: -0.5, name: 'Bottom + Right' },
    { x: -0.35, y: -0.5, name: 'Bottom + Left' },
  ];

  function spinVariants(state, balls, entry, cfg) {
    const out = [entry];
    const base = entry.cand;
    const p0 = estimatePower(base.dist, base.pocketDist, base.cut);
    const mults = [0.9, 1.05, 1.3];
    const daList = [-0.004, 0, 0.004];

    for (let si = 1; si < SPIN_PRESETS.length; si++) {
      if (now() > cfg.deadline) break;
      const sp = SPIN_PRESETS[si];
      for (let mi = 0; mi < mults.length; mi++) {
        const power = C.clamp(p0 * mults[mi], 1.5, C.MAX_POWER);
        for (let ai = 0; ai < daList.length; ai++) {
          // 偏杆会带出杆偏转，先把它补回去
          const angle = base.angle + daList[ai] + sp.x * C.SQUIRT_K;
          const shot = { angle: angle, power: power, spinX: sp.x, spinY: sp.y };
          const r = tryPot(state, balls, shot, entry.tIdx, entry.cueIdx);
          if (r) {
            out.push({
              shot: shot, res: r.res, verdict: r.verdict, cand: base,
              tIdx: entry.tIdx, cueIdx: entry.cueIdx, spinName: sp.name,
            });
            break;
          }
        }
        if (now() > cfg.deadline) break;
      }
    }
    return out;
  }

  // ================================================================
  //  走位评估
  // ================================================================
  // 把判定结果落到球局上：复位彩球 + 白球回 D 区
  function advanceWorld(res, verdict) {
    const world = res.finalBalls;
    // 与实机 main.js 完全同源：分值高的先复位，点位被占时按 WPBSA 规则找空位
    const order = verdict.respot.slice().sort((a, b) => (C.COL_VAL[b] || 0) - (C.COL_VAL[a] || 0));
    for (let i = 0; i < order.length; i++) {
      const label = order[i];
      for (let j = 0; j < world.length; j++) {
        const b = world[j];
        if (b.label === label && b.potted) {
          C.respotColor(world, b, label);
          break;
        }
      }
    }
    if (verdict.cueBallInHand) {
      const cue = findCue(world);
      if (cue) C.placeCueBallInDZ(world, cue);
    }
    return world;
  }

  function nextStateOf(state, verdict) {
    return {
      mode: state.mode,
      isRespottedBlack: state.isRespottedBlack,
      needRed: verdict.nextNeedRed,
      pottedRedThisTurn: verdict.nextPottedRedThisTurn,
      currentPlayer: state.currentPlayer,
      scores: state.scores,
      opening: false,
      poolOpen: verdict.poolOpen !== undefined ? verdict.poolOpen : (state.poolOpen !== false),
      poolGroups: verdict.poolGroups ? verdict.poolGroups.slice() : (state.poolGroups ? state.poolGroups.slice() : [null, null]),
    };
  }

  // 几何可行性：台面上还有多少"能打的进球线路"，以及最好那条有多好打
  function geomPot(world, targets, preferValue, margin) {
    const cue = findCue(world);
    if (!cue || !cue.isOnTable()) return { count: 0, best: 0 };
    let count = 0, best = 0;
    for (let ti = 0; ti < targets.length; ti++) {
      const t = targets[ti];
      const val = C.COL_VAL[t.label] || 1;
      const vw = preferValue ? 0.45 + 0.55 * Math.pow(val / 7, 0.7) : 1;
      for (let pi = 0; pi < C.pockets.length; pi++) {
        const p = C.pockets[pi];
        const ux0 = p.x - t.x, uy0 = p.y - t.y;
        const uLen = Math.hypot(ux0, uy0);
        if (uLen < 1e-6) continue;
        const ux = ux0 / uLen, uy = uy0 / uLen;
        const gx = t.x - ux * C.BALL_D, gy = t.y - uy * C.BALL_D;
        if (gx < C.L + C.BALL_R || gx > C.R - C.BALL_R) continue;
        if (gy < C.T + C.BALL_R || gy > C.B - C.BALL_R) continue;
        const dx = gx - cue.x, dy = gy - cue.y;
        const d = Math.hypot(dx, dy);
        if (d < 1e-6) continue;
        const cut = angBetween(dx / d, dy / d, ux, uy);
        if (cut > MAX_CUT) continue;
        if (C.pathBlocked(world, cue.x, cue.y, gx, gy, cue, t, margin)) continue;
        if (C.pathBlocked(world, t.x, t.y, p.x, p.y, t, cue, margin)) continue;
        const ease = 1 / (1 + cut * 1.9 + d / 420 + uLen / 520);
        count++;
        const s = ease * vw;
        if (s > best) best = s;
      }
    }
    return { count: count, best: best };
  }

  // 递归排序用的先验分：不算模拟，只看"这杆值多少分 + 球好不好打"。
  // 只用来决定**谁值得往深了算**，不参与最终打分。
  function cheapKey(e, state, cfg) {
    const v = e.verdict;
    let k = v.points;
    const label = e.cand.ball.label;
    const colVal = C.COL_VAL[label];
    if (!state.needRed && colVal) k += colVal * (cfg.colorBias === undefined ? 1.8 : cfg.colorBias);
    if (label === 'black') k += (cfg.blackBias || 0);
    k -= e.cand.cut * 0.6;                    // 切角越薄越不可靠
    return k;
  }

  // 叶子评估：这杆打完之后，留给自己的局面值多少。
  // 长单杆的关键全在这儿——不然 AI 会打那种进得了、但下一杆没得打的球。
  function leafEval(world, ns, cfg) {
    const cue = findCue(world);
    if (!cue || !cue.isOnTable()) return -4;
    const tg = R.legalTargets(ns, world);
    if (!tg.length) return 4;                 // 清完了

    const posW = cfg.positionW === undefined ? 1.0 : cfg.positionW;
    const g = geomPot(world, tg, ns.needRed, cfg.aimClear);
    let v = (g.count * 0.22 + g.best * 2.2) * posW;

    // 白球扎在球堆里 → 下一杆没角度、还容易被挡，罚。
    // 这是"走位"最直观的一环：职业球员宁可少走一点，也不把白球塞进红球堆。
    let crowd = 0;
    for (const b of world) {
      if (b === cue || !b.isOnTable()) continue;
      if (Math.hypot(b.x - cue.x, b.y - cue.y) < C.BALL_R * 14) crowd++;
    }
    v -= Math.max(0, crowd - 1) * 0.22 * posW;
    return v;
  }

  // ================================================================
  //  主搜索：带"下一杆还有没有解"的递归检查
  //  —— 这是 147 的关键：不会进了这杆却把下一杆打死
  // ================================================================
  // collect=true 时额外把打分的候选按价值排序返回，交给 rerankRobust 做稳健性复排
  function searchBest(state, balls, depth, cfg, collect) {
    const targets = R.legalTargets(state, balls);
    if (!targets.length) return null;

    // 候选网按**离根的距离**收缩，而不是只看当前深度。
    //   rel 0（根层）：广撒网。一次走位本来就该多试几颗球，根层漏掉一颗
    //     好球，后面算得再细也白搭。
    //   rel 1：减半。
    //   rel ≥2：只剩四分之一 + 少一档力度 + 每候选只试一次。
    //     深层的每一颗候选都要再乘一遍它自己的候选数（entries^depth），
    //     不收缩的话 depth 3 一杆要 2600 杆模拟 —— 1100ms 的预算（约 1300 杆）
    //     根本装不下，搜索被截断，`Ding Junhui` / `Master` 那种后果就来了。
    //     rel 0/1 的取值和旧版**逐字一致**，所以 depth 2 的档位决策完全没变。
    const rootD = cfg.rootDepth === undefined ? depth : cfg.rootDepth;
    const rel = Math.max(0, rootD - depth);
    // 给 potPass 单独划一段预算：枚举/验证进球很贵，一个人就能把整段预算
    // 吃光，后面连"从已找到的进球里挑一杆"都轮不到（深度搜索直接归零）。
    // 只留 65% 找球，剩下的用于走位/递归。第 1 层没有递归，全给它。
    const potDeadline = depth > 1
      ? now() + Math.max(0, cfg.deadline - now()) * 0.65
      : cfg.deadline;
    const potCfg = {
      deadline: potDeadline,
      maxCands: cfg.allCands ? 9999
        : (rel >= 2 ? Math.max(6, cfg.topCands >> 2)
          : rel === 1 ? Math.max(6, cfg.topCands >> 1)
          : cfg.topCands),
      powerMults: cfg.powerMults
        || (rel === 0 ? [1.0, 1.3, 1.65] : rel === 1 ? [1.0, 1.4] : [1.0, 1.5]),
      perCand: cfg.perCand || (rel === 0 ? 2 : 1),
      maxCut: cfg.maxCut,
      angles: cfg.angles,
      aimClear: cfg.aimClear,
      // 只在根层切片；深层递归是每个根候选自己的子树，必须完整
      candSlice: (depth === rootD && cfg.rootCandSlice) ? cfg.rootCandSlice : null,
    };

    let entries = potPass(state, balls, targets, potCfg);
    if (!entries.length) return null;

    // 加塞走位：只在最上层做，且只对最有希望的几杆做
    if (depth >= 2 && cfg.useSpin) {
      const few = entries.slice(0, cfg.spinCands);
      for (let i = 0; i < few.length; i++) {
        if (now() > cfg.deadline) break;
        entries = entries.concat(spinVariants(state, balls, few[i], cfg));
      }
    }

    // ---- 递归分支裁剪 ----
    // 不裁剪的话，深度 d 的代价是 entries^d（entries 常态上百），一杆就把
    // 预算烧光 —— 烧光的结果不是"算得差点"，而是**评判不公平**：先算到的
    // 候选有完整子树，后算到的全是超时的空子树，谁排前面谁赢。
    // （实测：裁剪只加在深度 3 时，`Ding Junhui` 单杆从 101 掉到 27、犯规 6 次。）
    //
    // 做法：先用**便宜的先验分**（分值 + 彩球加成 + 切角）排序，
    // 只有前 branch 名真递归，其余只按叶子估。
    //   深度 2 给 branch×3（要广度，一步走位本来就该多试几颗）
    //   深度 3 给 branch  （要深度，全展开会爆）
    const branch = cfg.branch || 6;
    const branchN = depth >= 3 ? branch : branch * 3;
    const pruned = depth >= 2 && entries.length > branchN;
    let order = null;
    if (pruned) {
      order = entries.map((e, i) => ({ i: i, k: cheapKey(e, state, cfg) }))
        .sort((a, b) => b.k - a.k);
    }

    let best = null;
    const all = collect ? [] : null;
    const n = pruned ? order.length : entries.length;
    for (let oi = 0; oi < n; oi++) {
      // ★ 超时检查必须放在**每一层递归的循环头**，不能只在最外层。
      //   深一层的一个子树（44 候选 × 3 力度 × 9 角度 ≈ 1200 次模拟）跑完
      //   才会回到上一层的检查点，深度 3 时能超出预算 5 倍 —— 浏览器里就是
      //   "AI 想 1 秒卡 5 秒"。这里 break 之后，已算过的候选照常参与择优。
      if (now() > cfg.deadline) {
        cfg.timedOut = true;
        // potPass 已经把整段预算用在"找能进的球"上了，这里一 break 就把
        // 找到的进球全扔了，直接退成防守 —— 预算越紧越容易发生。
        // 至少把已经确认能进的那些里分值最高的那一杆交出去，别浪费。
        if (!best && entries.length) {
          let pick = entries[0];
          for (let k = 1; k < entries.length; k++) {
            if (entries[k].verdict.points > pick.verdict.points) pick = entries[k];
          }
          best = { value: pick.verdict.points, entry: pick, sub: null, kind: 'pot' };
          if (all) all.push({ value: best.value, entry: pick, sub: null, kind: 'pot' });
        }
        break;
      }

      const i = pruned ? order[oi].i : oi;
      const e = entries[i];
      const v = e.verdict;
      let value = v.points;
      let sub = null;
      const world = advanceWorld(e.res, v);
      const ns = nextStateOf(state, v);

      const posW = cfg.positionW === undefined ? 1.0 : cfg.positionW;

      const subDepth = (depth > 1 && (!pruned || oi < branchN)) ? depth - 1 : 0;
      if (subDepth > 0) {
        sub = searchBest(ns, world, subDepth, cfg);
        // 超时导致子搜索没跑完时，不能当成"走位断了"（-3）——那会凭空
        // 惩罚后面才轮到的候选。算作未知（0），保持前几名之间的可比性。
        value += sub ? sub.value : (cfg.timedOut ? 0 : -3);
      } else {
        value += leafEval(world, ns, cfg);
      }

      // 彩球加分：按分值，黑球额外再加（147 的必要条件就是每颗红球都接黑球）
      const colVal = C.COL_VAL[e.cand.ball.label];
      if (!state.needRed && colVal) {
        value += colVal * (cfg.colorBias === undefined ? 1.8 : cfg.colorBias);
        if (e.cand.ball.label === 'black') value += (cfg.blackBias || 0) * 3;
      }

      // 容错分：切角小 + 离袋近 = 这杆"舒服"。
      // 只对有出杆误差的画像生效（comfortW = 0 等于没这一项）。
      const cw = cfg.comfortW || 0;
      if (cw) value += comfortOf(e.cand) * cw;

      if (all) all.push({ value: value, entry: e, sub: sub, kind: 'pot' });

      if (!best || value > best.value) {
        best = {
          value: value,
          entry: e,
          sub: sub,
          kind: 'pot',
        };
      }
    }
    if (!best) return null;
    if (all) {
      all.sort((a, b) => b.value - a.value);
      best.top = all.slice(0, ROBUST_TOP + 2);
    }
    return best;
  }

  // ================================================================
  //  斯诺克搜索：无进球机会时，做对手最难解的球
  //
  //  目标（按优先级）：
  //    1. 对手**一条进球线都没有** —— 就是"没有漏球"，他打不进任何球；
  //    2. 对手**连直击都够不到** —— 必须靠撞几库去解，这才是真斯诺克；
  //    3. 以上并列时，再比"最舒服那条线有多舒服"和白球是否贴库。
  // ================================================================
  // 对手眼里的局面：能打进的线路数、能直接碰到的目标数、以及最好的那条有多舒服
  function opponentView(world) {
    const cue = findCue(world);
    // 白球不在台上：这局面没法评估（调用方本来就该把"白球落袋"的杆法滤掉）。
    // 返回的字段必须**填满**——snookerScore 会直接乘加，缺字段就是 NaN，
    // NaN 参与比较恒为 false，会静默地把候选全丢掉，比报错还难查。
    if (!cue || !cue.isOnTable()) {
      return { potLines: 0, hitLines: 0, ease: 0, cush: 0,
               cueNear: 2000, crowd: 0, escape: 0, cueBlock: 0 };
    }
    const redsLeft = R.countOnTable(world, 'red');
    const oppState = {
      mode: 'classic',
      isRespottedBlack: false,
      needRed: redsLeft > 0,
      pottedRedThisTurn: false,
    };
    const targets = R.legalTargets(oppState, world);
    const g = geomPot(world, targets, redsLeft > 0 ? false : true);

    // 直击：白球到目标球球心这条直线有没有被别的球挡住
    // （挡住的球即使打不进也得先撞库，这就是"几库解球"）
    let hitLines = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!C.pathBlocked(world, cue.x, cue.y, t.x, t.y, cue, t)) hitLines++;
    }

    // 白球贴库：出杆别扭、走位受限，算一点加分
    const nearCushion = Math.min(cue.x - C.L, C.R - cue.x, cue.y - C.T, C.B - cue.y);
    const cush = nearCushion < C.BALL_R * 2.2 ? 1 : 0;

    // ---- 斯诺克的"卖相" ----
    // cueNear：白球离最近的球有多远。贴球斯诺克（白球挨着红球）在规则上
    //   也算斯诺克，但对手只要轻轻一碰就解开，观赏性也差 —— 真实球员做的是
    //   "薄切最外侧红球 → 白球撞库 → 绕到彩球后面"，白球离所有球都很远。
    // crowd：白球周围挤了几颗球。扎在球堆里等于把机会还给对手。
    // escape：对手最近的目标离白球多远。真被斯诺克了，这个距离就是解球难度。
    let cueNear = Infinity, crowd = 0, escape = Infinity;
    for (const b of world) {
      if (b === cue || !b.isOnTable()) continue;
      const d = Math.hypot(b.x - cue.x, b.y - cue.y);
      if (d < cueNear) cueNear = d;
      if (d < C.BALL_R * 12) crowd++;
    }
    if (!isFinite(cueNear)) cueNear = 2000;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const d = Math.hypot(t.x - cue.x, t.y - cue.y);
      if (d < escape) escape = d;
    }
    if (!isFinite(escape)) escape = 0;

    // ---- 后斯诺克（cue-block）----
    // 对手的白球如果贴在别的球或库边前面，他的球杆就得抬起来从上往下打，
    // 低杆区直接消失。按他"最想打的那几条线"估一个 0~2/3 的限制值：
    // 贴得越死、挡得越正，值越大。这是防守估值里新加的一层。
    let cueBlock = 0;
    if (C.cueClear && targets.length) {
      const probe = targets.slice().sort((a, b) =>
        Math.hypot(a.x - cue.x, a.y - cue.y) - Math.hypot(b.x - cue.x, b.y - cue.y)
      ).slice(0, 6);
      for (let i = 0; i < probe.length; i++) {
        const t = probe[i];
        // 只看"对手本来能直接打到"的目标。已经被做死、只能撞库解球的
        // 局面由 potLines / hitLines 负责，不要重复加分。
        if (C.pathBlocked(world, cue.x, cue.y, t.x, t.y, cue, t)) continue;
        const ang = Math.atan2(t.y - cue.y, t.x - cue.x);
        const cl = C.cueClear.analyze(world, cue, ang);
        // 只认"球挡杆"。贴库抬杆是普通防守，已有 cush 项，不在这里重复算。
        if (cl.blocked && cl.kind === 'ball') {
          const v = 1 - cl.topFrac;
          if (v > cueBlock) cueBlock = v;
        }
      }
    }

    return { potLines: g.count, hitLines: hitLines, ease: g.best, cush: cush,
             cueNear: cueNear, crowd: crowd, escape: escape, cueBlock: cueBlock };
  }

  // 越小的 score 越好。层级分明：漏球数 >> 贴球/扎堆 >> 直击数 >> 舒适度
  //
  // 各权重是刻意分层的：
  //   potLines 10万/条 —— 漏一颗球就是送对手一次上手，任何"好看"都不值得换；
  //   贴球 2.6万、扎堆 900/颗 —— 高于直击数(1000/条)但低于漏球，
  //     意味着"宁可让对手多一条直击线，也不做贴球斯诺克"（现实里也是这么选的：
  //     贴球斯诺克会被对手一碰就解，还可能直接反做回来）；
  //   白球离球越远越好、对手目标越远越好 —— 这是真斯诺克的难度来源。
  function snookerScore(v) {
    let s = v.potLines * 100000 + v.hitLines * 1000 + v.ease * 30 - v.cush * 150;
    if (v.cueNear < C.BALL_R * 3) s += 26000;          // 贴球 / 差一点贴球
    s += v.crowd * 900;                                // 白球扎在球堆里
    s -= Math.min(v.cueNear, 700) * 0.9;               // 白球越"孤立"越好
    s -= Math.min(v.escape, 900) * 0.5;                // 对手的目标越远越难解
    // 后斯诺克：让对手只能抬杆打白球上部。价值高于"直击线多一条"(1000)，
    // 低于"漏一颗球"(100000)；贴死时最多约 16000，够让 AI 在两种安全球
    // 之间主动选"杆被挡住"的那一种。
    s -= (v.cueBlock || 0) * 24000;
    return s;
  }

  const SAFE_SPINS = [
    { x: 0, y: 0, name: 'Centre' },
    { x: 0, y: 0.55, name: 'Top' },
    { x: 0, y: -0.55, name: 'Bottom' },
    { x: 0.4, y: 0, name: 'Right' },
    { x: -0.4, y: 0, name: 'Left' },
  ];

  // ================================================================
  //  开球（break-off）
  //
  //  标准开球不是"把白球贴进红球堆"，而是薄碰红球堆外侧、让白球回到
  //  开球区/顶库附近，尽量不给对手留长台。老 AI 没有开球逻辑，安全球
  //  搜索会选一杆几乎没有位移的轻碰，双方 AI 就容易进入贴球循环。
  //
  //  这里只在第一杆调用：枚举红球堆边缘几颗球、几个薄厚角度、几档力度
  //  和少量侧旋，用真实物理模拟，挑"首触红球 + 白球回开球区 + 红球位移小"
  //  的一杆。找不到就返回 null，交回普通决策。
  // ================================================================
  function breakOff(state, balls) {
    const cue = findCue(balls);
    if (!cue || !cue.isOnTable()) return null;

    const reds = [];
    for (let i = 0; i < balls.length; i++) {
      if (balls[i].label === 'red' && balls[i].isOnTable()) reds.push({ b: balls[i], i: i });
    }
    if (reds.length < 10) return null;             // 只对完整球堆开球

    reds.sort((a, b) => a.b.x - b.b.x);
    // 只在三个"看得见"的球上找：最左的顶点、以及上下两个后角。
    // 再多会拖慢第一杆（这是主线程一次性搜索）。
    let ymin = reds[0], ymax = reds[0];
    for (let i = 1; i < reds.length; i++) {
      if (reds[i].b.y < ymin.b.y) ymin = reds[i];
      if (reds[i].b.y > ymax.b.y) ymax = reds[i];
    }
    const picks = reds.slice(0, 3);
    if (picks.indexOf(ymin) < 0) picks.push(ymin);
    if (picks.indexOf(ymax) < 0) picks.push(ymax);

    const powers = [12, 18, 24, 30];
    const spinsX = [-0.4, 0, 0.4];
    // 开球也允许低杆：有些线路靠回旋把白球往开球区拉
    const spinsY = [-0.45, 0, 0.35];
    const baulkSpots = ['yellow', 'green', 'brown'].map(l => C.getColorPos(l));
    const cueIdx = balls.indexOf(cue);
    let best = null, bestScore = -Infinity;

    const abort = (ev, world) => {
      if (ev.firstContact && ev.firstContact.label !== 'red') return true;
      if (world[cueIdx] && world[cueIdx].potted) return true;
      return false;
    };

    for (let ti = 0; ti < picks.length; ti++) {
      const target = picks[ti].b;
      const dx = target.x - cue.x, dy = target.y - cue.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-6) continue;
      const base = Math.atan2(dy, dx);
      // 薄厚角度：既包含"擦边"的小角度，也包含略厚的角度；
      // 这个引擎下真正能把白球送离球堆的，往往是带侧旋的稍厚一点。
      const offsets = [-0.06, -0.03, -0.015, 0, 0.015, 0.03, 0.06];

      for (let oi = 0; oi < offsets.length; oi++) {
        for (let pi = 0; pi < powers.length; pi++) {
          for (let xi = 0; xi < spinsX.length; xi++) {
            for (let yi = 0; yi < spinsY.length; yi++) {
              const shot = {
                angle: base + offsets[oi],
                power: powers[pi],
                spinX: spinsX[xi],
                spinY: spinsY[yi],
              };
              const res = S.simulateShot(balls, shot, { track: false, abort: abort });
              if (!res.ok || res.aborted || res.cuePotted) continue;
              if (res.firstContactLabel !== 'red') continue;
              let bad = false;
              for (let k = 0; k < res.pottedLabels.length; k++) {
                if (res.pottedLabels[k] !== 'red') bad = true;
              }
              if (bad) continue;
              const cf = res.finalBalls[cueIdx];
              if (!cf || !cf.isOnTable()) continue;

              // 红球被推动得越少，越接近"薄碰侧边"
              let moved = 0;
              for (let ri = 0; ri < reds.length; ri++) {
                const r0 = reds[ri].b;
                const r1 = res.finalBalls[reds[ri].i];
                if (r1) moved += Math.hypot(r1.x - r0.x, r1.y - r0.y);
              }
              let near = Infinity;
              for (let bi = 0; bi < res.finalBalls.length; bi++) {
                const b = res.finalBalls[bi];
                if (bi === cueIdx || !b.isOnTable()) continue;
                const d = Math.hypot(b.x - cf.x, b.y - cf.y);
                if (d < near) near = d;
              }
              if (!isFinite(near)) near = 800;

              let score = 0;
              // 真实开球：优先把白球送回开球区、靠近黄/绿/棕三颗彩球，
              // 同时尽量少推动红球堆。
              if (cf.x < C.BAULK_X) score += 4200;
              else if (cf.x < C.BAULK_X + 180) score += 2400;
              let bc = Infinity;
              for (let bi = 0; bi < baulkSpots.length; bi++) {
                const p = baulkSpots[bi];
                const d = Math.hypot(cf.x - p.x, cf.y - p.y);
                if (d < bc) bc = d;
              }
              if (bc < 180) score += (180 - bc) * 18;
              score += Math.min(near, 600) * 3.0;
              if (near < 160) score -= (160 - near) * 30;    // 离红球堆越远越好
              if (near < C.BALL_R * 3.2) score -= 4200;      // 绝不把白球留在球堆里
              if (cf.x > C.BLACK_X) score -= 1400;           // 别送到黑球端
              if (cf.x > C.PINK_X + 80) score -= 2000;       // 开球不该停在红球/黑球端
              score -= Math.max(0, cf.x - C.CX2) * 1.2;      // 白球越靠左越好
              score -= moved * 2.4;                          // 薄碰，少动红球
              if (moved < 450) score += 1200;
              if (res.pottedLabels.indexOf('red') >= 0) score += 350;
              if (cf.x < C.L + C.BALL_R * 1.6) score += 180; // 贴开球区库边

              if (score > bestScore) {
                bestScore = score;
                best = { shot: shot, score: score };
              }
            }
          }
        }
      }
    }

    if (!best) return null;
    return {
      shot: best.shot,
      kind: 'safety',
      reason: 'Break off · thin on the pack, cue ball away from the pack',
    };
  }

  function safetySearch(state, balls, cfg) {
    const cue = findCue(balls);
    const targets = R.legalTargets(state, balls);
    if (!cue || !cue.isOnTable() || !targets.length) return null;

    // 只朝最近的几颗合法目标打——空杆直接送自由球，绝不能干
    // （真实球员做斯诺克常挑**最外侧**那颗红球薄切，不一定是最近的；
    //   5 颗 + 大偏角扫描能覆盖到它）
    const near = targets.slice().sort((a, b) =>
      Math.hypot(a.x - cue.x, a.y - cue.y) - Math.hypot(b.x - cue.x, b.y - cue.y)
    ).slice(0, 5);

    const legalIdx = {};
    for (const t of targets) legalIdx[balls.indexOf(t)] = true;

    const cueIdx = balls.indexOf(cue);
    let best = null, bestScore = Infinity;      // 总体最优（可能仍有漏球）
    let perfect = null, perfectScore = Infinity;// **零漏球且解不到** 的最优
    let perfectCount = 0;

    const aborts = (ev, world) => {
      if (ev.firstContact && !legalIdx[ev.firstContact.__i]) return true;  // 先碰非目标球 → 犯规
      if (world[cueIdx].potted) return true;
      return false;
    };

    // 偏角要能扫到 ±0.42rad（24°）：近处的挡球 55px 就能遮掉 ±21°
    const DIRS = [-0.42, -0.28, -0.18, -0.10, -0.055, -0.028, -0.012, 0,
                  0.012, 0.028, 0.055, 0.10, 0.18, 0.28, 0.42];
    const MULTS = [0.4, 0.62, 0.9, 1.25];

    // 第二轮（撞库做球）用的参数：偏角大到 1.2rad(69°)，力度也要能顶到库边
    const WIDE_DIRS = [-1.20, -0.95, -0.75, -0.58, -0.48, -0.36, -0.25, -0.16,
                       -0.08, -0.04, -0.015, 0,
                       0.015, 0.04, 0.08, 0.16, 0.25, 0.36, 0.48, 0.58, 0.75, 0.95, 1.20];
    const WIDE_MULTS = [0.5, 0.75, 1.0, 1.35, 1.8, 2.4];

    // 组合表按"最可能先成功"排序：方向偏得少、力度接近 1、塞少 → 先试。
    // 然后**对所有目标球轮询**（而不是一颗球试完再试下一颗）——
    // 否则预算只够探索第一颗球，它一被挡住整个搜索就白跑了。
    // 已经找到“零漏球且对手碰不到球”的解时，再往下探索的收益只在于让
    // 停球更舒服一点。追求的程度由 safetyThorough 控制（希金斯/塞尔比
    // 会继续磨到预算耗尽，奥沙利文/特鲁姆普见好就收）。
    const thorough = cfg.safetyThorough === undefined ? 1 : cfg.safetyThorough;
    const enoughAfterPerfect = thorough >= 0.8 ? 3 : 1;
    let perfectStale = 0;

    // 试一杆：合法 + 没进球 + 白球没落袋 才算数，然后评估对手局面
    const probes = [];          // 记下"合法但还不够完美"的杆法，供第三轮微调
    function trySafe(shot, t, spinName) {
      const r = runShot(state, balls, shot, aborts);
      if (!r.verdict) return false;
      const v = r.verdict;
      if (!v.legal || v.points > 0 || v.cueBallInHand || r.res.cuePotted) return false;
      if (v.pottedLegal.length > 0) return false;    // 那是进球，不是防守
      if (r.res.aborted) return false;
      const world = advanceWorld(r.res, v);
      const view = opponentView(world);
      let score = snookerScore(view);

      // 反消极：连续出现"白球几乎没走 / 停在球堆里"之后，逐渐降低
      // 这类贴球安全球的吸引力，转而鼓励把白球送远、送到库边。
      // 不禁止贴球——只是让它不再是重复局面里的最优解。
      const neg = state.negativeStreak || 0;
      const negLabel = state.isRespottedBlack ? 'black' : 'red';
      let nearRed = Infinity;
      {
        const wc = findCue(world);
        if (wc) {
          for (let bi = 0; bi < world.length; bi++) {
            const b = world[bi];
            if (b.label !== negLabel || !b.isOnTable()) continue;
            const d = Math.hypot(b.x - wc.x, b.y - wc.y);
            if (d < nearRed) nearRed = d;
          }
        }
      }
      if (neg >= 2) {
        const wc = findCue(world);
        if (wc) {
          const travel = Math.hypot(wc.x - cue.x, wc.y - cue.y);
          score -= Math.min(travel, 600) * (0.55 + neg * 0.35);
          if (travel < 60) score += 3500 * (neg - 1);
          // 只对"白球贴着红球堆"加罚。贴着黄/绿/棕做斯诺克是正常且好看的
          // 台底防守，不能一起算消极。
          if (nearRed < C.BALL_R * 2.8) score += 7000 * (neg - 1);
          if (neg >= 3 && nearRed < C.BALL_R * 3) {
            score += 120000 * (neg - 2);
          }
        }
      }
      const entry = { shot: shot, res: r.res, verdict: v, cand: { ball: t }, spinName: spinName };
      if (score < bestScore) {
        bestScore = score;
        best = { value: -score, kind: 'safety', entry: entry, sub: null, ease: score, view: view };
      }
      // 真斯诺克：对手既打不进、也直接碰不到 → 只能撞库解。
      // 但如果白球贴着别的球（cueNear 很小），这不是真斯诺克，只是"贴球"；
      // 连续消极时不再把它当完美解，避免 AI 一直用同一种方式磨。
      const glued = nearRed < C.BALL_R * 3;
      if (view.potLines === 0 && view.hitLines === 0 && !(neg >= 3 && glued)) {
        perfectCount++;
        if (score < perfectScore) {
          perfectScore = score;
          perfect = { value: -score, kind: 'safety', entry: entry, sub: null,
                      ease: score, view: view, snookered: true };
          perfectStale = 0;
        }
        return true;
      }
      // 记住几条"差一点"的：漏球越少越值得细调
      if (view.potLines <= 2) {
        probes.push({ t: t, angle: shot.angle, power: shot.power,
                      sx: shot.spinX, sy: shot.spinY, name: spinName, score: score });
      }
      return false;
    }

    function sweep(dirs, mults) {
      const cost = [];
      for (let mi = 0; mi < mults.length; mi++) {
        for (let di = 0; di < dirs.length; di++) {
          for (let si = 0; si < SAFE_SPINS.length; si++) {
            const c = Math.abs(dirs[di]) * 12 + Math.abs(mults[mi] - 1) * 0.35 +
                      Math.hypot(SAFE_SPINS[si].x, SAFE_SPINS[si].y) * 0.06;
            cost.push({ di: di, mi: mi, si: si, cost: c });
          }
        }
      }
      cost.sort((a, b) => a.cost - b.cost);
      for (let k = 0; k < cost.length; k++) {
        // 多线程：安全球扫描同样按组合序号切片，每个 worker 只扫自己那份
        if (cfg.safetySlice && (k % cfg.safetySlice.total) !== cfg.safetySlice.index) continue;
        const cb = cost[k];
        for (let ti = 0; ti < near.length; ti++) {
          if (now() > cfg.deadline) return;
          if (perfectCount >= enoughAfterPerfect && perfectStale++ > 60) return;
          const t = near[ti];
          const dist = Math.hypot(t.x - cue.x, t.y - cue.y);
          const sp = SAFE_SPINS[cb.si];
          trySafe({
            angle: Math.atan2(t.y - cue.y, t.x - cue.x) + dirs[cb.di] + sp.x * C.SQUIRT_K,
            power: C.clamp(C.speedForDistance(dist, 2.6) * mults[cb.mi], 2, C.MAX_POWER),
            spinX: sp.x, spinY: sp.y,
          }, t, sp.name);
        }
      }
    }

    // 第一轮：小偏角轻做（最常见、最容易成功）
    sweep(DIRS, MULTS);

    // 第二轮：**撞库做球**。上一步没做到"零漏球 + 对手够不到"时，
    // 大幅角就派上用场了——把白球送到库边、或者绕到挡球后面，
    // 对手就只能靠几库去解。这是"铁桶斯诺克"的主要来源。
    if (!perfect) sweep(WIDE_DIRS, WIDE_MULTS);

    // 第三轮：**微调**。白球最终停在哪对角度极其敏感——差 0.3° 就从
    // "被挡球挡住"变成"漏出半颗球"。把上一轮最接近的几条拿出来，
    // 在角度 ±0.006rad、力度 ±6% 的网格上细扫，把"差一点"补上。
    if (!perfect && probes.length && now() < cfg.deadline) {
      probes.sort((a, b) => a.score - b.score);
      const top = probes.slice(0, 5);
      const dAs = [-0.006, -0.003, -0.0015, -0.0006, 0.0006, 0.0015, 0.003, 0.006];
      const pKs = [0.94, 0.97, 1.0, 1.03, 1.06];
      for (let i = 0; i < top.length && !perfect; i++) {
        const pr = top[i];
        for (let ai = 0; ai < dAs.length; ai++) {
          for (let pi = 0; pi < pKs.length; pi++) {
            if (now() > cfg.deadline) break;
            trySafe({
              angle: pr.angle + dAs[ai],
              power: C.clamp(pr.power * pKs[pi], 2, C.MAX_POWER),
              spinX: pr.sx, spinY: pr.sy,
            }, pr.t, pr.name);
          }
        }
      }
    }

    return perfect || best;
  }

  // ================================================================
  //  兜底：实在无解也要**打出一杆合法的球**（不能白送犯规）
  //
  //  老实现直瞄最近目标球的球心，不看遮挡 —— 一旦被挡就是必犯规。
  //  现在改为对最近几颗目标球做小角度扫描 + 真模拟，只接受"先碰到
  //  合法目标球"的线路；全都碰不到时才退回轻碰。
  // ================================================================
  function fallbackShot(state, balls) {
    const cue = findCue(balls);
    const targets = R.legalTargets(state, balls);
    if (!cue || !targets.length) {
      return { shot: { angle: Math.random() * Math.PI * 2, power: 8, spinX: 0, spinY: 0 }, kind: 'random', reason: 'No legal ball' };
    }

    const cueIdx = balls.indexOf(cue);
    const legalIdx = {};
    for (const t of targets) legalIdx[balls.indexOf(t)] = true;
    const aborts = (ev, world) => {
      if (ev.firstContact && !legalIdx[ev.firstContact.__i]) return true;
      if (world[cueIdx].potted) return true;
      return false;
    };

    const near = targets.slice().sort((a, b) =>
      Math.hypot(a.x - cue.x, a.y - cue.y) - Math.hypot(b.x - cue.x, b.y - cue.y)
    ).slice(0, 5);

    // 从正对球心开始，左右交替加大偏角，直到找到一条干净碰到合法球的线路
    let best = null, bd = Infinity;
    for (const t of near) {
      const d = Math.hypot(t.x - cue.x, t.y - cue.y);
      if (d < bd) { bd = d; best = t; }
    }

    // 第一轮：对着目标球附近做小角度扫描（正常情况这一轮就够）
    for (let step = 0; step <= 20; step++) {
      const mag = Math.ceil(step / 2) * 0.022;
      const off = (step % 2 === 1) ? mag : -mag;
      for (let ti = 0; ti < near.length; ti++) {
        const t = near[ti];
        const dir = Math.atan2(t.y - cue.y, t.x - cue.x);
        const dist = Math.hypot(t.x - cue.x, t.y - cue.y);
        const shot = {
          angle: dir + off,
          power: C.clamp(C.speedForDistance(dist, 2.6), 2.5, C.MAX_POWER),
          spinX: 0, spinY: 0,
        };
        const r = runShot(state, balls, shot, aborts);
        if (r.verdict && r.verdict.legal && !r.res.aborted) {
          return { shot: shot, kind: 'fallback', reason: 'Thin clip on the nearest ball' };
        }
      }
    }

    // 第二轮：目标球被**近处的球**挡住时，绕开它需要很大的偏角。
    //   典型例子：白球正后方贴着棕球，通往红球堆的整个扇面被封死
    //   （55px 外的球就能遮掉 ±21°，而上一轮只扫到 ±0.22rad）。
    //   这里改成大偏角 + 大力，允许先撞库再碰到目标球——只要首碰合法。
    const wide = [0.30, 0.45, 0.60, 0.80, 1.00];
    const widePower = [0.55, 0.75, 1.0];
    for (let wi = 0; wi < wide.length; wi++) {
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        for (let pi = 0; pi < widePower.length; pi++) {
          for (let ti = 0; ti < near.length; ti++) {
            const t = near[ti];
            const dir = Math.atan2(t.y - cue.y, t.x - cue.x) + sgn * wide[wi];
            const shot = {
              angle: dir,
              power: C.MAX_POWER * widePower[pi],
              spinX: 0, spinY: 0,
            };
            const r = runShot(state, balls, shot, aborts);
            if (r.verdict && r.verdict.legal && !r.res.aborted) {
              return { shot: shot, kind: 'fallback', reason: 'Around the blocker · clip the ball on' };
            }
          }
        }
      }
    }

    // 连薄边都碰不到（真被完全封死）——最后一档：暴力解球/开球
    return {
      shot: {
        angle: Math.atan2(best.y - cue.y, best.x - cue.x),
        power: C.MAX_POWER * 0.86,
        spinX: (Math.random() - 0.5) * 0.25,
        spinY: 0,
      },
      kind: 'fallback',
      reason: 'Completely snookered · power escape',
    };
  }

  // ================================================================
  //  强制进球搜索（连续几杆没进球时启用）
  //
  //  背景：常规搜索只找"白球 → 幽灵点 → 目标球 → 袋口"这条直达线。
  //  一颗红球被挤到袋口旁边，但白球没有直接角度时，AI 会一直做斯诺克，
  //  现实球员却会用加塞、翻袋、组合球硬打。这里补的就是这些线路：
  //
  //    1. 直达球：放宽切角、穷举候选、宽角度 + 多档力度；
  //    2. 加塞：对已经能进的最舒服几条线试高低杆/左右塞；
  //    3. 翻袋 / 一库：把袋口或幽灵点按库边镜像，让目标球或白球先撞一库；
  //    4. 组合球：白球先撞 A，A 再把目标球撞进袋。
  //
  //  全部线路仍然走同一套物理 + 裁判，模拟不进就不算"能进"。
  //  预算用完就停，不保证一定找到——几何上真的没有线路时，仍会退回防守。
  // ================================================================
  function mirrorAcross(p, rail) {
    const m = C.BALL_R;
    if (rail === 0) return { x: 2 * (C.L + m) - p.x, y: p.y };   // 左库
    if (rail === 1) return { x: 2 * (C.R - m) - p.x, y: p.y };   // 右库
    if (rail === 2) return { x: p.x, y: 2 * (C.T + m) - p.y };   // 顶库
    return { x: p.x, y: 2 * (C.B - m) - p.y };                   // 底库
  }

  function forcedPot(state, balls, budgetMs) {
    const deadline = now() + Math.max(250, budgetMs || 900);
    const cue = findCue(balls);
    const targets = R.legalTargets(state, balls);
    if (!cue || !cue.isOnTable() || !targets.length) return null;
    const cueIdx = balls.indexOf(cue);
    const legalIdx = {};
    for (let i = 0; i < targets.length; i++) legalIdx[balls.indexOf(targets[i])] = true;

    const abortCue = (ev, world) => !!(world[cueIdx] && world[cueIdx].potted);
    let best = null;

    // 打一杆、真判一次；进了才参与比较。tag 用来告诉 UI 这是什么线路。
    function consider(shot, tag) {
      if (now() > deadline) return null;
      const r = runShot(state, balls, shot, abortCue);
      if (!r.verdict) return null;
      const v = r.verdict, res = r.res;
      if (!v.legal || v.cueBallInHand || res.cuePotted || v.points <= 0) return null;
      const value = v.points + (v.gameOver ? 100 : 0) + (v.turnContinues ? 0.4 : 0);
      const entry = { shot: shot, value: value, tag: tag, verdict: v };
      if (!best || value > best.value) best = entry;
      return entry;
    }

    const mults = [0.92, 1.08, 1.3];

    // ---------- 1. 直达球：比常规搜索宽一档 ----------
    const direct = candidatesFor(balls, targets, cue, 1.52, 0).slice(0, 64);
    const fineAngles = [0, -0.0045, 0.0045, -0.012, 0.012, -0.024, 0.024];
    const directHits = [];
    for (let ci = 0; ci < direct.length && now() <= deadline; ci++) {
      const cand = direct[ci];
      const p0 = estimatePower(cand.dist, cand.pocketDist, cand.cut);
      for (let mi = 0; mi < mults.length; mi++) {
        for (let ai = 0; ai < fineAngles.length; ai++) {
          const shot = {
            angle: cand.angle + fineAngles[ai],
            power: C.clamp(p0 * mults[mi], 1.5, C.MAX_POWER),
            spinX: 0, spinY: 0,
          };
          const hit = consider(shot, 'Forced pot');
          if (hit) { directHits.push(hit); break; }
          if (now() > deadline) break;
        }
        if (now() > deadline) break;
      }
    }

    // ---------- 2. 加塞：把已经能进的线打出不同走位 ----------
    const spinTop = directHits.slice().sort((a, b) => b.value - a.value).slice(0, 3);
    for (let si = 0; si < spinTop.length && now() <= deadline; si++) {
      const base = spinTop[si].shot;
      for (let pi = 1; pi < SPIN_PRESETS.length; pi++) {
        const sp = SPIN_PRESETS[pi];
        for (const k of [0.95, 1.08]) {
          if (now() > deadline) break;
          const shot = {
            angle: base.angle + sp.x * C.SQUIRT_K,
            power: C.clamp(base.power * k, 1.5, C.MAX_POWER),
            spinX: sp.x, spinY: sp.y,
          };
          consider(shot, 'Forced pot · ' + sp.name);
        }
      }
    }

    // ---------- 3. 翻袋：目标球先撞一库再进袋 ----------
    for (let ti = 0; ti < targets.length && now() <= deadline; ti++) {
      const t = targets[ti];
      for (let pi = 0; pi < C.pockets.length && now() <= deadline; pi++) {
        const p = C.pockets[pi];
        for (let rail = 0; rail < 4 && now() <= deadline; rail++) {
          const mp = mirrorAcross(p, rail);
          const dx0 = mp.x - t.x, dy0 = mp.y - t.y;
          const len = Math.hypot(dx0, dy0);
          if (len < 1e-6) continue;
          const gx = t.x - dx0 / len * C.BALL_D;
          const gy = t.y - dy0 / len * C.BALL_D;
          if (gx < C.L + C.BALL_R || gx > C.R - C.BALL_R) continue;
          if (gy < C.T + C.BALL_R || gy > C.B - C.BALL_R) continue;
          const dx = gx - cue.x, dy = gy - cue.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 1e-6) continue;
          const cut = angBetween(dx / dist, dy / dist, dx0 / len, dy0 / len);
          if (cut > 1.55) continue;
          if (C.pathBlocked(balls, cue.x, cue.y, gx, gy, cue, t, 0)) continue;
          const p0 = estimatePower(dist, len * 1.15, Math.min(cut, 1.2));
          const baseAngle = Math.atan2(dy, dx);
          for (let mi = 0; mi < mults.length && now() <= deadline; mi++) {
            for (const da of [0, -0.008, 0.008]) {
              consider({
                angle: baseAngle + da,
                power: C.clamp(p0 * mults[mi] * 1.12, 1.5, C.MAX_POWER),
                spinX: 0, spinY: 0,
              }, 'Banked pot');
              if (now() > deadline) break;
            }
          }
        }
      }
    }

    // ---------- 4. 组合球：白球先撞 A，A 把目标球送进袋 ----------
    for (let ti = 0; ti < targets.length && now() <= deadline; ti++) {
      const t = targets[ti];
      for (let pi = 0; pi < C.pockets.length && now() <= deadline; pi++) {
        const p = C.pockets[pi];
        const ux0 = p.x - t.x, uy0 = p.y - t.y;
        const uLen = Math.hypot(ux0, uy0);
        if (uLen < 1e-6) continue;
        const ux = ux0 / uLen, uy = uy0 / uLen;
        const gx = t.x - ux * C.BALL_D;
        const gy = t.y - uy * C.BALL_D;
        if (gx < C.L + C.BALL_R || gx > C.R - C.BALL_R) continue;
        if (gy < C.T + C.BALL_R || gy > C.B - C.BALL_R) continue;

        for (let ai = 0; ai < balls.length && now() <= deadline; ai++) {
          const a = balls[ai];
          if (a === cue || a === t || !a.isOnTable() || !legalIdx[ai]) continue;
          const atx = gx - a.x, aty = gy - a.y;
          const alen = Math.hypot(atx, aty);
          if (alen < C.BALL_D * 0.75) continue;
          // 白球撞 A 的幽灵点：A 的中心沿 A→T 方向前进
          const cgx = a.x - atx / alen * C.BALL_D;
          const cgy = a.y - aty / alen * C.BALL_D;
          if (cgx < C.L + C.BALL_R || cgx > C.R - C.BALL_R) continue;
          if (cgy < C.T + C.BALL_R || cgy > C.B - C.BALL_R) continue;
          if (C.pathBlocked(balls, cue.x, cue.y, cgx, cgy, cue, a, 0)) continue;
          if (C.pathBlocked(balls, a.x, a.y, gx, gy, a, t, 0)) continue;
          const dx = cgx - cue.x, dy = cgy - cue.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 1e-6) continue;
          const p0 = estimatePower(dist + alen, uLen, 0.35);
          const baseAngle = Math.atan2(dy, dx);
          for (let mi = 0; mi < 3 && now() <= deadline; mi++) {
            for (const da of [0, -0.006, 0.006]) {
              consider({
                angle: baseAngle + da,
                power: C.clamp(p0 * [1.0, 1.18, 1.4][mi], 1.5, C.MAX_POWER),
                spinX: 0, spinY: 0,
              }, 'Combination pot');
              if (now() > deadline) break;
            }
          }
        }
      }
    }

    // ---------- 5. 白球一库：先撞库，再把幽灵点撞正 ----------
    for (let ci = 0; ci < direct.length && now() <= deadline; ci++) {
      const cand = direct[ci];
      const g = cand.ghost;
      for (let rail = 0; rail < 4 && now() <= deadline; rail++) {
        const mg = mirrorAcross(g, rail);
        const dx = mg.x - cue.x, dy = mg.y - cue.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1e-6) continue;
        const p0 = estimatePower(dist * 1.08, cand.pocketDist, cand.cut);
        const baseAngle = Math.atan2(dy, dx);
        for (let mi = 0; mi < 2 && now() <= deadline; mi++) {
          consider({
            angle: baseAngle + (mi ? 0.006 : -0.006),
            power: C.clamp(p0 * (1.0 + mi * 0.22), 1.5, C.MAX_POWER),
            spinX: 0, spinY: 0,
          }, 'Cushion-route pot');
        }
      }
    }

    if (!best) return null;
    return {
      shot: best.shot,
      kind: 'pot',
      reason: best.tag + ' · must score',
      value: best.value,
    };
  }

  // ================================================================
  //  各档位决策
  // ================================================================
  // 参数说明：
  //   style      : 'random' 乱打 | 'aim' 只算一条线 | 'strong' 全模拟搜索
  //   depth      : 搜索深度（2 = 会算"打完这杆下一杆还有没有得打"）
  //   budget     : 每杆思考时间上限(ms)
  //   ticks      : 同一预算折算成"允许模拟多少杆"（实测标定），
  //                只在虚拟时钟下生效 —— 见 tools/bench.js。
  //                ★ 标定方法：`node tools/calib.js` 用真实时钟量出"每毫秒能模拟
  //                多少杆"（本机约 1.2~1.3），再乘 budget。**两者必须同源**：
  //                ticks 给少了，跑分台看到的 AI 比浏览器里笨，照着跑分结果调参
  //                就会把画像越调越歪（实测 ding 因为 ticks 少给 27%，
  //                单杆从 101 掉到 27、上手均分 4.7）；给多了则是虚高。
  //                selby/higgins 的 ticks 比同 budget 的别人高一档，是因为
  //                safetyThorough ≥ 1.2 会把防守那一杆的预算自己放大 1.3 倍。
  //   noise      : 出杆角度噪声(rad)。**大师为 0 = 准度无限**
  //   powerErr   : 力度噪声比例
  //   maxCut     : 容忍多薄的球（rad，1.36≈78°）。越大越敢打薄球
  //   pickSafetyAbove : 切角超过这个值就宁可做防守（Infinity = 从不放弃）
  //   colorBias  : 彩球分值加成倍率（越高越爱打高分彩球）
  //   blackBias  : 黑球额外加成（147 靠它——每颗红球后都接黑球）
  //   positionW  : 走位权重
  //   comfortW   : 出杆容错权重（切角小/离袋近的球优先）。
  //                这是**选球常识**，不是准度：noise=0 的档位给 0；
  //                有误差的画像必须给（否则会去捡容差 0.3px 的极限薄球）
  //   safetyThorough : 防守搜索投入程度（越大磨得越细，越能找到零漏球）
  //   desperate  : true = 只要有一丝进球可能就绝不防守（147 大师）
  //   pace       : 出杆节奏倍数（奥沙利文 0.45 = 飞快，塞尔比 1.5 = 磨）
  const PROFILES = {
    easy: {
      key: 'easy', name: 'Novice', desc: 'Wide angle error, no position play',
      style: 'random',
    },
    medium: {
      key: 'medium', name: 'Amateur', desc: 'Reads the pot, rough on position',
      style: 'aim',
    },
    hard: {
      key: 'hard', name: 'Veteran', desc: 'Precise cueing, plans the next shot',
      // depth 必须是 2：depth 1 时叶子只看"这杆打完下一杆有没有得打"，
      // 没有"下一杆打完再下一杆"的信息，红球阶段就不会持续往黑球区走位
      // （实测单杆 42，上手均分 18.7）。改 depth 2 后单杆 132、上手均分 63。
      // 和大师档的区别留在：候选网更小（30 vs 44）、不用塞、不追 147（blackBias 0.4）。
      style: 'strong', depth: 3, budget: 800, ticks: 1040, topCands: 30, useSpin: false,
      noise: 0, powerErr: 0, maxCut: 1.30, pickSafetyAbove: Infinity,
      colorBias: 1.2, blackBias: 0.4, positionW: 1.0,
      safetyThorough: 0.6, pace: 1.0, deepSearch: true,
    },
    master: {
      key: 'master', name: 'Master 147',
      desc: 'Perfect accuracy · chases 147, only plays safe when truly nothing is on',
      // depth 3 = 真的会想"这杆之后那杆之后"。代价按 branch×深度2 控制，
      // budget/ticks 同比放大（ticks 始终按 budget 线性标定，跑分台才和浏览器一致）。
      style: 'strong', depth: 3, branch: 5, budget: 2200, ticks: 2600,
      topCands: 44, spinCands: 10, useSpin: true,
      noise: 0, powerErr: 0, maxCut: 1.36, pickSafetyAbove: Infinity,
      colorBias: 1.8, blackBias: 1.6, positionW: 1.0,
      // safetyThorough 不给满：第十一轮换成刚体物理后，1.0 的"零漏球斯诺克"
      // 会让 master 自战变成 120 杆纯防守死局（双方都把白球藏死，谁都没有
      // 可打的球）。0.75 仍然做真斯诺克，但会留出薄球机会 —— 实战对人也更
      // 像职业球员：压迫感在，但不会永远解不到。
      safetyThorough: 0.75, desperate: true, pace: 0.9, flair: 0.12,
    },

    // ================================================================
    //  真实球员画像 —— 参数照着打法特点配，不是简单调难度
    //
    //  noise / powerErr 的绝对量级是**标定出来的**，不是拍脑袋：
    //    physics.js 的接触判据改成扫掠之后，仿真对瞄准的容差仍然比现实紧
    //    （0.023° 的瞄准误差就掉到 ~77% 进球率），所以误差模型按"跑分台
    //    实测能打出 85%~93% 进攻成功率"来定，这才对得上职业球员的观感。
    //    相对大小仍然照人设：trump 最大（长台硬解），higgins 最小（稳）。
    //
    //  budget 五个画像**统一给 1000ms**：区分他们的是打法参数（误差、
    //    切角偏好、走位权重、防守投入），不该是"谁的搜索算得久谁就强"。
    //    原先 ding 520ms 是全场最低，写深度 2 的搜索一杆要 700 杆模拟，
    //    它每杆都被预算截断 —— 结果是"中国龙不会打球"（上手均分 4.7）。
    //    真实球员的区别在手上，不在 CPU 上。
    //  ticks 用 tools/calib.js 量出来的"每毫秒模拟杆数"乘 budget。
    //  跑分台：node tools/bench.js --profiles ronnie,higgins,trump,ding,selby --games 6
    // ================================================================
    ronnie: {
      key: 'ronnie', name: "Ronnie O'Sullivan",
      desc: 'The Rocket · lightning pace, long potting, elite position, no time for safeties',
      style: 'strong', depth: 3, budget: 1800, ticks: 2160, topCands: 34, spinCands: 8, useSpin: true,
      noise: 0.00012, powerErr: 0.0024, fluff: 0.05, maxCut: 1.36, pickSafetyAbove: Infinity,
      colorBias: 2.0, blackBias: 1.9, positionW: 1.05, comfortW: 1.2,
      safetyThorough: 0.45, pace: 0.45, deepSearch: true, aggressive: true, flair: 0.18,
    },
    higgins: {
      key: 'higgins', name: 'John Higgins',
      desc: 'The Wizard · airtight tactics, the best safety and snooker play',
      style: 'strong', depth: 3, budget: 1800, ticks: 2300, topCands: 40, spinCands: 8, useSpin: true,
      noise: 0.000105, powerErr: 0.0021, fluff: 0.045, maxCut: 1.30, pickSafetyAbove: 1.20,
      colorBias: 1.4, blackBias: 1.2, positionW: 1.18, comfortW: 1.25,
      safetyThorough: 1.6, pace: 1.05, deepSearch: true, flair: 0.08,
    },
    trump: {
      key: 'trump', name: 'Judd Trump',
      desc: 'Long-game shot maker · flamboyant potting, heavy screw, careless safety',
      style: 'strong', depth: 3, budget: 1800, ticks: 2160, topCands: 32, spinCands: 6, useSpin: true,
      noise: 0.00015, powerErr: 0.0030, fluff: 0.07, maxCut: 1.38, pickSafetyAbove: Infinity,
      colorBias: 1.8, blackBias: 1.7, positionW: 0.78, comfortW: 1.4,
      safetyThorough: 0.4, pace: 0.7, deepSearch: true, aggressive: true, flair: 0.22,
    },
    ding: {
      key: 'ding', name: 'Ding Junhui',
      desc: 'The Dragon · silky cue ball control, precise position, heavy scoring',
      style: 'strong', depth: 3, budget: 1800, ticks: 2160, topCands: 38, spinCands: 9, useSpin: true,
      noise: 0.000114, powerErr: 0.0024, fluff: 0.05, maxCut: 1.34, pickSafetyAbove: 1.32,
      colorBias: 1.6, blackBias: 1.5, positionW: 1.28, comfortW: 1.25,
      safetyThorough: 0.9, pace: 0.95, deepSearch: true, flair: 0.12,
    },
    selby: {
      key: 'selby', name: 'Mark Selby',
      desc: 'The Jester · slow grind, counter-punching, drags opponents into the mud',
      style: 'strong', depth: 3, budget: 1800, ticks: 2300, topCands: 40, spinCands: 7, useSpin: true,
      noise: 0.000135, powerErr: 0.0027, fluff: 0.05, maxCut: 1.28, pickSafetyAbove: 1.15,
      colorBias: 1.3, blackBias: 1.1, positionW: 1.22, comfortW: 1.3,
      safetyThorough: 1.7, pace: 1.5, deepSearch: true, defensive: true, flair: 0.06,
    },
  };
  const LEVELS = PROFILES;    // 旧代码用 LEVELS 这个名字，保留别名

  function decideEasy(state, balls) {
    const targets = R.legalTargets(state, balls);
    const cue = findCue(balls);
    if (!cue || !targets.length) return fallbackShot(state, balls);
    const t = targets[(Math.random() * targets.length) | 0];
    // 朝目标球打，但角度误差 ±4°、力度随机 —— 新手经常打不进
    const base = Math.atan2(t.y - cue.y, t.x - cue.x);
    const angle = base + (Math.random() - 0.5) * 0.14;
    return {
      shot: {
        angle: angle,
        power: C.clamp(6 + Math.random() * 11, 3, C.MAX_POWER),
        spinX: (Math.random() - 0.5) * 0.5,
        spinY: (Math.random() - 0.5) * 0.5,
      },
      kind: 'random',
      reason: 'Playing on feel',
    };
  }

  function decideMedium(state, balls) {
    const targets = R.legalTargets(state, balls);
    const cue = findCue(balls);
    if (!cue || !targets.length) return fallbackShot(state, balls);

    const cands = candidatesFor(balls, targets, cue).slice(0, 6);
    if (!cands.length) return fallbackShot(state, balls);

    const cand = cands[(Math.random() * Math.min(3, cands.length)) | 0];
    const p0 = estimatePower(cand.dist, cand.pocketDist, cand.cut);
    const power = C.clamp(p0 * (0.9 + Math.random() * 0.3), 2, C.MAX_POWER);
    // ±0.8° 误差：能打进大部分球，但薄球和长台会丢
    const angle = cand.angle + (Math.random() - 0.5) * 0.028;
    return {
      shot: { angle: angle, power: power, spinX: (Math.random() - 0.5) * 0.3, spinY: (Math.random() - 0.5) * 0.3 },
      kind: 'pot',
      reason: 'Taking the easiest pot',
    };
  }

  // 出杆执行误差：搜到的杆法是对的，但人是会抖的。
  // 大师/高手 noise = 0 —— 准度无限，模拟说进就一定进。
  //
  // 误差量级是量出来的，不是拍脑袋定的：
  //   力度误差会 1:1 变成目标球行程误差（行程 ∝ 速度²），
  //   而 estimatePower 只留了约 20px（≈1 个球半径）的到袋余量。
  //   所以 σ(power) 到 2.7% 时，一半的进球会"差一点没到袋口"——
  //   实测进攻成功率会掉到 38%，那是业余水准，不是职业球员。
  //   职业选手的力度控制误差在 1% 以内，这里照这个量级取。
  // fluff：偶尔一次没打实/打厚。真实球员不是匀速失误的，
  //   是绝大多数杆又准又稳、偶尔丢一杆手感——用它来产生"该破百却断在 60"的效果。
  function applyHumanError(shot, prof, scale) {
    if (!prof || ((!prof.noise) && (!prof.powerErr))) return shot;
    const tri = () => Math.random() - Math.random();   // 近似正态，σ≈0.41
    const out = { angle: shot.angle, power: shot.power, spinX: shot.spinX, spinY: shot.spinY };
    const s = scale === undefined ? 1 : scale;
    let ka = (prof.noise ? prof.noise * 2.4 : 0) * s;
    let kp = (prof.powerErr ? prof.powerErr * 2.2 : 0) * s;
    if (prof.fluff && Math.random() < prof.fluff) { ka *= 4.0; kp *= 3.0; }
    if (ka) out.angle += tri() * ka;
    if (kp) out.power = C.clamp(out.power * (1 + tri() * kp), 1.5, C.MAX_POWER);
    return out;
  }

  // 防守杆的误差缩放（见下方调用点）。
  //   进攻杆的 noise 是**照着"差一点就进/不进"标定**的：方向偏一点的结果是"没进"，
  //   球权交出去而已，观感正确。但同一个噪声量级套在**防守杆**上，后果完全不同：
  //   安全球很多是薄擦球堆边缘或极薄的接触，偏一点点就变成"空杆/先碰到别的球"，
  //   直接送 4 分自由球——这是最不像职业球员的一种失误。
  //   实测（6 局/画像，犯规归因）：犯规定 10 次来自防守、只有 2 次来自进攻，
  //   塞尔比 5 次犯规里 4 次是防守。
  //   1.0 缩到 0.35：保留"偶尔做球不到位"，去掉"动不动空杆"。
  const SAFE_ERR = 0.35;

  // 要在常规搜索失败后再"广撒网"找球吗？
  //   147 大师（desperate）和职业球员（deepSearch）都要——他们不会轻易放弃进攻；
  //   难度档里的高手也开，业余/新手走的是另一条代码路径。
  function chases(state, prof) {
    return !!(prof && (prof.desperate || prof.deepSearch));
  }

  function cfgFor(prof, deadline) {
    return {
      deadline: deadline,
      topCands: prof.topCands || 32,
      spinCands: prof.spinCands || 0,
      useSpin: !!prof.useSpin,
      maxCut: prof.maxCut,
      // 瞄准余量只对**有出杆误差**的画像生效：
      //   它是用来对冲"差一点就擦到别的球"的，准度无限的档位没有这个风险，
      //   加上去反而会把这些档位的选球自由度削掉（实测"高手"单杆 97 → 39）。
      aimClear: (prof.noise || prof.powerErr) ? AIM_CLEAR : 0,
      colorBias: prof.colorBias,
      blackBias: prof.blackBias,
      positionW: prof.positionW,
      comfortW: prof.comfortW || 0,
      branch: prof.branch || 6,
      // 递归里每一层都要知道"根有多深"，才能算出自己离根多远（候选网收缩用）。
      // 不写这个的话递归调用会把 depth 当成根深度，候选网永远满配。
      rootDepth: prof.depth || 1,
    };
  }

  // "广撒网"两轮的配置。同步路径和 worker 分片路径共用，避免两边参数漂移。
  function wideCfgFor(prof, cfg, deadline, phase) {
    const base = {
      deadline: deadline,
      allCands: true,
      rootDepth: 1,
      maxCut: 1.45,                     // 比 78° 再薄一点也认
      useSpin: false,
      aimClear: cfg.aimClear,
      colorBias: prof.colorBias,
      blackBias: prof.blackBias,
      positionW: prof.positionW,
      comfortW: prof.comfortW || 0,
    };
    if (phase === 1) {
      base.powerMults = [0.8, 1.0, 1.2, 1.45, 1.8];
      base.perCand = 4;
    } else {
      base.topCands = 20;
      base.powerMults = [0.85, 1.0, 1.2, 1.5, 1.9];
      base.perCand = 6;
      base.angles = WIDE_AIM;
    }
    return base;
  }

  function decideStrong(state, balls, prof, budgetMs) {
    const deadline = now() + budgetMs;
    const cfg = cfgFor(prof, deadline);
    // 连续几杆没进球：不再满足于"没机会就做斯诺克"，必须把能想到的
    // 进球线路全部试一遍。见 forcedPot() 的注释。
    const force = !!(state.forcePot || (state.noPotStreak || 0) >= 3);

    let best = null;
    try {
      best = searchBest(state, balls, prof.depth || 1, cfg, true);
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('AI 搜索异常', e);
    }

    // ---- 不顾一切：常规搜索没捞到球，再来一轮"广撒网" ----
    //   放宽切角、穷举全部候选、加更多力度档、允许先撞库。
    //   147 大师靠这一轮做到"只要几何上有一丝可能就绝不放弃进球"。
    if (!force && chases(state, prof) && !(best && best.entry.verdict.points > 0)) {
      const extra = now() + Math.max(150, budgetMs * 0.45);
      // 第 1 轮：广撒网 —— 穷举所有候选，窄角速扫，先捞到"确认能进"的
      let wide = null;
      try {
        wide = searchBest(state, balls, 1, wideCfgFor(prof, cfg, extra, 1), true);
      } catch (e) { /* 忽略：这只是加强项 */ }

      // 第 2 轮：瞄准细找 —— 候选少而精，但角度扫得宽。
      //   理论幽灵点偏半个球径就打不着，长台尤其明显；这一轮专门补它。
      //   topCands 写 20 是**旧行为**：这里 depth 给 1，本来就会按"离根一格"
      //   减半（40 → 20），而那正是这句注释说的"少而精"。候选网改成按
      //   离根距离收缩之后，这层不再自动减半，所以把 20 写死，别让它悄悄翻倍
      //   （翻倍会同时改掉决策和耗时，A/B 就不可比了）。
      if (!(wide && wide.entry.verdict.points > 0)) {
        try {
          wide = searchBest(state, balls, 1,
            wideCfgFor(prof, cfg, now() + Math.max(120, budgetMs * 0.35), 2), true);
        } catch (e) { /* 忽略 */ }
      }
      if (wide && wide.entry.verdict.points > 0) best = wide;
    }

    // 有出杆误差的画像：按"成功率 × 价值"重排，别去捡贴容差边的球。
    // 准度无限的档位（noise=0）跳过——它打哪杆都是必进，不用打折。
    if (best && best.top && (prof.noise || prof.powerErr)) {
      try { best = rerankRobust(state, balls, best.top, prof) || best; }
      catch (e) { /* 验算失败就退回原来的选择 */ }
    }

    if (best && best.entry.verdict.points > 0) {
      const ball = best.entry.cand.ball;
      const cut = best.entry.cand.cut;
      // 真实球员会挑球：太薄的机会，防守型选手宁可先做一杆。
      // 但连续不进之后，连最保守的画像也要接受薄球——先止住"只会做球"。
      if (force || !(cut > prof.pickSafetyAbove)) {
        return {
          shot: applyHumanError(best.entry.shot, prof),
          kind: 'pot',
          reason: force
            ? `Must score · ${C.COL_CN[ball.label] || ''} for ${best.entry.verdict.points}`
            : prof.desperate
              ? `Chasing 147 · ${C.COL_CN[ball.label] || ''} for ${best.entry.verdict.points}`
              : `Potting the ${C.COL_CN[ball.label] || ''}`,
          value: best.value,
          spinName: best.entry.spinName,
        };
      }
    }

    // ---- 连续不进：强制把所有进球线路试一遍 ----
    //  直达薄球、加塞、翻袋、组合球、白球一库。全部真实模拟验证。
    if (force) {
      const fp = forcedPot(state, balls, Math.max(700, budgetMs * 0.9));
      if (fp) return fp;
    }

    // ---- 被斯诺克 → 先尝试多库解球，再考虑做斯诺克 ----
    // 现实球员的第一反应是绕库解到目标，而不是继续磨安全球。
    if (!hasDirectLine(state, balls)) {
      try {
        const escape = flairEscape(state, balls, prof);
        if (escape) return escape;
      } catch (e) { /* 解不到再走安全球 */ }
    }

    // ---- 打不进 → 做斯诺克（尽可能做到零漏球）----
    const safe = safetySearch(state, balls, {
      deadline: now() + budgetMs * (prof.safetyThorough >= 1.2 ? 1.3 : 1.0),
      safetyThorough: prof.safetyThorough,
    });
    if (safe) {
      return {
        shot: applyHumanError(safe.entry.shot, prof, SAFE_ERR),
        kind: 'safety',
        reason: safe.snookered
          ? 'Tight snooker · opponent must go off cushions'
          : 'Nothing on · playing safe',
        value: safe.value,
        spinName: safe.entry.spinName,
      };
    }

    const fb = fallbackShot(state, balls);
    fb.shot = applyHumanError(fb.shot, prof, SAFE_ERR);
    fb.reason = 'No pot and no safe shot available';
    return fb;
  }

  // ----------------------------------------------------------------
  //  多线程支持：把一次搜索按根层候选切成片，worker 之间只传纯数据。
  //
  //  packEntry 只保留"选杆真正需要的字段"，不把整个模拟世界（finalBalls、
  //  paths、Ball 实例）结构化克隆回去 —— 那会让 postMessage 的代价超过计算本身。
  // ----------------------------------------------------------------
  function hydrateBalls(data) {
    const out = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const s = data[i];
      const b = new C.Ball(s.x, s.y, s.label);
      b.vx = s.vx || 0; b.vy = s.vy || 0;
      b.wx = s.wx || 0; b.wy = s.wy || 0; b.wz = s.wz || 0;
      b.sx = s.sx || 0; b.sy = s.sy || 0;
      b.active = s.active !== false;
      b.potted = !!s.potted;
      b.__i = i;
      out[i] = b;
    }
    return out;
  }

  function packEntry(e) {
    if (!e || !e.entry) return null;
    const en = e.entry;
    return {
      value: e.value,
      kind: e.kind,
      sub: null,
      entry: {
        shot: en.shot,
        tIdx: en.tIdx,
        cueIdx: en.cueIdx,
        spinName: en.spinName || null,
        cand: {
          cut: en.cand ? en.cand.cut : 0,
          ball: { label: en.cand && en.cand.ball ? en.cand.ball.label : '' },
        },
        verdict: { points: en.verdict ? en.verdict.points : 0 },
      },
    };
  }

  function packBest(best) {
    if (!best) return null;
    return {
      best: packEntry(best),
      top: (best.top || []).map(packEntry).filter(Boolean),
    };
  }

  // worker 入口：mode = 'normal' | 'wide1' | 'wide2'
  function searchSlice(state, ballsData, level, budgetMs, index, total, mode) {
    const prof = PROFILES[level] || PROFILES.master;
    const balls = hydrateBalls(ballsData);
    const deadline = now() + budgetMs;

    if (mode === 'force') {
      return { forced: forcedPot(state, balls, budgetMs) };
    }

    if (mode === 'safety') {
      const sBudget = budgetMs * (prof.safetyThorough >= 1.2 ? 1.3 : 1.0);
      const safe = safetySearch(state, balls, {
        deadline: now() + sBudget,
        safetyThorough: prof.safetyThorough,
        safetySlice: { index: index, total: total },
      });
      return {
        packed: null,
        safety: safe ? {
          value: safe.value,
          snookered: !!safe.snookered,
          shot: safe.entry.shot,
          spinName: safe.entry.spinName || null,
        } : null,
      };
    }

    let cfg, depth;
    if (mode === 'wide1' || mode === 'wide2') {
      const base = cfgFor(prof, deadline);
      cfg = wideCfgFor(prof, base, deadline, mode === 'wide1' ? 1 : 2);
      depth = 1;
    } else {
      cfg = cfgFor(prof, deadline);
      depth = prof.depth || 1;
    }
    cfg.rootCandSlice = { index: index, total: total };
    const best = searchBest(state, balls, depth, cfg, true);
    return { packed: packBest(best), timedOut: !!cfg.timedOut };
  }

  function decisionFromBest(best, prof, force) {
    if (!best || !best.entry || !best.entry.verdict || best.entry.verdict.points <= 0) return null;
    const cut = best.entry.cand ? best.entry.cand.cut : 0;
    if (!force && cut > prof.pickSafetyAbove) return null;
    const ball = best.entry.cand && best.entry.cand.ball ? best.entry.cand.ball.label : '';
    return {
      shot: applyHumanError(best.entry.shot, prof),
      kind: 'pot',
      reason: force
        ? `Must score · ${C.COL_CN[ball] || ''} for ${best.entry.verdict.points}`
        : prof.desperate
          ? `Chasing 147 · ${C.COL_CN[ball] || ''} for ${best.entry.verdict.points}`
          : `Potting the ${C.COL_CN[ball] || ''}`,
      value: best.value,
      spinName: best.entry.spinName,
    };
  }

  // 没有进球时的安全球/兜底。同步路径和多线程路径共用。
  function safetyOrFallback(state, ballsData, level, budgetMs) {
    const prof = PROFILES[level] || PROFILES.master;
    const balls = hydrateBalls(ballsData);
    const safe = safetySearch(state, balls, {
      deadline: now() + budgetMs * (prof.safetyThorough >= 1.2 ? 1.3 : 1.0),
      safetyThorough: prof.safetyThorough,
    });
    if (safe) {
      return {
        shot: applyHumanError(safe.entry.shot, prof, SAFE_ERR),
        kind: 'safety',
        reason: safe.snookered
          ? 'Tight snooker · opponent must go off cushions'
          : 'Nothing on · playing safe',
        value: safe.value,
        spinName: safe.entry.spinName,
      };
    }
    const fb = fallbackShot(state, balls);
    fb.shot = applyHumanError(fb.shot, prof, SAFE_ERR);
    fb.reason = 'No pot and no safe shot available';
    return fb;
  }

  // 合并多个 worker 的安全球结果：优先"真斯诺克"，再按价值。
  function safetyDecisionFromParts(parts, prof) {
    let pick = null;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p || !p.shot) continue;
      if (!pick) { pick = p; continue; }
      if (p.snookered && !pick.snookered) { pick = p; continue; }
      if (p.snookered === pick.snookered && p.value > pick.value) pick = p;
    }
    if (!pick) return null;
    return {
      shot: applyHumanError(pick.shot, prof, SAFE_ERR),
      kind: 'safety',
      reason: pick.snookered
        ? 'Tight snooker · opponent must go off cushions'
        : 'Nothing on · playing safe',
      value: pick.value,
      spinName: pick.spinName,
    };
  }

  // 最后的兜底：只跑 fallbackShot，不再重复整轮安全球搜索。
  function fallbackOnly(state, ballsData, level) {
    const prof = PROFILES[level] || PROFILES.master;
    const balls = hydrateBalls(ballsData);
    const fb = fallbackShot(state, balls);
    fb.shot = applyHumanError(fb.shot, prof, SAFE_ERR);
    fb.reason = 'No pot and no safe shot available';
    return fb;
  }

  // ================================================================
  //  观赏性"花活"：偶尔拼一杆多库解球
  //
  //  纯最优化 AI 每一杆都走最稳的线路，看久了像机器。这里给一个很小的
  //  随机概率（抢黑时更高），主动搜几杆"先撞库再碰到目标球"的线路。
  //  仍然要求首触合法、白球不落袋、不碰进非目标球，所以不会故意犯规。
  // ================================================================
  function flairEscape(state, balls, prof) {
    const cue = findCue(balls);
    if (!cue || !cue.isOnTable()) return null;
    const targets = R.legalTargets(state, balls);
    if (!targets.length) return null;
    const legal = {};
    for (let i = 0; i < targets.length; i++) legal[targets[i].label] = true;

    const powers = [10, 16, 24];
    const spinsX = [-0.45, 0, 0.45];
    const spinsY = [0, 0.4];
    let best = null, bestScore = -Infinity;

    for (let ai = 0; ai < 24; ai++) {
      const angle = ai / 24 * Math.PI * 2;
      for (let pi = 0; pi < powers.length; pi++) {
        for (let xi = 0; xi < spinsX.length; xi++) {
          for (let yi = 0; yi < spinsY.length; yi++) {
            const shot = { angle: angle, power: powers[pi], spinX: spinsX[xi], spinY: spinsY[yi] };
            const res = S.simulateShot(balls, shot, { track: false });
            if (!res.ok || res.aborted || res.cuePotted) continue;
            if (!res.firstContactLabel || !legal[res.firstContactLabel]) continue;
            let bad = false;
            for (let k = 0; k < res.pottedLabels.length; k++) {
              if (!legal[res.pottedLabels[k]]) bad = true;
            }
            if (bad) continue;
            if (!res.bounces) continue;              // 必须是先撞库的线路
            const cf = res.finalBalls[res.cueIdx];
            if (!cf || !cf.isOnTable()) continue;
            let near = Infinity;
            for (let bi = 0; bi < res.finalBalls.length; bi++) {
              const b = res.finalBalls[bi];
              if (bi === res.cueIdx || !b.isOnTable()) continue;
              const d = Math.hypot(b.x - cf.x, b.y - cf.y);
              if (d < near) near = d;
            }
            let score = Math.min(res.bounces, 4) * 1200 + Math.min(near, 500) * 1.4;
            if (res.pottedLabels.length) score += 2600;
            score += Math.random() * 220;            // 同分线路之间也换着来
            if (score > bestScore) {
              bestScore = score;
              best = {
                shot: shot,
                bounces: res.bounces,
                potted: res.pottedLabels.length > 0,
              };
            }
          }
        }
      }
    }

    if (!best) return null;
    return {
      shot: best.shot,
      kind: best.potted ? 'pot' : 'safety',
      reason: (best.potted ? 'Flair pot · ' : 'Flair escape · ') + best.bounces + ' cushion' + (best.bounces > 1 ? 's' : ''),
      value: bestScore,
    };
  }

  function maybeFlair(decision, state, balls, level) {
    if (!decision || decision.kind !== 'safety' || !state || state.opening) return decision;
    const prof = PROFILES[level] || PROFILES.master;
    let chance = prof.flair === undefined ? 0.12 : prof.flair;
    if (state.isRespottedBlack) chance *= 2.2;
    chance += Math.min(0.15, (state.negativeStreak || 0) * 0.03);
    if (Math.random() >= chance) return decision;
    const f = flairEscape(state, balls, prof);
    return f || decision;
  }

  // ----------------------------------------------------------------
  //  8-ball：简化但可靠的进球搜索
  //  只处理"合法首碰 + 进球"，不做斯诺克式的多层走位搜索。
  // ----------------------------------------------------------------
  function decidePool(state, balls, prof, budgetMs) {
    const cue = findCue(balls);
    const targets = R.legalTargets(state, balls);
    if (!cue || !cue.isOnTable() || !targets.length) return fallbackShot(state, balls);

    // 8-ball 开球：正对球堆顶点送一杆，先把球散开
    if (state.opening) {
      let apex = targets[0];
      for (let i = 1; i < targets.length; i++) {
        const a = targets[i], b = apex;
        const da = Math.hypot(a.x - cue.x, a.y - cue.y);
        const db = Math.hypot(b.x - cue.x, b.y - cue.y);
        if (da < db) apex = a;
      }
      return {
        shot: { angle: Math.atan2(apex.y - cue.y, apex.x - cue.x), power: 22, spinX: 0, spinY: 0.15 },
        kind: 'safety',
        reason: (state.mode === 'nineball' ? '9-ball break' : '8-ball break'),
      };
    }

    const cfg = {
      deadline: now() + Math.max(250, budgetMs || 900),
      maxCands: prof.topCands || 30,
      powerMults: [0.9, 1.08, 1.3],
      perCand: 2,
      maxCut: prof.maxCut || 1.25,
      angles: BASE_ANGLES,
      aimClear: 0,
    };
    const entries = potPass(state, balls, targets, cfg);
    let best = null;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e.verdict || e.verdict.points <= 0) continue;
      const value = e.verdict.points + (e.verdict.gameOver ? 100 : 0);
      if (!best || value > best.value) best = { value: value, e: e };
    }
    if (best) {
      return {
        shot: best.e.shot,
        kind: 'pot',
        reason: best.e.verdict.gameOver ? 'Potting the 8-ball' : 'Potting a ball',
        value: best.value,
      };
    }
    // 连续没进球：池球同样允许翻袋、组合球、加塞，先把球打进去
    if (state.forcePot || (state.noPotStreak || 0) >= 3) {
      const fp = forcedPot(state, balls, Math.max(350, (budgetMs || 900) * 0.8));
      if (fp) return fp;
    }
    // 池球被挡住时，也先试多库解球，再退到普通安全球
    if (!hasDirectLine(state, balls)) {
      const escape = flairEscape(state, balls, prof);
      if (escape) return escape;
    }
    return fallbackShot(state, balls);
  }

  // ----------------------------------------------------------------
  //  对外入口
  // ----------------------------------------------------------------
  function decide(state, balls, opts) {
    opts = opts || {};
    if (state && (state.mode === 'eightball' || state.mode === 'nineball')) {
      const prof = PROFILES[opts.level] || PROFILES.master;
      const budget = (opts.budgetMs === undefined || opts.budgetMs === null) ? (prof.budget || 900) : opts.budgetMs;
      return decidePool(state, balls, prof, budget);
    }
    // 第一杆走专门的开球逻辑，不让安全球搜索把白球贴进红球堆
    if (state && state.opening) {
      const br = breakOff(state, balls);
      if (br) return br;
    }
    const key = PROFILES[opts.level] ? opts.level : 'master';
    const prof = PROFILES[key];
    // 正式跑用毫秒预算；虚拟时钟下用 ticks（= 允许模拟多少杆）。
    // ticks 是拿 prof.budget 实测标定出来的：master 700ms ≈ 1324 杆模拟。
    const budget = (opts.budgetMs === undefined || opts.budgetMs === null)
      ? (clockVirtual ? (prof.ticks || prof.budget) : prof.budget)
      : opts.budgetMs;

    let decision;
    if (prof.style === 'random') decision = decideEasy(state, balls);
    else if (prof.style === 'aim') decision = decideMedium(state, balls);
    else decision = decideStrong(state, balls, prof, budget);
    return maybeFlair(decision, state, balls, key);
  }

  // 出杆节奏（给主循环做延时用）：奥沙利文快、塞尔比慢
  function paceOf(level) {
    const p = PROFILES[level];
    return (p && p.pace) || 1;
  }

  SNK.ai = {
    LEVELS: LEVELS,
    PROFILES: PROFILES,
    // 虚拟时钟开关：测试用。开着的时候 budgetMs 的含义变成"允许模拟多少杆"，
    // 决策完全可复现（同局面同预算 → 同结果），机器忙不忙都一样。
    setVirtualClock: setVirtualClock,
    clockTicks: function () { return clockTicks; },
    decide: decide,
    paceOf: paceOf,
    // ---- 多线程（js/ai-pool.js 用）----
    searchSlice: searchSlice,
    breakOff: breakOff,
    forcedPot: forcedPot,
    flairEscape: flairEscape,
    maybeFlair: maybeFlair,
    hydrateBalls: hydrateBalls,
    packBest: packBest,
    decisionFromBest: decisionFromBest,
    safetySearch: safetySearch,
    safetyOrFallback: safetyOrFallback,
    safetyDecisionFromParts: safetyDecisionFromParts,
    fallbackOnly: fallbackOnly,
    rerankRobust: rerankRobust,
    applyHumanError: applyHumanError,
    candidatesFor: candidatesFor,
    estimatePower: estimatePower,
    geomPot: geomPot,
    opponentView: opponentView,
    snookerScore: snookerScore,
    advanceWorld: advanceWorld,
    nextStateOf: nextStateOf,
    judgeShot: judgeShot,
    SPIN_PRESETS: SPIN_PRESETS,
  };
})(window.SNK = window.SNK || {});
