// ================================================================
//  cueclear.js — 后斯诺克：球杆被挡时，需要抬多高才能打到击点
//
//  旧模型（已废弃）把下半球直接判死。真实台球不是这样：
//  白球背后贴着一颗球时，低杆仍然能打，只是球杆必须抬得很高，
//  让杆身从挡球上方跨过去。杆越低，越只能打白球上部；杆抬到足够
//  角度，整个球面都能打，代价是力量损失、出杆更陡。
//
//  几何：白球半径 R，杆身半径约 0.42R。杆身是一条直线，挡球是一个
//  半径 R 的球。要求"杆中心线到挡球球心的距离 ≥ 1.42R"。
//  对给定的击点（sx, sy，单位 R）解出所需的最小仰角。
//
//  库边同理：杆身越过库边顶（约 1.7R）时，中心线至少要到
//  (1.7 + 0.42)R = 2.12R。
//
//  物理、AI 模拟、人类预览共用一个 fitContact()：它把击点限制在
//  60° 仰角还能打到的范围内，并返回实际要用的仰角。
// ================================================================
(function (SNK) {
  'use strict';
  if (!SNK) return;

  const C = SNK;
  const R = C.BALL_R;
  const SPIN_MAX = C.SPIN_MAX;

  const SHAFT_R = R * 0.42;
  const CLEAR_BALL = 1 + SHAFT_R / R;          // 1.42，归一化到 R
  const RAIL_TOP = R * 1.7;                    // 库边顶面离台呢高度
  const CLEAR_RAIL = (RAIL_TOP + SHAFT_R) / R; // 2.12
  const MAX_DIST = R * 60;                     // 球杆长度量级：再远的障碍不用管
  const LATERAL_MAX = R * (CLEAR_BALL + 2 * SPIN_MAX + 0.2); // 侧偏再大也碰不到
  const DEG = 180 / Math.PI;
  const PITCH_MAX_RAD = C.PITCH_MAX_DEG / DEG;
  // 人类纯手动模式的最小门槛：低于这个角度（远处库边的几何余量）
  // 自动抬掉，不必让玩家为 2° 去拧俯仰环；真正的球/近库才要求手动。
  const MANUAL_MIN_DEG = 6;

  const IDLE = Object.freeze({
    blocked: false, obstacles: [], kind: '', blocker: null,
  });

  // 白球中心到最近库边的"球心边界"距离；贴库时 0。
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

  // ================================================================
  //  挡球：杆中心线到球心的距离
  //    d² = (B−sx)² + (A·sinθ + sy·cos²θ)²       （单位 R）
  //  要求 d ≥ CLEAR_BALL，解出 θ。
  //  A = 挡球中心到白球中心的"身后"距离（R 为单位）
  //  B = 横向偏移（带符号，R 为单位）
  // ================================================================
  function ballRequiredDeg(A, B, sx, sy) {
    const dw = B - sx;
    if (Math.abs(dw) >= CLEAR_BALL) return 0;   // 杆从旁边过，不用抬
    // 平杆时杆身到球心的距离已经是 sqrt(dw² + sy²)；够远就不用抬。
    if (dw * dw + sy * sy >= CLEAR_BALL * CLEAR_BALL) return 0;
    const M = Math.sqrt(Math.max(0, CLEAR_BALL * CLEAR_BALL - dw * dw));
    let u;                                      // u = sinθ
    if (Math.abs(sy) < 1e-9) {
      u = M / A;
    } else {
      // sy·u² − A·u + (M − sy) = 0
      const disc = A * A + 4 * sy * sy - 4 * sy * M;
      if (disc < 0) return 90;
      const sq = Math.sqrt(disc);
      u = (A - sq) / (2 * sy);
      if (u <= 0) return 0;                 // 平杆已经够远（近擦边）
      if (u > 1) {
        const u2 = (A + sq) / (2 * sy);
        if (u2 > 0 && u2 <= 1) u = u2;
        else return 90;
      }
    }
    if (u > 1) return 90;
    return Math.asin(u) * DEG;
  }

  // ================================================================
  //  库边：杆在库边处的中心线高度
  //    h/R = 1 + sy·cosθ + S·tanθ
  //  要求 h/R ≥ CLEAR_RAIL，即 sy·cosθ + S·tanθ ≥ CLEAR_RAIL − 1。
  //  S = 白球中心到库边内侧的横向距离（R 为单位）；贴库时 S = 1。
  // ================================================================
  function railRequiredDeg(S, sy) {
    const target = CLEAR_RAIL - 1;
    let lo = 0, hi = Math.PI / 2 - 1e-4;
    const val = (t) => sy * Math.cos(t) + S * Math.tan(t);
    if (val(lo) >= target) return 0;
    if (val(hi) < target) return 90;
    for (let i = 0; i < 26; i++) {
      const mid = (lo + hi) / 2;
      if (val(mid) >= target) hi = mid; else lo = mid;
    }
    return hi * DEG;
  }

  // ================================================================
  //  analyze(balls, cue, angle)
  //  找出所有可能挡住球杆的球和身后库边。只收集几何，不解角度；
  //  角度由 requiredInfo()/fitContact() 按击点现算（很快）。
  // ================================================================
  function analyze(balls, cue, angle) {
    if (!cue || !cue.isOnTable || !cue.isOnTable()) return IDLE;
    if (!Array.isArray(balls) || !balls.length) return IDLE;

    const ang = Number.isFinite(angle) ? angle : 0;
    const hx = Math.cos(ang), hy = Math.sin(ang);
    const wx = -hy, wy = hx;                 // 横向单位向量

    const obstacles = [];
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (!b || b === cue) continue;
      if (!b.isOnTable || !b.isOnTable()) continue;
      const rx = b.x - cue.x, ry = b.y - cue.y;
      const along = -(rx * hx + ry * hy);     // 在身后多远（中心距）
      if (along <= 0 || along > MAX_DIST) continue;
      const lateral = rx * wx + ry * wy;
      if (Math.abs(lateral) > LATERAL_MAX) continue;
      obstacles.push({
        kind: 'ball',
        A: along / R,
        B: lateral / R,
        blocker: b,
      });
    }

    // 身后最近的一条库边
    const railT = railDistance(cue, -hx, -hy);
    if (isFinite(railT)) {
      const sFace = railT + R;                // 球心 → 库边内侧
      if (sFace <= MAX_DIST) {
        obstacles.push({ kind: 'rail', S: sFace / R, blocker: null });
      }
    }

    return {
      blocked: obstacles.length > 0,
      obstacles: obstacles,
      kind: '',
      blocker: null,
    };
  }

  // ================================================================
  //  requiredInfo(clear, sx, sy) → { deg, kind, blocker }
  //  打这个击点所需的最小仰角（取所有障碍里最大的）。
  // ================================================================
  function requiredInfo(clear, sx, sy) {
    if (!clear || !clear.obstacles || !clear.obstacles.length) {
      return { deg: 0, kind: '', blocker: null };
    }
    sx = Number.isFinite(sx) ? sx : 0;
    sy = Number.isFinite(sy) ? sy : 0;
    let best = 0, kind = '', blocker = null;
    for (let i = 0; i < clear.obstacles.length; i++) {
      const o = clear.obstacles[i];
      const deg = o.kind === 'ball'
        ? ballRequiredDeg(o.A, o.B, sx, sy)
        : railRequiredDeg(o.S, sy);
      if (deg > best + 1e-9) {
        best = deg;
        kind = o.kind;
        blocker = o.blocker || null;
      }
    }
    return { deg: best, kind: kind, blocker: blocker };
  }

  function requiredPitchDeg(clear, sx, sy) {
    return requiredInfo(clear, sx, sy).deg;
  }

  // 在 60° 仰角内，当前 sx 下能打到的最低 sy。
  // 供加塞盘画"永久打不到"的阴影（通常没有，只有极限组合才会出现）。
  function minReachableSy(clear, sx) {
    if (!clear || !clear.obstacles || !clear.obstacles.length) return -SPIN_MAX;
    const at = (y) => requiredInfo(clear, sx, y).deg / DEG; // 弧度
    if (at(SPIN_MAX) > PITCH_MAX_RAD) return SPIN_MAX + 0.001;
    if (at(-SPIN_MAX) <= PITCH_MAX_RAD) return -SPIN_MAX;
    let lo = -SPIN_MAX, hi = SPIN_MAX;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (at(mid) > PITCH_MAX_RAD) lo = mid; else hi = mid;
    }
    return hi;
  }

  // ================================================================
  //  fitContact(clear, sx, sy, pitchRad, autoRaise)
  //  物理/预览/AI 共用的入口。
  //
  //  autoRaise = true  —— AI：把仰角自动抬到 max(玩家设置, 所需)，不挡杆。
  //  autoRaise = false —— 人类：**纯手动**。仰角不够就返回 ok:false，
  //                      让 main.js 拒绝出杆并提示"抬到 X°"。
  //
  //  两种情况都把 60° 仍够不到的极点击点往高杆方向抬。
  // ================================================================
  function fitContact(clear, sx, sy, pitchRad, autoRaise) {
    let px = C.clamp(Number.isFinite(sx) ? sx : 0, -SPIN_MAX, SPIN_MAX);
    let py = C.clamp(Number.isFinite(sy) ? sy : 0, -SPIN_MAX, SPIN_MAX);
    const basePitch = Number.isFinite(pitchRad) ? Math.max(0, pitchRad) : 0;

    let info = requiredInfo(clear, px, py);
    let req = info.deg / DEG;
    let clamped = false;

    if (req > PITCH_MAX_RAD + 1e-6) {
      clamped = true;
      // 先固定 sx，把 sy 往上抬
      const topReq = requiredInfo(clear, px, SPIN_MAX).deg / DEG;
      if (topReq <= PITCH_MAX_RAD) {
        let lo = py, hi = SPIN_MAX;
        for (let i = 0; i < 22; i++) {
          const mid = (lo + hi) / 2;
          if (requiredInfo(clear, px, mid).deg / DEG > PITCH_MAX_RAD) lo = mid;
          else hi = mid;
        }
        py = hi;
      } else {
        // 侧偏也帮不上/挡得更死：收到中心，再抬杆
        px = 0;
        let lo = -SPIN_MAX, hi = SPIN_MAX;
        if (requiredInfo(clear, px, hi).deg / DEG > PITCH_MAX_RAD) {
          py = SPIN_MAX;
        } else {
          for (let i = 0; i < 22; i++) {
            const mid = (lo + hi) / 2;
            if (requiredInfo(clear, px, mid).deg / DEG > PITCH_MAX_RAD) lo = mid;
            else hi = mid;
          }
          py = hi;
        }
      }
      info = requiredInfo(clear, px, py);
      req = info.deg / DEG;
    }

    // 人类纯手动：仰角低于要求就不让出杆，不偷偷替玩家抬。
    // 但 6° 以下只是远处库边的几何余量，自动带过，避免每杆都要拧俯仰。
    if (!autoRaise && req > basePitch + 1e-6 && req * DEG >= MANUAL_MIN_DEG) {
      return {
        sx: px,
        sy: py,
        pitchRad: basePitch,
        requiredRad: req,
        requiredDeg: req * DEG,
        kind: info.kind,
        blocker: info.blocker,
        ok: false,
        needMore: true,
        raised: false,
        clamped: clamped,
      };
    }

    // 极端包围下 req 仍可能超过 60°；杆角以 60° 封顶，避免 cos 越界。
    const pitch = Math.min(Math.max(basePitch, req), PITCH_MAX_RAD);
    return {
      sx: px,
      sy: py,
      pitchRad: pitch,
      requiredRad: req,
      requiredDeg: req * DEG,
      kind: info.kind,
      blocker: info.blocker,
      ok: true,
      needMore: false,
      raised: pitch > basePitch + 1e-6,
      clamped: clamped,
    };
  }

  C.cueClear = {
    SHAFT_R: SHAFT_R,
    CLEAR_BALL: CLEAR_BALL,
    CLEAR_RAIL: CLEAR_RAIL,
    MANUAL_MIN_DEG: MANUAL_MIN_DEG,
    analyze: analyze,
    requiredInfo: requiredInfo,
    requiredPitchDeg: requiredPitchDeg,
    minReachableSy: minReachableSy,
    fitContact: fitContact,
  };
})(window.SNK = window.SNK || {});
