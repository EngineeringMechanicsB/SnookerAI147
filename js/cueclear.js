// ================================================================
//  cueclear.js — 后斯诺克：球杆被挡时，白球还能打哪一片
//
//  真实球台上，如果别的球（或库边）就贴在白球背后，球杆不能平着从它
//  上面穿过去，只能把杆尾抬高、从上往下"盖"着打。杆抬得越高，皮头能
//  碰到的白球区域就越靠上：贴死时只剩顶部约 1/3，隔开一个球径后能碰到
//  上部约 2/3，再远就恢复正常。
//
//  这里只算"可击球面"，不改球的飞行物理：
//    · analyze() 给出这一杆被挡到什么程度、最低可打点 syMin、视觉抬杆角；
//    · clampSpin() 按这个边界夹击点（击球点比边界低就抬到边界）。
//  物理（physics.strike）、人类预览、AI 搜索全部走同一份 clamp，所以
//  "AI 认为能打成什么"和"实机真的打成什么"不会分家。
// ================================================================
(function (SNK) {
  'use strict';
  if (!SNK) return;

  const C = SNK;
  const R = C.BALL_R;

  const SHAFT_R = R * 0.42;        // 杆头/杆身半径（近似）
  const CORRIDOR = R + SHAFT_R;    // 杆身中心线可通过的横向半宽
  const FULL_GAP = R * 4;          // 表面间隙 ≥ 4R（两个球径）完全不挡
  const GAP_TWO_THIRDS = R * 2;    // 间隙 = 一个球径时，可打上部 2/3
  const MIN_TOP = 1 / 3;           // 贴死时可打上部 1/3

  const IDLE = Object.freeze({
    blocked: false, syMin: -1, topFrac: 1, gap: Infinity,
    kind: '', blocker: null, along: Infinity, pitchDeg: 0,
  });

  // 间隙 → 可击球面占球高的比例。线性过渡：
  //   gap 0     → 1/3
  //   gap 2R    → 2/3
  //   gap ≥ 4R  → 1（完全不挡）
  function topFracForGap(gap) {
    if (!isFinite(gap) || gap >= FULL_GAP) return 1;
    const g = Math.max(0, gap);
    return Math.min(1, MIN_TOP + (1 - MIN_TOP) * (g / (2 * GAP_TWO_THIRDS)));
  }

  // 可击球面比例 → 最低可打点的 sy（单位球半径，中心为 0，顶部为 +1）
  function syMinForFrac(frac) {
    return 1 - 2 * C.clamp(frac, 0, 1);
  }

  // 球杆向后（-瞄准方向）延伸到最近库边的距离。
  // 边界取"球心允许走到的最外线"（L+R 等），贴库时返回 0。
  function railDistance(cue, bx, by) {
    const eps = 1e-6;
    let t = Infinity;
    if (bx < -eps) t = Math.min(t, (cue.x - (C.L + R)) / (-bx));
    else if (bx > eps) t = Math.min(t, ((C.R - R) - cue.x) / bx);
    if (by < -eps) t = Math.min(t, (cue.y - (C.T + R)) / (-by));
    else if (by > eps) t = Math.min(t, ((C.B - R) - cue.y) / by);
    if (!isFinite(t)) return Infinity;
    return Math.max(0, t);
  }

  // 抬杆角的视觉估算：从最低可打点连到障碍物顶部，求仰角。
  // 只用于 3D 球杆不穿模和面板提示，不改变物理。
  function pitchFor(contactH, obstacleTop, horiz) {
    const rise = Math.max(0, obstacleTop - contactH);
    const run = Math.max(horiz, R * 0.35);
    return Math.min(C.PITCH_MAX_DEG, Math.atan2(rise, run) * 180 / Math.PI);
  }

  // ================================================================
  //  analyze(balls, cue, angle)
  //
  //  angle 是本杆瞄准方向（弧度）。球杆从白球向后伸，所以只有
  //  "白球背后"的球/库边会挡杆。返回最严重的那一个障碍。
  // ================================================================
  function analyze(balls, cue, angle) {
    if (!cue || !cue.isOnTable || !cue.isOnTable()) return IDLE;
    if (!Array.isArray(balls) || !balls.length) return IDLE;

    const ang = Number.isFinite(angle) ? angle : 0;
    const dx = Math.cos(ang), dy = Math.sin(ang);

    let bestFrac = 1;
    let bestGap = Infinity;
    let bestAlong = Infinity;
    let bestKind = '';
    let bestBall = null;

    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (!b || b === cue) continue;
      if (!b.isOnTable || !b.isOnTable()) continue;

      const rx = b.x - cue.x, ry = b.y - cue.y;
      // 障碍必须在白球背后：along > 0
      const along = -(rx * dx + ry * dy);
      if (along <= 0) continue;

      // 球心到球杆中心线的横向距离
      const lateral = Math.abs(rx * dy - ry * dx);
      if (lateral >= CORRIDOR) continue;

      const overlap = 1 - lateral / CORRIDOR;   // 1 = 正后方，0 = 刚好擦边
      if (overlap <= 0) continue;

      const gap = Math.max(0, along - 2 * R);
      const local = topFracForGap(gap);
      // 横向只挡一部分时，限制按遮挡比例打折
      const eff = 1 - (1 - local) * overlap;
      if (eff < bestFrac) {
        bestFrac = eff;
        bestGap = gap;
        bestAlong = along;
        bestKind = 'ball';
        bestBall = b;
      }
    }

    // 库边：杆向库边方向伸出去，也必须抬杆越过库边顶。
    // 两条相反方向的库边都要看，取更近的那条。
    const railGap = railDistance(cue, -dx, -dy);
    const railFrac = topFracForGap(railGap);
    if (railFrac < bestFrac) {
      bestFrac = railFrac;
      bestGap = railGap;
      bestAlong = railGap;
      bestKind = 'rail';
      bestBall = null;
    }

    if (bestFrac >= 1 - 1e-9) return IDLE;

    const syMin = syMinForFrac(bestFrac);
    // 击点盘最低只能到 -SPIN_MAX；边界比它更低时等于没有限制
    const blocked = syMin > -C.SPIN_MAX + 1e-6;

    let pitchDeg = 0;
    if (blocked) {
      const contactH = R * (1 + Math.max(-1, syMin));
      const obstacleTop = bestKind === 'ball' ? 2 * R + SHAFT_R : R * 2.1;
      const horiz = bestKind === 'ball' ? bestAlong : Math.max(bestAlong, R * 0.35);
      pitchDeg = pitchFor(contactH, obstacleTop, horiz);
    }

    return {
      blocked: blocked,
      syMin: syMin,
      topFrac: bestFrac,
      gap: bestGap,
      kind: bestKind,
      blocker: bestBall,
      along: bestAlong,
      pitchDeg: pitchDeg,
    };
  }

  // 按可击球面夹击点。**先保证 sy 不低于边界，再缩 sx**，
  // 否则"夹完再归一化"会把 sy 又拖回边界以下。
  function clampSpin(clear, sx, sy) {
    sx = Number.isFinite(sx) ? sx : 0;
    sy = Number.isFinite(sy) ? sy : 0;
    const max = C.SPIN_MAX;
    if (!clear || !clear.blocked) {
      return { sx: C.clamp(sx, -max, max), sy: C.clamp(sy, -max, max), clamped: false };
    }
    const syMin = C.clamp(clear.syMin, -max, max);
    sy = C.clamp(sy, syMin, max);
    const lim = Math.sqrt(Math.max(0, max * max - sy * sy));
    sx = C.clamp(sx, -lim, lim);
    return { sx: sx, sy: sy, clamped: true };
  }

  C.cueClear = {
    SHAFT_R: SHAFT_R,
    CORRIDOR: CORRIDOR,
    FULL_GAP: FULL_GAP,
    MIN_TOP: MIN_TOP,
    topFracForGap: topFracForGap,
    syMinForFrac: syMinForFrac,
    analyze: analyze,
    clampSpin: clampSpin,
  };
})(window.SNK = window.SNK || {});
