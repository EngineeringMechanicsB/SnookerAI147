// ================================================================
//  selftest.js — 自检 / 论证脚本
//
//  浏览器打开 index.html?selftest=1 即运行，结果打印在控制台。
//
//  它回答的核心问题是：**AI 说这杆能进，是不是真的能进？**
//  做法：让 AI 决策 → 拿它给出的杆法**独立重跑一遍模拟** → 用裁判
//  重新判定 → 对比 AI 的声称。因为物理和规则都只有一份实现，这个
//  对比是可信的；任何"AI 判断标准和实际结算不一致"的 bug 都会当场暴露。
//
//  另外还测：单杆清台能力（147 路线）、决策耗时、防守出杆比例。
// ================================================================
(function (SNK) {
  'use strict';

  const C = SNK;
  const R = C.rules;

  function param(name, dflt) {
    const m = new RegExp('[?&]' + name + '=([^&]+)').exec(location.search);
    return m ? Number(m[1]) : dflt;
  }

  // ================================================================
  //  随机局面生成
  // ================================================================
  function randInTable(margin) {
    const m = margin === undefined ? C.BALL_R + 2 : margin;
    return {
      x: C.L + m + Math.random() * (C.TABLE_W - m * 2),
      y: C.T + m + Math.random() * (C.TABLE_H - m * 2),
    };
  }

  function farFromPockets(x, y) {
    for (const p of C.pockets) {
      if (Math.hypot(p.x - x, p.y - y) < C.POCKET_R + C.BALL_R * 2.5) return false;
    }
    return true;
  }

  function scatter(balls, count, label) {
    let placed = 0, guard = 0;
    while (placed < count && guard < 4000) {
      guard++;
      const p = randInTable(C.BALL_R + 4);
      if (!farFromPockets(p.x, p.y)) continue;
      if (C.ballOverlaps(balls, p.x, p.y, null, 3)) continue;
      balls.push(new C.Ball(p.x, p.y, label));
      placed++;
    }
    return placed;
  }

  // 经典模式随机散局
  function randomClassicLayout() {
    const balls = [];
    const cue = new C.Ball(C.CUE_START.x, C.CUE_START.y, 'white');
    balls.push(cue);
    scatter(balls, 3 + ((Math.random() * 13) | 0), 'red');   // 3~15 颗红球
    const colors = C.COL_ORDER.slice(0, 3 + ((Math.random() * 4) | 0));
    for (const label of colors) {
      let ok = false, g = 0;
      while (!ok && g < 300) {
        g++;
        const p = randInTable(C.BALL_R + 4);
        if (!farFromPockets(p.x, p.y)) continue;
        if (C.ballOverlaps(balls, p.x, p.y, null, 3)) continue;
        balls.push(new C.Ball(p.x, p.y, label));
        ok = true;
      }
    }
    return balls;
  }

  // 标准开球台面
  function standardRack() {
    const balls = [];
    const cue = new C.Ball(C.CUE_START.x, C.CUE_START.y, 'white');
    balls.push(cue);
    const apexX = C.PINK_X + C.BALL_D + 1;
    const rowStep = Math.round(Math.sqrt(3) / 2 * C.BALL_D * 100) / 100;
    for (let row = 0; row < 5; row++) {
      const rx = apexX + row * rowStep;
      for (let col = 0; col <= row; col++) {
        balls.push(new C.Ball(rx, C.CY2 + (col - row / 2) * C.BALL_D, 'red'));
      }
    }
    for (const label of C.COL_ORDER) {
      const pos = C.getColorPos(label);
      if (pos) balls.push(new C.Ball(pos.x, pos.y, label));
    }
    C.separateBalls(balls);
    return balls;
  }

  function freshState(balls, mode) {
    return {
      mode: mode || 'classic',
      isRespottedBlack: false,
      needRed: R.countOnTable(balls, 'red') > 0,
      pottedRedThisTurn: false,
      currentPlayer: 0,
      scores: [0, 0],
    };
  }

  // ================================================================
  //  测试 A：决策声称 vs 独立复现
  // ================================================================
  function testConsistency(n, budget) {
    const stats = { total: 0, pot: 0, safety: 0, fallback: 0, mismatch: 0, illegalPot: 0, errors: 0 };
    const mismatches = [];

    for (let i = 0; i < n; i++) {
      const balls = randomClassicLayout();
      const st = freshState(balls);
      if (!R.legalTargets(st, balls).length) continue;

      let d;
      try {
        d = C.ai.decide(st, balls, { level: 'master', budgetMs: budget });
      } catch (e) {
        stats.errors++;
        mismatches.push('决策抛异常: ' + e.message);
        continue;
      }
      stats.total++;

      // —— 独立复现：重新克隆、重新打、重新判 ——
      const replay = C.sim.simulateAndJudge(st, balls, d.shot);
      const v = replay.verdict;

      if (d.kind === 'pot') {
        stats.pot++;
        if (!v || !v.legal || v.points <= 0) {
          stats.illegalPot++;
          stats.mismatch++;
          mismatches.push(`声称进球但复现为 ${v ? (v.legal ? '得分 ' + v.points : '犯规:' + v.foulReason) : '异常'}`);
        }
      } else if (d.kind === 'safety') {
        stats.safety++;
        if (!v || !v.legal || v.points > 0) {
          stats.mismatch++;
          mismatches.push(`声称防守但复现为 ${v ? (v.legal ? '得分 ' + v.points : '犯规:' + v.foulReason) : '异常'}`);
        }
      } else {
        stats.fallback++;
      }
    }
    return { stats: stats, mismatches: mismatches };
  }

  // ================================================================
  //  测试 B：无头对局 —— 大师从标准开球台面能打到多少分
  // ================================================================
  function stepGame(g, level, budget) {
    const st = g.state;
    const targets = R.legalTargets(st, g.balls);
    if (!targets.length) return { over: true };

    let d;
    try {
      d = C.ai.decide(st, g.balls, { level: level, budgetMs: budget });
    } catch (e) {
      return { error: e.message };
    }

    const sim = C.sim.simulateAndJudge(st, g.balls, d.shot);
    const v = sim.verdict;
    if (!v) return { error: 'no verdict' };

    const p = st.currentPlayer;
    if (v.points > 0) {
      g.scores[p] += v.points;
      g.break += v.points;
      if (g.break > g.maxBreak) g.maxBreak = g.break;
    }
    if (v.penalty > 0) g.scores[1 - p] += v.penalty;

    g.balls = C.ai.advanceWorld(sim.res, v);

    if (v.gameOver) return { over: true, winner: v.winner };

    if (v.turnContinues) {
      g.state = Object.assign({}, st, {
        needRed: v.nextNeedRed,
        pottedRedThisTurn: v.nextPottedRedThisTurn,
      });
      g.visits++;
    } else {
      g.break = 0;
      g.state = Object.assign({}, st, {
        currentPlayer: 1 - p,
        needRed: R.countOnTable(g.balls, 'red') > 0,
        pottedRedThisTurn: false,
      });
    }
    return { decision: d, verdict: v };
  }

  function testClearance(maxShots, budget) {
    const g = {
      balls: standardRack(),
      state: null,
      scores: [0, 0],
      break: 0,
      maxBreak: 0,
      visits: 0,
    };
    g.state = freshState(g.balls);

    let shots = 0, fouls = 0;
    while (shots < maxShots) {
      const before = g.scores[0] + g.scores[1];
      const r = stepGame(g, 'master', budget);
      if (r.error) return { error: r.error, shots: shots };
      if (r.verdict && !r.verdict.legal) fouls++;
      shots++;
      if (r.over) break;
      // 死循环保护：连续 300 杆没有任何分数变化
      if (shots > 300 && g.scores[0] + g.scores[1] === before) break;
    }
    return {
      shots: shots,
      fouls: fouls,
      maxBreak: g.maxBreak,
      scores: g.scores,
      redsLeft: R.countOnTable(g.balls, 'red'),
      colorsLeft: C.COL_ORDER.filter(l => R.countOnTable(g.balls, l) > 0),
      cleared: R.countOnTable(g.balls, 'red') === 0 &&
               C.COL_ORDER.every(l => R.countOnTable(g.balls, l) === 0),
    };
  }

  // ================================================================
  //  测试 C：决策耗时
  // ================================================================
  function testTiming(n, budget) {
    const out = {};
    for (const level of ['easy', 'medium', 'hard', 'master']) {
      let total = 0, max = 0, cnt = 0;
      for (let i = 0; i < n; i++) {
        const balls = randomClassicLayout();
        const st = freshState(balls);
        if (!R.legalTargets(st, balls).length) continue;
        const t0 = performance.now();
        try { C.ai.decide(st, balls, { level: level, budgetMs: budget }); } catch (e) { /* 忽略 */ }
        const dt = performance.now() - t0;
        total += dt; max = Math.max(max, dt); cnt++;
      }
      out[level] = { avg: cnt ? +(total / cnt).toFixed(1) : 0, max: +max.toFixed(1), n: cnt };
    }
    return out;
  }

  // ================================================================
  //  测试 D：防守质量 —— 打完整局，看它到底多久把对手封死一次
  //
  //  （早先版本是手工摆一坨红球，结果被 separateBalls 打散，测的是
  //  测试自己构造得对不对，不是 AI。改成打真局、赛后统计。）
  // ================================================================
  function testSafety(games, budget) {
    const out = { games: 0, shots: 0, fouls: 0, zeroLines: 0, oneLine: 0, sumLines: 0 };
    for (let gi = 0; gi < games; gi++) {
      const g = { balls: standardRack(), state: null, scores: [0, 0], break: 0, maxBreak: 0 };
      g.state = freshState(g.balls);
      out.games++;

      for (let s = 0; s < 200; s++) {
        const r = stepGame(g, 'master', budget);
        if (r.error || r.over) break;
        out.shots++;
        if (r.verdict && !r.verdict.legal) out.fouls++;

        // 这一杆打完，接手的对手还有几条进球线路？
        const reds = R.countOnTable(g.balls, 'red');
        const oppState = {
          mode: 'classic', isRespottedBlack: false,
          needRed: reds > 0, pottedRedThisTurn: false,
        };
        const lines = C.ai.geomPot(g.balls, R.legalTargets(oppState, g.balls), reds === 0).count;
        out.sumLines += lines;
        if (lines === 0) out.zeroLines++;        // 完全无球可下 = 真斯诺克
        else if (lines === 1) out.oneLine++;

        const cleared = R.countOnTable(g.balls, 'red') === 0 &&
                        C.COL_ORDER.every(l => R.countOnTable(g.balls, l) === 0);
        if (cleared) break;
      }
    }
    out.avgLines = out.shots ? +(out.sumLines / out.shots).toFixed(2) : 0;
    out.zeroRate = out.shots ? +(out.zeroLines / out.shots * 100).toFixed(1) : 0;
    return out;
  }

  // ================================================================
  //  测试 F：斯诺克质量 —— 做出来的球到底有没有"漏球"
  //
  //  对每一杆防守，看**对手接手时的局面**：
  //    potLines  = 0  → 一颗球都打不进（真正的"没漏球"）
  //    hitLines  = 0  → 连直击都够不到，只能撞库解球
  //  两个都 0 就是用户要的效果：对手只能选几库去解。
  // ================================================================
  function testSnooker(level, games, budget, maxShots) {
    maxShots = maxShots || 200;
    const out = {
      level: level, games: 0, shots: 0, safetyShots: 0, fouls: 0,
      potFree: 0, hitFree: 0, perfect: 0, lineHist: {},
    };
    for (let gi = 0; gi < games; gi++) {
      const g = { balls: standardRack(), state: null, scores: [0, 0], break: 0, maxBreak: 0 };
      g.state = freshState(g.balls);
      out.games++;

      for (let s = 0; s < maxShots; s++) {
        const r = stepGame(g, level, budget);
        if (r.error || r.over) break;
        out.shots++;
        if (r.verdict && !r.verdict.legal) out.fouls++;

        if (r.decision && r.decision.kind === 'safety') {
          out.safetyShots++;
          const v = C.ai.opponentView(g.balls);
          if (v.potLines === 0) out.potFree++;
          if (v.hitLines === 0) out.hitFree++;
          if (v.potLines === 0 && v.hitLines === 0) out.perfect++;
          const k = Math.min(v.potLines, 5);
          out.lineHist[k] = (out.lineHist[k] || 0) + 1;
        }

        const cleared = R.countOnTable(g.balls, 'red') === 0 &&
                        C.COL_ORDER.every(l => R.countOnTable(g.balls, l) === 0);
        if (cleared) break;
      }
    }
    out.potFreeRate = out.safetyShots ? +(out.potFree / out.safetyShots * 100).toFixed(1) : 0;
    out.perfectRate = out.safetyShots ? +(out.perfect / out.safetyShots * 100).toFixed(1) : 0;
    return out;
  }

  // ================================================================
  //  测试 E：AI 对战（两个档位互打整局）
  //  验证 AI vs AI 模式不会死循环、不会抛异常，并给出双方水平对比
  // ================================================================
  function testMatchup(levelA, levelB, budget, maxShots) {
    maxShots = maxShots || 300;
    const g = { balls: standardRack(), state: null, scores: [0, 0], break: 0, maxBreak: 0 };
    g.state = freshState(g.balls);

    let shots = 0, fouls = 0, potShots = 0, safetyShots = 0;
    const breaksByPlayer = [0, 0];
    const other = R.countOnTable(g.balls, 'red') + C.COL_ORDER.length;   // 初始球数
    let stuck = 0, lastTotal = 0;

    while (shots < maxShots) {
      const p = g.state.currentPlayer;
      const level = p === 0 ? levelA : levelB;
      const r = stepGame(g, level, budget);
      if (r.error) return { error: r.error, shots: shots, levelA: levelA, levelB: levelB };
      shots++;
      if (r.verdict && !r.verdict.legal) fouls++;
      if (r.decision) {
        if (r.decision.kind === 'pot') potShots++;
        else if (r.decision.kind === 'safety') safetyShots++;
      }
      if (g.break > breaksByPlayer[p]) breaksByPlayer[p] = g.break;
      if (r.over) break;

      // 死循环保护：连续 120 杆总分一动不动（互相做斯诺克做死了）
      const total = g.scores[0] + g.scores[1];
      if (total === lastTotal) { stuck++; if (stuck > 120) break; } else { stuck = 0; lastTotal = total; }
    }

    return {
      levelA: levelA, levelB: levelB,
      shots: shots, fouls: fouls, potShots: potShots, safetyShots: safetyShots,
      scores: g.scores.slice(), bestBreak: breaksByPlayer.slice(), maxBreak: g.maxBreak,
      redsLeft: R.countOnTable(g.balls, 'red'),
      cleared: R.countOnTable(g.balls, 'red') === 0 &&
               C.COL_ORDER.every(l => R.countOnTable(g.balls, l) === 0),
      openedWith: other,
    };
  }

  // ================================================================
  //  入口
  // ================================================================
  function run(opts) {
    opts = opts || {};
    const n = opts.n || param('n', 24);
    const budget = opts.budget || param('budget', 220);
    const maxShots = opts.maxShots || param('shots', 260);

    const log = console.log.bind(console);
    log('%cMini Snooker self-test', 'color:#4dabf7;font-weight:bold;font-size:14px');

    const t0 = performance.now();

    log('— 测试 A：AI 声称 vs 独立复现（不失误保证）');
    const A = testConsistency(n, budget);
    const s = A.stats;
    log(`  局面 ${s.total} 个 · 进攻 ${s.pot} · 防守 ${s.safety} · 兜底 ${s.fallback}`);
    log(`  不匹配 ${s.mismatch}（进攻不中的 ${s.illegalPot}） · 异常 ${s.errors}`);
    log(A.mismatches.length ? '  FAIL · ' + A.mismatches.slice(0, 5).join(' | ')
                            : '  PASS · AI called pot, pot made; called safety, safety legal');
    const passRate = s.total ? ((s.total - s.mismatch) / s.total * 100).toFixed(1) : '—';
    log(`  一致率 ${passRate}%`);

    log('— 测试 B：大师·147 从标准开球台面连续进攻');
    const B = testClearance(maxShots, budget);
    if (B.error) log('  FAIL · ' + B.error);
    else {
      log(`  出杆 ${B.shots} · 犯规 ${B.fouls} · 最高单杆 ${B.maxBreak} · 比分 ${B.scores[0]}:${B.scores[1]}`);
      log(`  剩余红球 ${B.redsLeft} · 剩余彩球 [${B.colorsLeft.join(',')}] · ${B.cleared ? 'cleared' : 'not cleared'}`);
      if (B.maxBreak >= 147) log('  Maximum 147 reached.');
    }

    log('— 测试 C：决策耗时 (ms)');
    const Ct = testTiming(Math.max(6, n >> 1), budget);
    for (const k in Ct) log(`  ${k.padEnd(7)} 平均 ${Ct[k].avg} · 最大 ${Ct[k].max}   (n=${Ct[k].n})`);

    log('— 测试 D：防守质量（打完整局统计）');
    const D = testSafety(Math.max(2, n >> 3), budget);
    log(`  ${D.games} 局 / ${D.shots} 杆 · 犯规 ${D.fouls}`);
    log(`  对手无球可下 ${D.zeroLines} 次（${D.zeroRate}%）· 只剩 1 条线路 ${D.oneLine} 次 · 平均线路数 ${D.avgLines}`);

    log(`%c自检结束，用时 ${((performance.now() - t0) / 1000).toFixed(1)}s`,
      'color:#2ed573;font-weight:bold');

    if (C.game && C.game.showMsg) {
      C.game.showMsg('Self-test complete',
        `一致率 <em>${passRate}%</em><br>最高单杆 <em>${B.maxBreak || 0}</em><br>详见控制台 (F12)`, 9000);
    }
    return { A: A, B: B, C: Ct, D: D };
  }

  SNK.selftest = {
    run: run,
    testConsistency: testConsistency,
    testClearance: testClearance,
    testTiming: testTiming,
    testSafety: testSafety,
    testMatchup: testMatchup,
    testSnooker: testSnooker,
    randomClassicLayout: randomClassicLayout,
    standardRack: standardRack,
    freshState: freshState,
    stepGame: stepGame,
  };
})(window.SNK = window.SNK || {});
