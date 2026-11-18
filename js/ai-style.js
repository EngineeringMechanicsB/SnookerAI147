// ================================================================
//  ai-style.js — AI 选球加权层
//
//  旧 AI 只有一个总分：进球分值 + 走位价值。结果很"机器"：
//  同等分值下不区分长台/薄球/多库，球员画像只能靠零散的
//  colorBias / comfortW 调，选球风格还是不像人。
//
//  这一层把一杆拆成可解释的特征，再按球员权重合成得分：
//
//    进球概率         potProb
//    击球距离         distance
//    薄厚/切角        thin
//    加塞量           spin
//    母球走位距离     cueTravel
//    目标球行程       objectTravel
//    防守难度         safetyDifficulty
//    击球复杂度       complexity（翻袋/组合/多库/薄球）
//    球局开放程度     openness（红球堆越散越开放）
//
//  权重不是难度：它描述"这名球员愿意用什么方式赢球"。
//  奥沙利文怕复杂、爱高概率进攻；特鲁姆普不怕长台；塞尔比把
//  防守难度看得最重。所有模拟结果仍然来自 sim.js，这里只负责选。
// ================================================================
(function (SNK) {
  'use strict';

  const C = SNK;
  const BALL_R = C.BALL_R;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function n01(v) {
    return clamp(v, 0, 1);
  }

  // ----------------------------------------------------------------
  //  默认权重。单个球员只覆盖自己在意的那几项。
  //
  //  所有 cost 都是"越大越不喜欢"：
  //    distanceCost 大 = 不爱长台
  //    thinCost     大 = 不爱薄球
  //    complexityCost大 = 不爱翻袋/组合/多库
  //  safetyValue 大 = 更愿意用防守难度换进攻风险。
  //  compareSafety 是"低到什么程度才愿意考虑防守"的分界线。
  // ----------------------------------------------------------------
  const DEFAULT_TACTICS = {
    potWeight: 1.0,
    riskCost: 1.0,
    distanceCost: 0.75,
    thinCost: 0.75,
    spinCost: 0.60,
    cueTravelCost: 0.50,
    objectTravelCost: 0.40,
    safetyValue: 1.00,
    complexityCost: 0.75,
    opennessValue: 0.50,
    compareSafety: 4.2,
    // 连续进攻/单杆价值。压得太低会变成"每杆都挑最好进的球"，
    // 单杆很短；职业球员会为了下一颗黑球接受一点难度。
    breakWeight: 0.75,
    // 下一杆质量。所有球员的前三权重：进得再漂亮，下一杆没得打就是坏球。
    // 表示"打红叫黑/打黑叫红"的能力，不只是当前这一杆的进球。
    nextShotWeight: 24,
  };

  function tacticsOf(prof) {
    return (prof && prof.tactics) || DEFAULT_TACTICS;
  }

  // ----------------------------------------------------------------
  //  球局开放程度
  //
  //  用红球最近邻距离的平均值衡量。满台红球堆在一起时约 0.1，
  //  散开后接近 1。没有红球（清彩阶段）按半开放处理。
  // ----------------------------------------------------------------
  function openness(world) {
    if (!world || !world.length) return 0.6;
    const reds = [];
    for (let i = 0; i < world.length; i++) {
      const b = world[i];
      if (b.label === 'red' && b.isOnTable()) reds.push(b);
    }
    if (reds.length < 2) return 0.72;

    let sum = 0;
    for (let i = 0; i < reds.length; i++) {
      let near = Infinity;
      for (let j = 0; j < reds.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(reds[i].x - reds[j].x, reds[i].y - reds[j].y);
        if (d < near) near = d;
      }
      if (isFinite(near)) sum += near;
    }
    const avg = sum / reds.length;
    return n01((avg - BALL_R * 2.1) / (BALL_R * 9.0));
  }

  // ----------------------------------------------------------------
  //  单杆特征
  // ----------------------------------------------------------------
  function spinAmount(shot) {
    if (!shot) return 0;
    return n01(Math.hypot(shot.spinX || 0, shot.spinY || 0) / 0.75);
  }

  function cutOf(e) {
    const c = e && e.cand ? e.cand.cut : 0;
    return n01((c || 0) / 1.36);
  }

  function distanceOf(e) {
    const d = e && e.cand ? e.cand.dist : 0;
    return n01((d || 0) / 1250);
  }

  function objectTravelOf(e) {
    const d = e && e.cand ? e.cand.pocketDist : 0;
    return n01((d || 0) / 950);
  }

  // 母球从接触点/出杆点继续走了多远。没有起点时退回 0。
  function cueTravelOf(e) {
    const res = e && e.res;
    if (!res || !res.finalBalls) return 0;
    const cue = res.finalBalls[res.cueIdx];
    if (!cue) return 0;
    let from = e.cueStart || (e.cand && e.cand.ghost) || null;
    if (!from) return 0;
    const d = Math.hypot(cue.x - from.x, cue.y - from.y);
    return n01(d / 1100);
  }

  // 静态进球概率。跑分时如果 robustRate 已经给出真实成功率，就用后者。
  // 这里不是准度模型，只是把"薄、远、袋口远、加塞"折算成 0~1。
  function staticPotProb(e) {
    const thin = cutOf(e);
    const dist = distanceOf(e);
    const obj = objectTravelOf(e);
    const spin = spinAmount(e.shot);
    let p = 0.97 - 0.42 * thin - 0.24 * dist - 0.18 * obj - 0.10 * spin;
    return clamp(p, 0.06, 0.98);
  }

  function potProbOf(e) {
    if (e && typeof e.potProb === 'number' && isFinite(e.potProb)) {
      return clamp(e.potProb, 0.03, 0.995);
    }
    return staticPotProb(e);
  }

  // 复杂度：线路类型本身 + 实际撞了几次库 + 切角/塞量。
  function complexityOf(e, thin, spin) {
    const tag = String((e && (e.tag || e.spinName)) || '');
    let c = 0;
    if (/Banked/i.test(tag)) c += 0.44;
    else if (/Combination/i.test(tag)) c += 0.50;
    else if (/Cushion-route/i.test(tag)) c += 0.32;
    else if (/spin|Top|Bottom|Left|Right/i.test(tag)) c += 0.12;
    const bounces = e && e.res ? (e.res.bounces || 0) : 0;
    c += Math.min(bounces, 3) * 0.12;
    c += thin * 0.28 + spin * 0.16;
    return n01(c);
  }

  // ----------------------------------------------------------------
  //  防守难度：对手有多难上手。
  //  0 = 留了一台好球，1 = 零漏球/必须多库解。
  // ----------------------------------------------------------------
  function safetyDifficulty(view) {
    if (!view) return 0.45;
    let d = 0;
    if (view.potLines === 0) d += 0.50;
    else d += 0.12 / (1 + Math.min(view.potLines, 8));
    if (view.hitLines === 0) d += 0.28;
    d += n01((view.escape || 0) / 900) * 0.12;
    d += n01(view.cueBlock || 0) * 0.08;
    d += n01(((view.cueNear || 0) - BALL_R * 3) / (BALL_R * 12)) * 0.08;
    return n01(d);
  }

  // ----------------------------------------------------------------
  //  进攻杆得分
  // ----------------------------------------------------------------
  function scorePot(e, prof, ctx) {
    const t = tacticsOf(prof);
    const v = (e && e.verdict) || { points: 0 };
    const prob = potProbOf(e);
    const thin = cutOf(e);
    const dist = distanceOf(e);
    const obj = objectTravelOf(e);
    const spin = spinAmount(e.shot);
    const cue = cueTravelOf(e);
    const comp = complexityOf(e, thin, spin);

    const openBefore = ctx && typeof ctx.openBefore === 'number'
      ? ctx.openBefore : openness(ctx && ctx.balls);
    const world = (e && e.world) || null;
    const openAfter = world ? openness(world) : openBefore;

    // future：搜索算出的走位/后续价值。旧 AI 只认 value，人会为了
    // "下一颗还是黑球"接受一点难度；但也不能让它压过本杆进球概率。
    const futureRaw = Math.max(0, ((e && e.value || 0) - (v.points || 0)));
    const future = n01(futureRaw / 26);
    const breakValue = Math.min(futureRaw, 45) * t.breakWeight * 0.8;
    const immediate = (v.points || 0) + ((v.gameOver ? 18 : 0));

    const attack = (immediate + 4.6 * future + breakValue)
      * (0.62 + 0.95 * t.potWeight * prob)
      * (0.82 + 0.36 * openBefore);

    const risk = (1 - prob) * (8.0 + 12.0 * openBefore) * t.riskCost;

    const cost =
      t.distanceCost * dist * 2.2 +
      t.thinCost * thin * 1.8 +
      t.spinCost * spin * 1.0 +
      t.cueTravelCost * cue * 1.6 +
      t.objectTravelCost * obj * 1.2 +
      t.complexityCost * comp * 2.0;

    const openReward = t.opennessValue * (openAfter - 0.5) * 1.4;

    // 下一杆质量：0 = 进完自己给自己做斯诺克，1 = 下一杆很舒服。
    // 0.35 是中位线，低于它会明显扣分，高于它才加分。
    const nextQ = typeof e.nextQuality === 'number'
      ? n01(e.nextQuality) : 0.5;
    const nextReward = (t.nextShotWeight === undefined ? 24 : t.nextShotWeight)
      * (nextQ - 0.35);

    return attack - risk - cost + openReward + nextReward;
  }

  // ----------------------------------------------------------------
  //  防守杆得分
  // ----------------------------------------------------------------
  function scoreSafety(e, prof, ctx) {
    const t = tacticsOf(prof);
    const world = (e && e.world) || (e && e.res ? e.res.finalBalls : null);
    const view = (e && e.view) || null;
    const openAfter = world ? openness(world) : 0.5;
    const sd = safetyDifficulty(view);
    const cue = cueTravelOf(e);
    const thin = cutOf(e);
    const spin = spinAmount(e.shot);
    const comp = complexityOf(e, thin, spin);

    const leave = t.safetyValue * (1.20 + 4.80 * sd)
      + t.opennessValue * (1 - openAfter) * 1.6;

    const cost = t.cueTravelCost * cue * 0.8
      + t.complexityCost * comp * 0.45
      + t.distanceCost * 0.25;

    return leave - cost;
  }

  // ----------------------------------------------------------------
  //  统一评分入口。kind = 'pot' | 'safety'。
  // ----------------------------------------------------------------
  function rate(e, kind, prof, ctx) {
    if (!e) return -Infinity;
    return kind === 'safety' ? scoreSafety(e, prof, ctx) : scorePot(e, prof, ctx);
  }

  function ratePot(e, prof, ctx) {
    return rate(e, 'pot', prof, ctx);
  }

  function rateSafety(e, prof, ctx) {
    return rate(e, 'safety', prof, ctx);
  }

  // 在一组进攻候选里按加权分挑一杆
  function choosePot(entries, prof, ctx) {
    let pick = null;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e) continue;
      e.styleScore = ratePot(e, prof, ctx);
      if (!pick || e.styleScore > pick.styleScore) pick = e;
    }
    return pick;
  }

  // ----------------------------------------------------------------
  //  球员权重辅助：给 profile 写战术参数时自动补全默认值。
  // ----------------------------------------------------------------
  function tactics(over) {
    const out = {};
    for (const k in DEFAULT_TACTICS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_TACTICS, k)) {
        out[k] = DEFAULT_TACTICS[k];
      }
    }
    if (over) {
      for (const k in over) {
        if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
      }
    }
    return out;
  }

  SNK.aiStyle = {
    DEFAULT_TACTICS: DEFAULT_TACTICS,
    tactics: tactics,
    openness: openness,
    safetyDifficulty: safetyDifficulty,
    staticPotProb: staticPotProb,
    rating: {
      pot: scorePot,
      safety: scoreSafety,
      rate: rate,
      potFeatures: function (e) {
        return {
          potProb: potProbOf(e),
          distance: distanceOf(e),
          thin: cutOf(e),
          spin: spinAmount(e.shot),
          cueTravel: cueTravelOf(e),
          objectTravel: objectTravelOf(e),
          complexity: complexityOf(e, cutOf(e), spinAmount(e.shot)),
        };
      },
    },
    choosePot: choosePot,
  };
})(window.SNK = window.SNK || {});
