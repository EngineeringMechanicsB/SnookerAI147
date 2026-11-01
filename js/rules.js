// ================================================================
//  rules.js — 斯诺克裁判（纯函数）
//
//  judge(pre, result) → verdict
//
//  实机在球全部停稳后调用它并应用结果；AI 在模拟里调用它判断
//  "这杆进不进、犯不犯规、能不能接着打"。
//  同一份规则，就不会出现"AI 以为合法、游戏判犯规"的割裂。
//
//  三种模式：classic / clearance / respottedBlack
// ================================================================
(function (SNK) {
  'use strict';

  const C = SNK;
  const COL_VAL = C.COL_VAL;
  const COL_ORDER = C.COL_ORDER;
  const CN = C.COL_CN;

  const isColorLabel = (l) => l !== 'red' && l !== 'white';
  const valOf = (l) => COL_VAL[l] || 0;

  function countIn(labels, label) {
    let n = 0;
    for (let i = 0; i < labels.length; i++) if (labels[i] === label) n++;
    return n;
  }
  function countColorsIn(labels) {
    let n = 0;
    for (let i = 0; i < labels.length; i++) if (isColorLabel(labels[i])) n++;
    return n;
  }

  // ================================================================
  //  当前该打什么（AI / HUD / 高亮共用）
  // ================================================================
  function ballOn(state, balls) {
    if (state.mode === 'nineball') {
      for (let i = 0; i < C.POOL_NINE.length; i++) {
        const l = C.POOL_NINE[i];
        if (countOnTable(balls, l) > 0) {
          return { phase: 'nine', targets: [l], label: l };
        }
      }
      return { phase: 'over', targets: [], label: '—' };
    }
    if (state.mode === 'eightball') {
      const group = state.poolGroups ? state.poolGroups[state.currentPlayer] : null;
      if (state.poolOpen || !group) {
        const rest = balls.filter(b => C.isPoolLabel(b.label) && b.label !== 'eight' && b.isOnTable());
        return { phase: rest.length ? 'pool-open' : 'pool-eight',
                 targets: rest.length ? rest.map(b => b.label) : ['eight'],
                 label: rest.length ? 'open table' : 'eight' };
      }
      const labels = group === 'solids' ? C.POOL_SOLIDS : C.POOL_STRIPES;
      const left = labels.filter(l => countOnTable(balls, l) > 0);
      if (left.length) return { phase: 'pool-group', targets: left, label: group };
      return { phase: 'pool-eight', targets: ['eight'], label: 'eight' };
    }
    if (state.isRespottedBlack) {
      return { phase: 'respottedBlack', targets: ['black'], label: 'black' };
    }
    const reds = countOnTable(balls, 'red');

    if (state.needRed && reds > 0) {
      return { phase: 'red', targets: ['red'], label: 'red' };
    }
    if (reds === 0 && !state.pottedRedThisTurn) {
      const next = nextColorInOrder(balls);
      if (next) return { phase: 'clearance', targets: [next], label: next };
      return { phase: 'over', targets: [], label: '—' };
    }
    return { phase: 'color', targets: allColorLabels(balls), label: 'any' };
  }

  function countOnTable(balls, label) {
    let n = 0;
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.label === label && b.isOnTable()) n++;
    }
    return n;
  }
  function allColorLabels(balls) {
    const out = [];
    for (const l of COL_ORDER) if (countOnTable(balls, l) > 0) out.push(l);
    return out;
  }
  function nextColorInOrder(balls) {
    for (const l of COL_ORDER) if (countOnTable(balls, l) > 0) return l;
    return null;
  }

  // ================================================================
  //  judge
  //
  //  pre = {
  //    mode:'classic'|'clearance'|'respottedBlack',
  //    isRespottedBlack:bool,
  //    needRed:bool, pottedRedThisTurn:bool,
  //    currentPlayer:int, scores:[a,b]
  //  }
  //  result = {
  //    firstContactLabel : string|null,   // 白球第一颗碰到的球
  //    pottedLabels      : [string],      // 本杆落袋的球（含白球），按落袋先后
  //    cuePotted         : bool,
  //    afterLabels       : [string]       // 本杆结束后仍在台面上的球
  //  }
  // ================================================================
  function judge(pre, result) {
    const potted = result.pottedLabels || [];
    const after = result.afterLabels || [];
    const first = result.firstContactLabel;

    const v = {
      legal: true,
      foulReason: '',
      penalty: 0,
      points: 0,
      pottedLegal: [],
      turnContinues: false,
      breakEnds: false,
      nextNeedRed: pre.needRed,
      nextPottedRedThisTurn: false,
      respot: [],
      cueBallInHand: false,
      gameOver: false,
      winner: -1,
      tie: false,
      rerack: false,
      poolOpen: !!pre.poolOpen,
      poolGroups: pre.poolGroups ? pre.poolGroups.slice() : [null, null],
    };

    if (pre.mode === 'eightball') return judgeEightBall(pre, result, v);
    if (pre.mode === 'nineball') return judgeNineBall(pre, result, v);
    if (pre.isRespottedBlack) return judgeRespottedBlack(pre, result, v);

    const redsAfter = countIn(after, 'red');
    const clearancePhase = !pre.needRed && redsAfter === 0 && !pre.pottedRedThisTurn;

    let foul = false;
    let reason = '';
    let pottedRedThisTurn = pre.pottedRedThisTurn;
    const pottedThisShot = [];

    // ---------------- A. 先碰球是否合法 ----------------
    if (!first) {
      foul = true; reason = 'No ball hit';
    } else if (pre.needRed && first !== 'red') {
      foul = true; reason = `Must hit a red first, but hit ${CN[first] || first}`;
    } else if (!pre.needRed && first === 'red') {
      foul = true; reason = 'Must hit a colour first, but hit a red';
    } else if (clearancePhase) {
      // 清彩阶段：必须先碰到顺序最靠前的那颗彩球
      const fcIdx = COL_ORDER.indexOf(first);
      if (fcIdx > 0) {
        for (let k = 0; k < fcIdx; k++) {
          if (countIn(after, COL_ORDER[k]) > 0) {
            foul = true;
            reason = `Must hit ${CN[COL_ORDER[k]]} first, but hit ${CN[first]}`;
            break;
          }
        }
      }
    }

    // ---------------- B. 逐个处理落袋的球 ----------------
    for (let i = 0; i < potted.length; i++) {
      const label = potted[i];

      if (label === 'white') {
        foul = true;
        v.cueBallInHand = true;
        if (!reason) reason = 'Cue ball potted';
        continue;
      }

      let thisLegal = true;

      if (pre.needRed) {
        if (label === 'red') {
          pottedRedThisTurn = true;   // 与原版一致：无论是否犯规都记上
          v.points += 1;
        } else {
          thisLegal = false;
          if (!reason) reason = `Potted ${CN[label] || label} while on a red`;
        }
      } else {
        if (isColorLabel(label)) {
          if (clearancePhase) {
            const idx = COL_ORDER.indexOf(label);
            for (let k = 0; k < idx; k++) {
              if (countIn(after, COL_ORDER[k]) > 0) {
                thisLegal = false;
                if (!reason) reason = `Must pot ${CN[COL_ORDER[k]]}, but potted ${CN[label]}`;
                break;
              }
            }
          }
          if (thisLegal) v.points += valOf(label);
        } else {
          thisLegal = false;
          if (!reason) reason = 'Potted a red while on a colour';
        }
      }

      if (thisLegal) pottedThisShot.push(label);
      else foul = true;
    }

    if (foul) {
      v.legal = false;
      v.foulReason = reason;

      // 罚分：max(4, 先碰到的球分值, 被打进的球分值, 目标球分值)
      let pen = 4;
      if (first && valOf(first)) pen = Math.max(pen, valOf(first));
      for (let i = 0; i < potted.length; i++) pen = Math.max(pen, valOf(potted[i]));
      if (clearancePhase) {
        const on = clearancePhaseNext(after);
        if (on) pen = Math.max(pen, valOf(on));
      }
      v.penalty = pen;

      // 犯规杆不得分（修正原版：打进的红球仍被计分）
      v.points = 0;
      v.pottedLegal = [];
      v.breakEnds = true;
    } else {
      v.pottedLegal = pottedThisShot;
    }

    // ---------------- C. 复位 ----------------
    const pottedColors = potted.filter(isColorLabel);
    if (redsAfter > 0 || pottedRedThisTurn) {
      v.respot = pottedColors.slice();                       // 红彩交替阶段：彩球全回点位
    } else if (foul) {
      v.respot = pottedColors.filter(l => !pottedThisShot.includes(l)); // 清彩犯规：只回非法的
    }

    // ---------------- D. 是否继续 ----------------
    if (foul) {
      v.turnContinues = false;
      v.nextNeedRed = redsAfter > 0;
      v.nextPottedRedThisTurn = false;
      return v;
    }

    if (pottedThisShot.length === 0) {
      v.turnContinues = false;
      v.breakEnds = true;
      v.nextNeedRed = redsAfter > 0;
      v.nextPottedRedThisTurn = false;
      return v;
    }

    // ---------------- E. 阶段推进（对齐原版）----------------
    let needRed = pre.needRed;
    if (needRed && pottedRedThisTurn) {
      needRed = false;
      if (redsAfter > 0) pottedRedThisTurn = false;   // 最后一颗红球要保留标记等打彩
    } else if (!needRed && redsAfter > 0) {
      needRed = true;
      pottedRedThisTurn = false;
    } else if (!needRed && redsAfter === 0) {
      pottedRedThisTurn = false;
    }
    v.nextNeedRed = needRed;
    v.nextPottedRedThisTurn = pottedRedThisTurn;
    v.turnContinues = true;

    // ---------------- F. 清台判定 ----------------
    // 复位后的彩球数 = 台面剩余 + 将要复位的
    const colorsEffective = countColorsIn(after) + v.respot.length;
    if (redsAfter === 0 && colorsEffective === 0) {
      const s0 = pre.scores[0] + (pre.currentPlayer === 0 ? v.points : 0);
      const s1 = pre.scores[1] + (pre.currentPlayer === 1 ? v.points : 0);
      if (s0 === s1) {
        v.tie = true;                 // 打平 → 由调用方开抢黑
      } else {
        v.gameOver = true;
        v.winner = s0 > s1 ? 0 : 1;
      }
    }

    return v;
  }

  function clearancePhaseNext(after) {
    for (const l of COL_ORDER) if (countIn(after, l) > 0) return l;
    return null;
  }

  // ================================================================
  //  9-ball：必须先碰台面最小号码，9 号进袋即胜
  // ================================================================
  function judgeNineBall(pre, result, v) {
    const potted = result.pottedLabels || [];
    const first = result.firstContactLabel;
    const after = result.afterLabels || [];
    const cuePotted = result.cuePotted || potted.indexOf('white') >= 0;
    let low = null;
    for (let i = 0; i < C.POOL_NINE.length; i++) {
      const l = C.POOL_NINE[i];
      if (countIn(after, l) + countIn(potted, l) > 0) { low = l; break; }
    }
    v.nextNeedRed = false;
    v.nextPottedRedThisTurn = false;

    let foul = false, reason = '';
    if (!first) { foul = true; reason = 'No ball hit'; }
    else if (low && first !== low) { foul = true; reason = `Must hit ${C.COL_CN[low] || low} first`; }
    if (cuePotted) { foul = true; reason = reason || 'Cue ball potted'; }

    let ninePotted = potted.indexOf('b9') >= 0;
    let points = 0;
    for (let i = 0; i < potted.length; i++) {
      const l = potted[i];
      if (l === 'white' || l === 'b9') continue;
      if (C.POOL_NINE.indexOf(l) >= 0) points++;
    }

    if (foul) {
      v.legal = false;
      v.foulReason = reason;
      v.penalty = 0;
      v.points = 0;
      v.cueBallInHand = true;
      v.turnContinues = false;
      v.breakEnds = true;
      // 9 号在犯规杆落袋：重摆一局，避免直接判负
      if (ninePotted) v.rerack = true;
      return v;
    }

    if (ninePotted) {
      v.points = points + 9;
      v.gameOver = true;
      v.winner = pre.currentPlayer;
      v.turnContinues = false;
      return v;
    }

    v.points = points;
    v.pottedLegal = potted.filter(l => l !== 'white' && l !== 'b9');
    v.turnContinues = points > 0;
    v.breakEnds = !v.turnContinues;
    return v;
  }

  // ================================================================
  //  8-ball（简化但完整的轮转规则）
  //
  //  · 开放球台：第一杆合法进球后确定花色/全色
  //  · 必须先碰自己的组；清完自己的组后才能打黑八
  //  · 白球落袋、先碰错组、提前打进黑八都是犯规/负
  //  · 犯规后对手自由球（本作用自动摆球代替手动拖拽）
  // ================================================================
  function judgeEightBall(pre, result, v) {
    const potted = result.pottedLabels || [];
    const first = result.firstContactLabel;
    const after = result.afterLabels || [];
    const cuePotted = result.cuePotted || potted.indexOf('white') >= 0;
    const groups = pre.poolGroups ? pre.poolGroups.slice() : [null, null];
    const myGroup = groups[pre.currentPlayer];
    const open = !!pre.poolOpen || !myGroup;
    const myLabels = myGroup === 'stripes' ? C.POOL_STRIPES : C.POOL_SOLIDS;
    const oppLabels = myGroup === 'stripes' ? C.POOL_SOLIDS : C.POOL_STRIPES;
    const myLeftBefore = myGroup
      ? myLabels.reduce((n, l) => n + countIn(after, l) + countIn(potted, l), 0)
      : 0;
    const eightBefore = countIn(after, 'eight') + countIn(potted, 'eight');

    v.nextNeedRed = false;
    v.nextPottedRedThisTurn = false;
    v.poolOpen = open;
    v.poolGroups = groups;

    let foul = false, reason = '', points = 0, continueTurn = false;

    // 先碰球
    if (!first) { foul = true; reason = 'No ball hit'; }
    else if (open) {
      if (first === 'eight') { foul = true; reason = 'Open table · must hit a colour first'; }
    } else if (myLeftBefore > 0) {
      if (myLabels.indexOf(first) < 0) { foul = true; reason = 'Must hit your own group first'; }
    } else if (first !== 'eight') {
      foul = true; reason = 'Must hit the 8-ball first';
    }

    if (cuePotted) { foul = true; reason = reason || 'Cue ball potted'; }

    let eightPotted = false;
    let assigned = false;
    for (let i = 0; i < potted.length; i++) {
      const l = potted[i];
      if (l === 'white') continue;
      if (l === 'eight') { eightPotted = true; continue; }
      if (C.isPoolLabel(l)) {
        if (open && !assigned) {
          // 第一颗合法进球定组
          const g = C.POOL_STRIPES.indexOf(l) >= 0 ? 'stripes' : 'solids';
          groups[pre.currentPlayer] = g;
          groups[1 - pre.currentPlayer] = g === 'solids' ? 'stripes' : 'solids';
          v.poolGroups = groups;
          v.poolOpen = false;
          assigned = true;
          points++;
          continueTurn = true;
        } else if (!open) {
          if (myLabels.indexOf(l) >= 0) { points++; continueTurn = true; }
          // 打进对手球不算犯规，但也不加分；球留在袋里
        } else {
          points++; continueTurn = true;
        }
      }
    }

    if (eightPotted) {
      if (pre.opening && !foul) {
        // 开球把黑八打进：重开一局，避免直接判负
        v.rerack = true;
        v.turnContinues = false;
        v.points = 0;
        v.legal = true;
        return v;
      }
      const cleared = myGroup ? myLeftBefore === 0 : eightBefore <= 1;
      if (!foul && cleared && first === 'eight') {
        v.points = 8;
        v.gameOver = true;
        v.winner = pre.currentPlayer;
        v.turnContinues = false;
        return v;
      }
      // 提前打进黑八 / 犯规同时打进：对手赢
      v.legal = false;
      v.foulReason = foul ? reason : '8-ball potted too early';
      v.gameOver = true;
      v.winner = 1 - pre.currentPlayer;
      v.turnContinues = false;
      v.penalty = 0;
      return v;
    }

    if (foul) {
      v.legal = false;
      v.foulReason = reason;
      v.penalty = 0;
      v.points = 0;
      v.pottedLegal = [];
      v.cueBallInHand = true;
      v.turnContinues = false;
      v.breakEnds = true;
      return v;
    }

    v.points = points;
    v.pottedLegal = potted.filter(l => l !== 'white' && l !== 'eight');
    v.turnContinues = continueTurn;
    v.breakEnds = !continueTurn;
    v.nextNeedRed = false;
    v.nextPottedRedThisTurn = false;
    v.poolOpen = open && !assigned;
    v.poolGroups = groups;
    return v;
  }

  // ================================================================
  //  抢黑模式
  // ================================================================
  function judgeRespottedBlack(pre, result, v) {
    const potted = result.pottedLabels || [];
    const first = result.firstContactLabel;
    const cuePotted = result.cuePotted || potted.indexOf('white') >= 0;

    const oppWins = (why) => {
      v.legal = false;
      v.foulReason = why;
      v.penalty = 7;
      v.points = 0;
      v.turnContinues = false;
      v.breakEnds = true;
      v.gameOver = true;
      v.winner = 1 - pre.currentPlayer;
      return v;
    };

    if (cuePotted) return oppWins('Cue ball potted');

    if (potted.indexOf('black') >= 0) {
      if (first && first !== 'black') {
        return oppWins(`Must hit the black first, but hit ${CN[first] || first}`);
      }
      v.points = 7;
      v.gameOver = true;
      v.winner = pre.currentPlayer;
      v.turnContinues = false;
      return v;
    }

    if (!first) return oppWins('No ball hit');
    if (first !== 'black') return oppWins(`Must hit the black first, but hit ${CN[first] || first}`);

    v.legal = true;
    v.turnContinues = false;
    v.breakEnds = true;
    return v;
  }

  // ================================================================
  //  合法目标球（AI 用）
  // ================================================================
  function legalTargets(state, balls) {
    const on = ballOn(state, balls);
    if (state.mode === 'eightball' || state.mode === 'nineball') {
      return balls.filter(b => b.isOnTable() && on.targets.indexOf(b.label) >= 0);
    }
    if (on.phase === 'over') return [];
    if (on.phase === 'respottedBlack') return balls.filter(b => b.label === 'black' && b.isOnTable());
    if (on.phase === 'red') return balls.filter(b => b.label === 'red' && b.isOnTable());
    if (on.phase === 'clearance') return balls.filter(b => b.label === on.targets[0] && b.isOnTable());
    return balls.filter(b => b.isColor && b.isOnTable());
  }

  // 打完这一杆后的"下一杆该打什么"（走位规划用）
  function nextBallOn(state, afterLabels) {
    const reds = countIn(afterLabels, 'red');
    if (state.nextNeedRed && reds > 0) return { phase: 'red', targets: ['red'] };
    if (reds === 0 && !state.nextPottedRedThisTurn) {
      const next = clearancePhaseNext(afterLabels);
      if (next) return { phase: 'clearance', targets: [next] };
      return { phase: 'over', targets: [] };
    }
    return { phase: 'color', targets: afterLabels.filter(isColorLabel) };
  }

  SNK.rules = {
    judge,
    ballOn,
    legalTargets,
    nextBallOn,
    countOnTable,
    countIn,
    countColorsIn,
    nextColorInOrder,
    allColorLabels,
    isColorLabel,
    valOf,
  };
})(window.SNK = window.SNK || {});
