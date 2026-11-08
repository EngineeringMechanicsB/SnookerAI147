// ================================================================
//  sim.js — 单杆模拟器
//
//  克隆一份球局 → 击球 → 用**与实机完全相同的 stepWorld()** 跑到底
//  → 返回落袋、首次接触、终局球位、白球轨迹。
//
//  人类瞄准预览、AI 决策、自检复现，全都走这一个函数。
//  因为物理只有一份实现，所以"模拟说什么，实机就发生什么"。
// ================================================================
(function (SNK) {
  'use strict';

  const C = SNK;

  // ----------------------------------------------------------------
  //  克隆球局
  // ----------------------------------------------------------------
  function cloneWorld(balls) {
    const n = balls.length;
    const world = new Array(n);
    let cueIdx = -1;
    for (let i = 0; i < n; i++) {
      const s = balls[i];
      const b = new C.Ball(s.x, s.y, s.label);
      b.vx = s.vx; b.vy = s.vy;
      b.wx = s.wx; b.wy = s.wy; b.wz = s.wz;
      b.sx = s.sx; b.sy = s.sy;
      b.active = s.active; b.potted = s.potted;
      b.__i = i;                 // 身份标记：AI 的早退回调靠它认球
      world[i] = b;
      if (s.label === 'white') cueIdx = i;
    }
    return { world, cueIdx };
  }

  // ----------------------------------------------------------------
  //  simulateShot(balls, shot, opts) → 结果
  //
  //  shot = { angle, power, spinX, spinY, pitchDeg? }
  //  opts = { track:bool }   是否需要轨迹（瞄准预览要，AI 搜索不要）
  // ----------------------------------------------------------------
  function simulateShot(balls, shot, opts) {
    opts = opts || {};
    const track = !!opts.track;
    const maxFrames = opts.maxFrames || C.MAX_SIM_FRAMES;

    const { world, cueIdx } = cloneWorld(balls);
    if (cueIdx < 0) return emptyResult();

    const cue = world[cueIdx];
    if (!cue.isOnTable()) return emptyResult();

    const ev = { potted: [], firstContact: null, bounces: 0, cueBall: cue };
    // 俯仰和"后斯诺克"夹紧都交给 strike()，与实机出杆同一入口。
    // AI 的候选杆不带 pitchDeg → 0，所以 AI 仍是平杆搜索。
    const pitch = (Number.isFinite(shot.pitchDeg) ? shot.pitchDeg : 0) * Math.PI / 180;
    // AI 搜索默认自动抬杆；人类瞄准预览显式传 autoRaise:false。
    const autoRaise = !(opts && opts.autoRaise === false);
    C.strike(cue, shot.angle, shot.power, shot.spinX, shot.spinY, pitch, world, autoRaise);

    const paths = track ? world.map(() => [{ x: 0, y: 0 }]) : null;
    if (track) {
      for (let i = 0; i < world.length; i++) {
        paths[i][0].x = world[i].x;
        paths[i][0].y = world[i].y;
        // 物理层在库边/球球接触/落袋的**精确时刻**直接往这条数组里补点，
        // 见 physics.js 的 markPath()。这样折线拐角不会因为采样间隔而漂移。
        world[i].__path = paths[i];
      }
    }

    let frames = 0;
    let moving = true;
    let settled = false;
    let aborted = false;
    const abort = opts.abort;

    for (let f = 0; f < maxFrames; f++) {
      moving = C.stepWorld(world, ev);
      frames++;
      // 每 2 帧采一次（原来 4 帧）：满力一帧 30px，4 帧的折线在弧线（加塞）
      // 和大角度走位上会明显看出是折线。事件点已经保证拐角精确，这里只负责
      // 把曲线段补密。
      if (track && (f & 1) === 0) {
        for (let i = 0; i < world.length; i++) {
          const b = world[i];
          if (!b.isOnTable()) continue;
          const p = paths[i], q = p[p.length - 1];
          // 静止球会在每个采样帧产生同一个点，跳过它
          if (q && Math.abs(q.x - b.x) < 0.01 && Math.abs(q.y - b.y) < 0.01) continue;
          p.push({ x: b.x, y: b.y });
        }
      }
      if (!moving) { settled = true; break; }
      // 早退：搜索时绝大多数候选杆会立刻失败，没必要跑完
      if (abort && abort(ev, world, f)) { aborted = true; break; }
    }

    // 终止兜底：把残余速度清零，避免"还有球在飘"的错觉
    if (!settled) {
      for (const b of world) {
        b.vx = 0; b.vy = 0;
        b.wx = 0; b.wy = 0; b.wz = 0;
      }
    }

    const afterLabels = [];
    for (const b of world) if (b.isOnTable()) afterLabels.push(b.label);

    const fc = ev.firstContact;

    return {
      ok: true,
      aborted,
      pottedLabels: ev.potted,
      cuePotted: cue.potted,
      firstContactLabel: fc ? fc.label : null,
      firstContact: fc,
      afterLabels,
      finalBalls: world,
      cueIdx,
      frames,
      settled,
      bounces: ev.bounces,
      paths,
      cuePath: track ? paths[cueIdx] : null,
    };
  }

  function emptyResult() {
    return {
      ok: false,
      pottedLabels: [],
      cuePotted: true,
      firstContactLabel: null,
      firstContact: null,
      afterLabels: [],
      finalBalls: [],
      cueIdx: -1,
      frames: 0,
      settled: true,
      paths: null,
      cuePath: null,
    };
  }

  // ----------------------------------------------------------------
  //  一次模拟 + 一次判罚
  // ----------------------------------------------------------------
  function simulateAndJudge(state, balls, shot, opts) {
    const res = simulateShot(balls, shot, opts);
    const pre = {
      mode: state.mode,
      isRespottedBlack: state.isRespottedBlack,
      needRed: state.needRed,
      pottedRedThisTurn: state.pottedRedThisTurn,
      currentPlayer: state.currentPlayer,
      scores: state.scores,
    };
    const verdict = C.rules.judge(pre, {
      firstContactLabel: res.firstContactLabel,
      pottedLabels: res.pottedLabels,
      cuePotted: res.cuePotted,
      afterLabels: res.afterLabels,
    });
    return { res, verdict };
  }

  SNK.sim = {
    simulateShot,
    simulateAndJudge,
    cloneWorld,
  };
})(window.SNK = window.SNK || {});
