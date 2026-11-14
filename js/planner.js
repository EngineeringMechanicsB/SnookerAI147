// ================================================================
//  planner.js — 三点规划：先撞谁 → 目标球去哪 → 白球停哪
//
//  纯搜索，不改物理。给定：
//    · 白球必须先碰到哪颗球（targetIndex）
//    · 被撞球最终要到哪里（objPoint）
//    · 白球最终要停到哪里（cuePoint）
//  枚举瞄准角、力度、左右/高低塞，用与实机相同的 simulateShot() 跑真实物理，
//  返回最接近的一次击球参数和两条实际轨迹。
//
//  两阶段：
//    A. 先找"能把目标球送到点 2"的瞄准角/力度（不加塞）
//    B. 再在这些候选上枚举塞，把白球往点 3 带
//  搜索量约 3k 杆；主线程跑，前端会先显示 Solving。
// ================================================================
(function (SNK) {
  'use strict';
  if (!SNK) return;

  const C = SNK;
  const R = C.BALL_R;

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function pocketError(p) {
    let best = Infinity;
    for (const q of C.pockets) {
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < best) best = d;
    }
    return best;
  }
  function buildBalls(data) {
    const out = [];
    for (const s of data) {
      if (!s || !s.label) continue;
      const b = new C.Ball(s.x, s.y, s.label);
      b.active = s.active !== false;
      b.potted = !!s.potted;
      b.px = b.x; b.py = b.y;
      out.push(b);
    }
    return out;
  }

  function solve(ballsData, targetIndex, objPoint, cuePoint) {
    const balls = buildBalls(ballsData);
    const cueIdx = balls.findIndex(b => b.label === 'white');
    const target = balls[targetIndex];
    if (cueIdx < 0 || !target || !target.isOnTable()) {
      return { ok: false, error: 'No cue ball or target' };
    }
    const cue = balls[cueIdx];
    const dx = target.x - cue.x, dy = target.y - cue.y;
    const d = Math.hypot(dx, dy);
    if (d < R * 2 + 1) return { ok: false, error: 'Target too close' };

    const baseAng = Math.atan2(dy, dx);
    const half = Math.asin(Math.min(0.985, (R * 2.02) / d));
    const angles = [];
    for (let i = -12; i <= 12; i++) angles.push(baseAng + half * (i / 12));
    const powers = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, C.MAX_POWER];
    const spins = [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75];
    const mults = [0.85, 1.0, 1.15];

    const abort = (ev, world, f) => {
      if (ev.firstContact && ev.firstContact.label !== target.label) return true;
      if (!ev.firstContact && f > 150) return true;
      if (world[cueIdx] && world[cueIdx].potted) return true;
      return false;
    };
    const sim = (shot) => C.sim.simulateShot(balls, shot, { abort: abort });
    function resultError(res) {
      const cueF = res.finalBalls[cueIdx];
      const tgtF = res.finalBalls[targetIndex];
      if (!cueF || !cueF.isOnTable()) return null;
      let objErr;
      if (!tgtF || !tgtF.isOnTable() || tgtF.potted) objErr = pocketError(objPoint) + 25;
      else objErr = dist(tgtF, objPoint);
      const cueErr = dist(cueF, cuePoint);
      return { objErr: objErr, cueErr: cueErr, score: objErr + cueErr * 1.25 };
    }

    // ---- A：瞄准角 + 力度，不加塞 ----
    const cand = [];
    for (const angle of angles) {
      for (const power of powers) {
        const res = sim({ angle: angle, power: power, spinX: 0, spinY: 0 });
        if (!res.ok || res.firstContactLabel !== target.label || res.cuePotted) continue;
        const e = resultError(res);
        if (!e) continue;
        cand.push({ angle: angle, power: power, objErr: e.objErr, cueErr: e.cueErr, score: e.score });
      }
    }
    if (!cand.length) return { ok: false, error: 'No line to the target' };
    cand.sort((a, b) => a.score - b.score);
    const roots = cand.slice(0, 20);

    // ---- B：在候选上枚举塞和力度微调 ----
    let best = null;
    for (const r0 of roots) {
      for (const sx of spins) {
        for (const sy of spins) {
          for (const m of mults) {
            const power = C.clamp(r0.power * m, 5, C.MAX_POWER);
            const shot = { angle: r0.angle, power: power, spinX: sx, spinY: sy };
            const res = sim(shot);
            if (!res.ok || res.firstContactLabel !== target.label || res.cuePotted) continue;
            const e = resultError(res);
            if (!e) continue;
            // 轻微的塞惩罚：同分时优先更简单的杆法
            const simple = Math.hypot(sx, sy) * 1.5;
            e.score += simple;
            if (!best || e.score < best.score) {
              best = { shot: shot, objErr: e.objErr, cueErr: e.cueErr, score: e.score };
            }
          }
        }
      }
    }
    if (!best) return { ok: false, error: 'No shot found' };

    // 用最终参数跑一次带轨迹的模拟，供 UI 画线
    const tracked = C.sim.simulateShot(balls, best.shot, { track: true });
    const cuePath = tracked.paths ? tracked.paths[cueIdx] : null;
    const targetPath = tracked.paths ? tracked.paths[targetIndex] : null;
    return {
      ok: true,
      shot: best.shot,
      objErr: best.objErr,
      cueErr: best.cueErr,
      score: best.score,
      firstContact: tracked.firstContactLabel,
      cuePath: cuePath,
      targetPath: targetPath,
      targetIndex: targetIndex,
    };
  }

  C.planner = { solve: solve };
})(window.SNK = window.SNK || {});
