// ================================================================
//  physics.js — 球体 + 加塞物理步进
//
//  设计要点：实机主循环与 AI 模拟**共用同一个 stepWorld()**。
//  实机每帧调一次；模拟器克隆球数组后循环调用。同一份算术，
//  所以 AI 的预判 = 真实结果，不存在"AI 算错了"或作弊。
//
//  规则副作用（加分/犯规/复位）一律不在这里做——交由 rules.js。
// ================================================================
(function (SNK) {
  'use strict';

  const C = SNK;
  const BALL_R = C.BALL_R;
  const L = C.L, R = C.R, T = C.T, B = C.B;

  // ================================================================
  //  Ball
  // ================================================================
  class Ball {
    constructor(x, y, label) {
      this.x = x; this.y = y;
      this.r = BALL_R;
      this.label = label;
      this.color = C.COL[label];
      this.vx = 0; this.vy = 0;
      this.active = true;
      this.potted = false;
      // 上一子步的位置与位移（扫掠落袋判定 + 球球碰撞反推接触时刻）
      this.px = x; this.py = y;
      this.pdx = 0; this.pdy = 0;
      // 角速度（rad/帧）。坐标：x/y 是台面两轴，z 是竖直轴。
      //   wx, wy —— 平面内旋转，决定"滑动 / 纯滚动 / 高低杆"
      //   wz      —— 绕竖轴的侧旋，决定加塞的 throw 与库边踢球
      this.wx = 0; this.wy = 0; this.wz = 0;
      // 最近一次击球的击点偏移（单位球半径）。只给 UI/渲染/存档用，
      // 不参与物理 —— 物理只认上面的角速度。
      this.sx = 0; this.sy = 0;
    }
    get speed() { return Math.hypot(this.vx, this.vy); }
    get value() { return C.COL_VAL[this.label] || 0; }
    get isColor() { return this.label !== 'red' && this.label !== 'white'; }
    isOnTable() { return this.active && !this.potted; }
    reset(x, y) {
      this.x = x; this.y = y;
      this.vx = 0; this.vy = 0;
      this.wx = 0; this.wy = 0; this.wz = 0;
      this.sx = 0; this.sy = 0;
      this.active = true; this.potted = false;
      this.px = x; this.py = y;
      this.pdx = 0; this.pdy = 0;
    }
  }

  // ================================================================
  //  克隆（模拟用；复用目标对象避免每次 GC）
  // ================================================================
  function cloneBalls(src, dst) {
    if (!dst || dst.length !== src.length) {
      dst = src.map(b => new Ball(b.x, b.y, b.label));
    }
    for (let i = 0; i < src.length; i++) {
      const s = src[i], d = dst[i];
      d.x = s.x; d.y = s.y;
      d.label = s.label; d.color = s.color;
      d.vx = s.vx; d.vy = s.vy;
      d.wx = s.wx; d.wy = s.wy; d.wz = s.wz;
      d.sx = s.sx; d.sy = s.sy;
      d.active = s.active; d.potted = s.potted;
      d.px = s.x; d.py = s.y;
      d.pdx = 0; d.pdy = 0;
    }
    return dst;
  }

  // ================================================================
  //  击点归一化：物理、预览、2D/3D 红点共用同一份夹紧规则。
  //  返回 {sx, sy, off, cos}：
  //    cos = sqrt(1 - |s|²)，即击点到球心的法向分量（球面投影用）
  // ================================================================
  function effectiveTip(sx, sy, pitch) {
    sx = Number.isFinite(sx) ? sx : 0;
    sy = Number.isFinite(sy) ? sy : 0;
    sx = C.clamp(sx, -C.SPIN_MAX, C.SPIN_MAX);
    sy = C.clamp(sy, -C.SPIN_MAX, C.SPIN_MAX);
    if (Number.isFinite(pitch) && pitch > 0) {
      sy = C.clamp(sy + Math.sin(pitch) * C.PITCH_FOLLOW_K, -C.SPIN_MAX, C.SPIN_MAX);
    }
    const off = Math.hypot(sx, sy);
    if (off > C.SPIN_MAX) {
      const k = C.SPIN_MAX / off;
      sx *= k; sy *= k;
    }
    return { sx: sx, sy: sy, off: Math.min(off, C.SPIN_MAX),
             cos: Math.sqrt(Math.max(0, 1 - sx * sx - sy * sy)) };
  }

  // ================================================================
  //  击球：把击点偏移变成白球的线速度 + 角速度
  //    angle  — 瞄准方向（弧度）
  //    power  — 力度（0..MAX_POWER）
  //    sx, sy — 击点偏移（单位球半径），|s| <= SPIN_MAX
  //    pitch  — 杆身俯仰（弧度，可选）
  //    balls  — 球局数组（可选）。给了就检查"背后有没有球/库边挡杆"，
  //             按 cueclear.js 的可击球面把击点夹到允许区域。
  //             与 stepWorld 一样，实机和 AI 模拟共用这一份夹紧规则。
  //
  //  实心球绕球心的转动惯量 I = 2/5 mR²。球杆给球心的冲量 J 同时给出
  //  角冲量 J·sR（s 以 R 为单位），所以
  //      ω = J·sR / I = (5/2)·s·v/R
  //  高杆 sy>0 → 前滚角速度；低杆 sy<0 → 后滚；右塞 sx>0 → ωz<0。
  // ================================================================
  function strike(cue, angle, power, sx, sy, pitch, balls, autoRaise) {
    // 玩家主动设置的俯仰。只有这部分带来 PITCH_FOLLOW_K 的高杆增量；
    // 被障碍"强迫"抬上去的角度只损失力量，不偷偷改写玩家选的击点。
    const manualPitch = Number.isFinite(pitch) ? Math.max(0, pitch) : 0;
    let actualPitch = manualPitch;

    // 后斯诺克：球杆被背后的球/库边挡住时，低杆不是不能打，
    // 而是必须把杆抬到足够角度。fitContact() 解出这个最小仰角，
    // 并把 60° 都够不到的极点击点往高杆方向抬。
    if (balls && C.cueClear) {
      const clear = C.cueClear.analyze(balls, cue, angle);
      // 默认自动抬杆（AI / 模拟）；人类实机由 main.js 传 false，自己抬够。
      const fit = C.cueClear.fitContact(clear, sx, sy, manualPitch, autoRaise !== false);
      sx = fit.sx;
      sy = fit.sy;
      actualPitch = fit.pitchRad;
    }
    // 高杆增量按玩家的主动俯仰算；实际杆角只负责 cos 力量损失。
    const tip = effectiveTip(sx, sy, manualPitch);
    sx = tip.sx; sy = tip.sy;

    const off = tip.off;
    const pw = Number.isFinite(power) ? C.clamp(power, 0, C.MAX_POWER) : 0;
    const ang = Number.isFinite(angle) ? angle : 0;

    // 偏杆：出杆瞬间球头偏离球心，白球朝塞的反方向偏出去（squirt）
    const squirt = -sx * C.SQUIRT_K;
    // 击点越偏，传递到球心的力量越少；抬杆还有 cos(俯仰) 的前向分量损失
    let speed = pw * (1 - C.SPIN_POWER_LOSS * off / C.SPIN_MAX);
    if (actualPitch > 0) speed *= Math.cos(actualPitch);
    const a = ang + squirt;

    cue.vx = Math.cos(a) * speed;
    cue.vy = Math.sin(a) * speed;

    // ω = (5/2)·s·v/R。高杆绕 +y、右塞绕 -z：
    //   滚动关系 vx = R·wy, vy = -R·wx  →  sy=0.4 恰好产生纯滚动
    const k = 2.5 * speed / BALL_R;
    cue.wx = -k * sy * Math.sin(a);
    cue.wy =  k * sy * Math.cos(a);
    cue.wz = -k * sx;

    // 数值兜底：任何 NaN/Infinity 都不能进入物理循环
    if (!Number.isFinite(cue.vx)) cue.vx = 0;
    if (!Number.isFinite(cue.vy)) cue.vy = 0;
    if (!Number.isFinite(cue.wx)) cue.wx = 0;
    if (!Number.isFinite(cue.wy)) cue.wy = 0;
    if (!Number.isFinite(cue.wz)) cue.wz = 0;

    cue.sx = sx;
    cue.sy = sy;
    return cue;
  }

  // ================================================================
  //  预览轨迹的精确事件点
  //
  //  sim.js 每 2 帧才采一次样。满力时 2 帧能走 60px，而库边反弹发生在
  //  两帧之间 —— 只靠采样点，折线的拐角会画在离库边几十像素的地方。
  //  这里在**物理事件发生的那一刻**把球心位置直接塞进预览路径，
  //  折线的拐角就永远落在真正的接触点上（球心距库 1 个半径）。
  //
  //  只有 sim 克隆出来的球带 __path；实机球、AI 搜索、跑分都没有这个字段，
  //  markPath 走一次 falsy 判断就返回，不影响物理结果。
  // ================================================================
  function markPath(b, x, y) {
    const p = b.__path;
    if (!p) return;
    const q = p[p.length - 1];
    if (q && Math.abs(q.x - x) < 0.01 && Math.abs(q.y - y) < 0.01) return;
    p.push({ x: x, y: y });
  }

  // ================================================================
  //  袋口判定
  //  规则：**球心进入袋口捕获圈即落袋**，圈半径 = 真实袋口半宽。
  //    · 角袋捕获圆心就是台面角点，圈几乎全在台面外，
  //      只有贴库的球才够得着 → 台中间的球永远不会被"吸"进去
  //    · 中袋圆心在库边上，贴库横穿中袋口的球会正常掉进去（真台也这样）
  //  老版本是"球面触到库边平面 + 在袋口窗口内"两条条件，
  //  窗口宽到 2.55 个球径，于是贴库滚动的球路过中袋就被吞掉。
  // ================================================================
  // ★ 必须做**扫掠**判定（上一位置 → 当前位置 的整条线段），不能只看落点 ★
  //  一次子步位移最多 3.75px，而擦着袋口走的球，弦长可以短到零点几像素：
  //  球心从距袋心 16.30 跳到另一侧 16.30，中间一次都没有端点落在
  //  半径 16.4 的圈内 —— 于是"进不进"取决于子步格子怎么切，
  //  而子步数又随最快球速变化。实测：力度改 0.5%，一半的球结果就翻转，
  //  而且**非单调**（×1.005 不进、×1.015 反而进），正是这种走样。
  //  改成线段判定后，只要球心路径真正穿过袋口圈就算进，与子步无关。
  function captureCheck(b, ev) {
    const ax = b.px, ay = b.py;
    const mx = b.x - ax, my = b.y - ay;
    const len2 = mx * mx + my * my;
    for (let i = 0; i < C.pockets.length; i++) {
      const p = C.pockets[i];
      let t = 0;
      if (len2 > 1e-12) {
        t = ((p.x - ax) * mx + (p.y - ay) * my) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
      }
      const cx = ax + mx * t, cy = ay + my * t;
      const dx = cx - p.x, dy = cy - p.y;
      if (dx * dx + dy * dy < p.mouth * p.mouth) {
        // 预览轨迹要停在**扫掠线段真正穿过袋口捕获圈的哪一点**，
        // 而不是停在四帧采样点（球已经飞出袋口一大截）。
        markPath(b, cx, cy);
        return potBall(b, ev);
      }
    }
    return false;
  }

  function potBall(b, ev) {
    b.potted = true;
    b.active = false;
    b.vx = 0; b.vy = 0;
    b.wx = 0; b.wy = 0; b.wz = 0;
    b.sx = 0; b.sy = 0;
    b.px = b.x; b.py = b.y;
    ev.potted.push(b.label);
    return true;
  }

  // ================================================================
  //  库边袋口缺口
  //
  //  原来四条库边是整条实边，球心被死死钳在离库 1 个球半径处。
  //  角袋的捕获圆心在**台面角点**上（例如 (28,708)），于是贴库滚向
  //  角袋的球，球心离袋口中心最近只剩 hypot(10,10)=14.1px，看着已经在
  //  16.4 的捕获圈里，可它一斜着过来库边就先把它弹回去了，球心停在
  //  ~19.7px 处——永远够不着。-trace 实测：AI 判定能进的球里，
  //  失败的 57/57 全是「根本没走到袋口」，不是判定漏判。
  //
  //  修法：库边在袋口处开缺口。缺口半宽取
  //      hw = sqrt(mouth² − r²)
  //  于是球心一越过库边线就**已经在捕获圈内**，必然判进；反之在缺口
  //  之外仍照旧钳住。这样既不会出现"球从缺口漏出台面却没落袋"，
  //  也不会把袋口开得比捕获圈还宽。
  // ================================================================
  const GAPS = { top: [], bottom: [], left: [], right: [] };
  (function buildGaps() {
    for (let i = 0; i < C.pockets.length; i++) {
      const p = C.pockets[i];
      const hw = Math.sqrt(Math.max(0, p.mouth * p.mouth - BALL_R * BALL_R));
      if (Math.abs(p.y - T) < 0.5) GAPS.top.push({ c: p.x, hw: hw });
      if (Math.abs(p.y - B) < 0.5) GAPS.bottom.push({ c: p.x, hw: hw });
      if (Math.abs(p.x - L) < 0.5) GAPS.left.push({ c: p.y, hw: hw });
      if (Math.abs(p.x - R) < 0.5) GAPS.right.push({ c: p.y, hw: hw });
    }
  })();

  // 球心 (x,y) 是否落在 rail 这条库的某个袋口缺口里（是则该库对它不生效）
  function inGap(x, y, rail) {
    const along = (rail === 'top' || rail === 'bottom') ? x : y;
    const list = GAPS[rail];
    for (let i = 0; i < list.length; i++) {
      if (Math.abs(along - list[i].c) < list[i].hw) return true;
    }
    return false;
  }

  // 球心是否已经在某个袋口的捕获圈里（摆放/复位时用来避开袋口）
  function inPocketMouth(x, y) {
    for (let i = 0; i < C.pockets.length; i++) {
      const p = C.pockets[i];
      if (Math.hypot(x - p.x, y - p.y) < p.mouth + BALL_R) return true;
    }
    return false;
  }

  // 库边处理（落袋由 captureCheck 单独负责）
  function handleCushions(b, ev) {
    if (b.x - b.r < L && !inGap(b.x, b.y, 'left')) {          // 左库
      b.x = L + b.r;
      markPath(b, b.x, b.y);                    // 精确接触点（夹紧之后）
      applyBounce(b, 'left', ev);
    } else if (b.x + b.r > R && !inGap(b.x, b.y, 'right')) {  // 右库
      b.x = R - b.r;
      markPath(b, b.x, b.y);
      applyBounce(b, 'right', ev);
    }

    if (b.y - b.r < T && !inGap(b.x, b.y, 'top')) {           // 上库
      b.y = T + b.r;
      markPath(b, b.x, b.y);
      applyBounce(b, 'top', ev);
    } else if (b.y + b.r > B && !inGap(b.x, b.y, 'bottom')) { // 下库
      b.y = B - b.r;
      markPath(b, b.x, b.y);
      applyBounce(b, 'bottom', ev);
    }
  }

  // 库边：法向反弹 + 切向摩擦（库布会"咬"球，产生 throw / 加塞反弹角变化）
  //
  // 真实库边鼻线高于球心约 0.27R，接触点不在球心高度：
  //   r = (-R·n, h)（n 指向台内，接触点在球的外侧）
  //   u_t = v_t·(1 + h/R) - R·ωz
  // 侧旋越大，接触点切向速度越大，摩擦把球往塞的反方向推；
  // 同时摩擦冲量还绕过球心，给球加上/下旋 —— 这就是"加塞撞库后
  // 角度变化很大"的来源。
  // 低速撞库的最小回弹：现实中球不会"贴住库边一动不动"，而是至少弹开一点。
  // 物理上滚动摩擦会很快吃掉这点速度，但完全停在库边看起来像粘住。
  // 只在撞库瞬间法向速度很小时生效，不影响正常力度。
  const MIN_CUSHION_REBOUND = 0.6;

  function applyBounce(b, wall, ev) {
    let nx = 0, ny = 0;
    if (wall === 'left')   { nx = 1;  ny = 0; }
    else if (wall === 'right')  { nx = -1; ny = 0; }
    else if (wall === 'top')    { nx = 0;  ny = 1; }
    else                        { nx = 0;  ny = -1; }

    const vn = Math.abs(b.vx * nx + b.vy * ny);      // 撞击法向速度
    const tx = -ny, ty = nx;                          // 切向
    const vt = b.vx * tx + b.vy * ty;                 // 碰撞前切向速度
    const wz = b.wz;                                  // 碰撞前侧旋

    // 翻转法向分量（只是把撞进来的那一轴反向）。
    // vn 很小时给一个最小回弹，避免球在库边"粘住"；正常力度完全不受影响。
    const lowHit = vn > 0.02;
    if (wall === 'left') {
      b.vx = Math.abs(b.vx) * C.BOUNCE;
      if (lowHit) b.vx = Math.max(b.vx, MIN_CUSHION_REBOUND);
    } else if (wall === 'right') {
      b.vx = -Math.abs(b.vx) * C.BOUNCE;
      if (lowHit) b.vx = Math.min(b.vx, -MIN_CUSHION_REBOUND);
    } else if (wall === 'top') {
      b.vy = Math.abs(b.vy) * C.BOUNCE;
      if (lowHit) b.vy = Math.max(b.vy, MIN_CUSHION_REBOUND);
    } else {
      b.vy = -Math.abs(b.vy) * C.BOUNCE;
      if (lowHit) b.vy = Math.min(b.vy, -MIN_CUSHION_REBOUND);
    }

    const Jn = (1 + C.BOUNCE) * vn;                   // 法向冲量（速度单位）

    // 法向冲量作用在球心上方 h 处，必须同时给平面内旋转一个力矩：
    //   τ = r × J，r = (-R·n, h)，J = Jn·n
    //   Δω = (5/2)·h·Jn/R² · (-n_y, n_x)
    // 这一项是"滚着进库 → 平着出来(stun)"的来源。缺了它，白球撞库后
    // 会保留原来方向的滚动；沿新方向看就是莫名其妙的回旋/自转。
    const nk = 2.5 * C.CUSHION_H * Jn / (BALL_R * BALL_R);
    b.wx += nk * (-ny);
    b.wy += nk * nx;

    const ut = vt * (1 + C.CUSHION_H / BALL_R) - BALL_R * wz;

    // 粘滞解 Jt = -2·ut/7；超过库边摩擦上限就转为滑动摩擦
    let Jt = -2 * ut / 7;
    const lim = C.MU_CUSHION * Jn;
    if (Jt > lim) Jt = lim; else if (Jt < -lim) Jt = -lim;

    b.vx += Jt * tx;
    b.vy += Jt * ty;
    b.wz += -2.5 * Jt / BALL_R;

    // 接触高度 h 的切向冲量还会改变平面内旋转（加塞撞库 → 上/下旋）
    const hk = -2.5 * C.CUSHION_H * Jt / (BALL_R * BALL_R);
    b.wx += hk * nx;
    b.wy += hk * ny;

    if (ev.audioOn) ev.cushions.push({ x: b.x, y: b.y, v: vn, wall: wall });
    ev.bounces++;
  }

  // ================================================================
  //  球球碰撞（含白球跟杆/缩杆）
  //
  //  ★ 子步内反推真实接触时刻 ★
  //  旧写法是在"已经重叠"的构型上取球心连线当冲量法线，于是：
  //    球心连线被穿透量转歪了 —— 薄球尤其惨。定量地说，设切角 α、
  //    穿透 p，法线偏差 ≈ atan(p·sinα / (2R + p·cosα))。
  //    α=78°、p=5px（子步上限）时偏差高达 13°！
  //    而一颗离袋 400px 的目标球，方向容差只有 ±1° 左右。
  //  更糟的是 p 取决于子步数，子步数又由"全场最快球速"决定 ——
  //  于是**力度变 0.5% 就能把球打歪十几度**，这就是实测里
  //  "AI 判定能进、实际打丢"和"力度噪声一动成功率就腰斩"的真凶。
  //
  //  修法：子步内两球都是匀速直线运动，接触时刻可解析求出（二次方程），
  //  把球摆回那个精确接触点、按真正的球心连线给冲量，
  //  再把剩余 (1−t) 的子步位移按**碰撞后的新速度**补上。
  //  这样结果与子步划分无关，力度噪声只会影响力度本身。
  // ================================================================
  function resolveCollision(a, b, cueRef, ev, inv) {
    const rr = a.r + b.r;

    const st = inv || 1;
    // 用**实际位移**（stepOnce 里量好的），不是 v*dt —— 摩擦是在移动之后才
    // 扣的，且同一子步内先撞过别的球也会改速度，用速度反推会偏。
    const dax = a.pdx || 0, day = a.pdy || 0;
    const dbx = b.pdx || 0, dby = b.pdy || 0;
    const rx = (b.x - dbx) - (a.x - dax), ry = (b.y - dby) - (a.y - day); // 子步起点：相对位置
    const wx = dbx - dax, wy = dby - day;             // 子步内：相对位移
    const A = wx * wx + wy * wy;

    // ★ "本子步有没有接触"必须用**扫掠最近距离**判，不能用"移动后是否重叠"。
    //   重叠判据在 dist = rr 处是**断的**：重叠 0.001px → 判碰撞；
    //   分开 0.001px → 完全不判碰撞（白球直接穿过去）。
    //   慢球（短距离轻推）单子步位移只有零点几 px，第一次被检测到时穿透量
    //   本来就在 0 附近 —— 结果就是 0.0001rad（0.006°）的瞄准误差就能让
    //   17% 的球彻底打丢、目标球纹丝不动。扫掠判据是连续的，没有这个断点。
    let tSus = 0;
    if (A > 1e-12) {
      tSus = -(rx * wx + ry * wy) / A;
      if (tSus < 0) tSus = 0; else if (tSus > 1) tSus = 1;
    }
    const sx = rx + wx * tSus, sy = ry + wy * tSus;
    if (sx * sx + sy * sy > rr * rr) return;          // 本子步确实没碰上

    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return;

    let nx = dx / dist, ny = dy / dist;

    let hitT = -1;
    if (A > 1e-12) {
      const Bq = 2 * (rx * wx + ry * wy);
      const Cq = rx * rx + ry * ry - rr * rr;
      const disc = Bq * Bq - 4 * A * Cq;
      if (disc >= 0) {
        const t = (-Bq - Math.sqrt(disc)) / (2 * A);   // 取先到的那个根
        if (t >= 0 && t <= 1) hitT = t;
      }
    }

    if (hitT >= 0) {
      const cx = rx + wx * hitT, cy = ry + wy * hitT;
      const cd = Math.hypot(cx, cy);
      if (cd > 1e-6) {
        nx = cx / cd; ny = cy / cd;
        const back = 1 - hitT;
        a.x -= dax * back; a.y -= day * back;   // 退回精确接触位置
        b.x -= dbx * back; b.y -= dby * back;
      }
    } else if (dist < rr) {
      // 子步开始前就已重叠（例如贴球），退回老办法：沿球心连线推开
      const overlap = (rr - dist) / 2;
      a.x -= nx * overlap; a.y -= ny * overlap;
      b.x += nx * overlap; b.y += ny * overlap;
    }
    // 扫掠判据命中但当前并不重叠、又没解出接触时刻：不做位置修正，
    // 直接按当前球心连线方向处理冲量（连续，不会把两球反向怼到一起）

    // 记录白球首次接触（对齐原版：只要重叠就算碰到）
    if (cueRef && ev && !ev.firstContact) {
      if (a === cueRef) ev.firstContact = b;
      else if (b === cueRef) ev.firstContact = a;
    }

    const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
    const relVn = dvx * nx + dvy * ny;
    if (relVn <= 0) return;                          // 正在分离，不处理

    // 球球接触同样记录精确位置：两颗球都在**解出的接触构型**上留一个点，
    // 预览里的变向就不会偏向采样帧末尾。
    markPath(a, a.x, a.y);
    markPath(b, b.x, b.y);

    // ---- 音效事件（只在主循环开了 ev.audioOn 时才采集）----
    // 这一步是**零成本**的：AI 搜索 / 跑分 / headless 自己造的 ev 没有这个字段，
    // 走 falsy 分支直接跳过，连数组都不分配。所以 tools/bench.js 的数字一位都不会变。
    if (ev && ev.audioOn) {
      ev.hits.push({
        x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5,
        v: relVn,
        cue: (cueRef && (a === cueRef || b === cueRef)) ? 1 : 0,
        a: a.label, b: b.label,
      });
    }

    const impulse = relVn * C.BALL_RESTITUTION;

    // 切向摩擦（throw + 侧旋传递）
    //   u_t = 相对切向速度 + R·(ωa,z + ωb,z)
    //   粘滞解 Jt = -u_t/7；上限 μ·Jn
    //   Δωz = (5/2)·Jt/R —— 两侧球都受同一个方向的角冲量
    // 高低杆不再"撞完补速度"：撞击只交换法向冲量，白球残留的
    // 前滚/后滚角速度由台呢摩擦自然变成跟球/缩杆。
    const tx = -ny, ty = nx;
    const ut = dvx * tx + dvy * ty + BALL_R * (a.wz + b.wz);
    let Jt = -ut / 7;
    const lim = C.MU_BALL * impulse;
    if (Jt > lim) Jt = lim; else if (Jt < -lim) Jt = -lim;

    a.vx -= impulse * nx; a.vy -= impulse * ny;
    b.vx += impulse * nx; b.vy += impulse * ny;

    a.vx += Jt * tx; a.vy += Jt * ty;
    b.vx -= Jt * tx; b.vy -= Jt * ty;
    a.wz += 2.5 * Jt / BALL_R;
    b.wz += 2.5 * Jt / BALL_R;

    // 碰撞后把本子步剩下的 (1−t) 走完（用的是碰撞后的新速度）
    if (hitT >= 0 && hitT < 1) {
      const rest = (1 - hitT) * st;
      a.x += a.vx * rest; a.y += a.vy * rest;
      b.x += b.vx * rest; b.y += b.vy * rest;
    }
  }

  // ================================================================
  //  stepWorld —— 推进一帧
  //  ev = { potted:[], firstContact:null, bounces:0 }
  //  返回 true 表示还有球在动
  //
  //  高速时自动分子步：满力 30px/帧 而球直径只有 20px，
  //  一步跨过去就会**穿过**目标球（tunneling）。子步把单步位移
  //  压到 5px 以内，碰撞与落袋判定都准了。
  // ================================================================
  const SUB_MAX = 8;          // 最多分 8 个子步
  const SUB_STEP_PX = 5;      // 单个子步允许的最大位移

  function stepWorld(balls, ev) {
    const n = balls.length;

    let maxV = 0;
    for (let i = 0; i < n; i++) {
      const b = balls[i];
      if (!b.isOnTable()) continue;
      const v = Math.hypot(b.vx, b.vy);
      if (v > maxV) maxV = v;
    }

    const sub = maxV > SUB_STEP_PX ? Math.min(SUB_MAX, Math.ceil(maxV / SUB_STEP_PX)) : 1;
    const inv = 1 / sub;
    const spinDecay = sub === 1 ? C.SPIN_DECAY : Math.pow(C.SPIN_DECAY, inv);

    let moving = false;
    for (let s = 0; s < sub; s++) {
      if (stepOnce(balls, ev, inv, spinDecay)) moving = true;
    }
    return moving;
  }

  // ================================================================
  //  台呢上的单球推进（解析积分）
  //
  //  接触点滑移 u = (vx − R·wy, vy + R·wx)。
  //  滑动阶段：接触点摩擦把 u 以 2μg 的速率拉向 0，
  //  同时平动减速度 μg、角速度变化率 5μg/(2R)。
  //  纯滚动阶段：v 以 ROLL_DECEL 恒定减小，角速度始终满足 v = ω×r。
  //
  //  一个子步里若滑动阶段先结束（t_roll < dt），剩下的时间按纯滚动走。
  //  位置用每段的首末速度平均积分，比"先移动再扣摩擦"更准，
  //  而且 pdx/pdy 仍是实际位移，CCD 不受影响。
  // ================================================================
  function advanceBall(b, dt, spinDecay) {
    const R = BALL_R;
    const mu = C.MU_SLIDE, g = C.G_PX;

    let vx = b.vx, vy = b.vy;
    let wx = b.wx, wy = b.wy;
    let dx = 0, dy = 0;

    const ux = vx - R * wy;
    const uy = vy + R * wx;
    const us = Math.hypot(ux, uy);

    if (us > C.SLIP_EPS) {
      const tRoll = 2 * us / (7 * mu * g);
      const tSlide = Math.min(dt, tRoll);
      const uhx = ux / us, uhy = uy / us;

      const dv = mu * g * tSlide;
      const v1x = vx - uhx * dv;
      const v1y = vy - uhy * dv;
      const dw = 5 * mu * g * tSlide / (2 * R);
      const w1x = wx - uhy * dw;
      const w1y = wy + uhx * dw;
      dx += (vx + v1x) * 0.5 * tSlide;
      dy += (vy + v1y) * 0.5 * tSlide;
      vx = v1x; vy = v1y; wx = w1x; wy = w1y;

      if (tSlide < dt) {
        // 滑动结束 → 锁到纯滚动，再走剩余时间
        wy = vx / R; wx = -vy / R;
        const t2 = dt - tSlide;
        const sp = Math.hypot(vx, vy);
        const sp2 = Math.max(0, sp - C.ROLL_DECEL * t2);
        const k = sp > 1e-12 ? sp2 / sp : 0;
        const v2x = vx * k, v2y = vy * k;
        dx += (vx + v2x) * 0.5 * t2;
        dy += (vy + v2y) * 0.5 * t2;
        vx = v2x; vy = v2y;
        if (sp2 > 0) { wy = vx / R; wx = -vy / R; }
        else { wx = 0; wy = 0; }
      }
    } else {
      // 已经是纯滚动（或滑移可忽略）
      wy = vx / R; wx = -vy / R;
      const sp = Math.hypot(vx, vy);
      const sp2 = Math.max(0, sp - C.ROLL_DECEL * dt);
      const k = sp > 1e-12 ? sp2 / sp : 0;
      const v2x = vx * k, v2y = vy * k;
      dx += (vx + v2x) * 0.5 * dt;
      dy += (vy + v2y) * 0.5 * dt;
      vx = v2x; vy = v2y;
      if (sp2 > 0) { wy = vx / R; wx = -vy / R; }
      else { wx = 0; wy = 0; }
    }

    // 侧旋：运动中按指数缓慢衰减；球已停下时接触斑静摩擦迅速吃掉它
    if (b.wz !== 0) {
      const still = Math.hypot(vx, vy) < C.MIN_SPEED && us <= C.SLIP_EPS;
      b.wz *= Math.pow(still ? 0.88 : C.SPIN_DECAY, dt);
      if (still && Math.abs(b.wz) < 0.2) b.wz = 0;
    }

    // 数值兜底
    if (!Number.isFinite(vx)) vx = 0;
    if (!Number.isFinite(vy)) vy = 0;
    if (!Number.isFinite(wx)) wx = 0;
    if (!Number.isFinite(wy)) wy = 0;
    if (!Number.isFinite(b.wz)) b.wz = 0;

    b.vx = vx; b.vy = vy;
    b.wx = wx; b.wy = wy;
    b.x += dx; b.y += dy;

    // 停球：线速度、接触点滑移、侧旋都小到可忽略才真正静止。
    // 只判 v 会把"原地后旋"误判成静止 —— 那正是缩杆反拉的来源。
    //
    // ★ 快到库边的低速球不能在这里清零 ★
    //   advanceBall 在 handleCushions 之前执行。如果球以低于 MIN_SPEED 的
    //   速度滚到库边附近，先被这里清零，下一句 handleCushions 只把位置
    //   钳到库边、applyBounce 看到 vn=0 什么也不做 —— 球就"贴在库边不动"。
    //   现实中的球会至少弹一下。所以：只要还在朝库边方向移动，就留到
    //   库边处理完再决定是否停。
    const nearRail =
      (b.x - b.r <= L + 1.2 && vx < 0) ||
      (b.x + b.r >= R - 1.2 && vx > 0) ||
      (b.y - b.r <= T + 1.2 && vy < 0) ||
      (b.y + b.r >= B - 1.2 && vy > 0);
    const sp = Math.hypot(vx, vy);
    const slip = Math.hypot(vx - R * wy, vy + R * wx);
    if (!nearRail && sp < C.MIN_SPEED && slip < C.STOP_SPIN && Math.abs(b.wz) < 0.2) {
      b.vx = 0; b.vy = 0;
      b.wx = 0; b.wy = 0; b.wz = 0;
    }
  }

  function isMotionless(b) {
    return b.vx === 0 && b.vy === 0 &&
           b.wx === 0 && b.wy === 0 && b.wz === 0;
  }

  function stepOnce(balls, ev, inv, spinDecay) {
    const n = balls.length;
    let moving = false;

    // 1) 运动 + 台呢摩擦 + 落袋 + 库边
    for (let i = 0; i < n; i++) {
      const b = balls[i];
      b.pdx = 0; b.pdy = 0;
      if (!b.isOnTable()) { b.px = b.x; b.py = b.y; continue; }
      if (isMotionless(b)) { b.px = b.x; b.py = b.y; continue; }
      moving = true;
      b.px = b.x; b.py = b.y;          // 套用扫掠落袋判定 / 球球碰撞反推接触时刻

      advanceBall(b, inv, spinDecay);
      b.pdx = b.x - b.px;
      b.pdy = b.y - b.py;

      // 先判落袋（此时还没被库边弹回，位置是真实的穿透位置），再判库边
      if (captureCheck(b, ev)) continue;
      handleCushions(b, ev);

      // 兜底：万一球心跑到库外（理论上不该发生），强制落袋，绝不丢失
      if (b.isOnTable() && (b.x < L - 1 || b.x > R + 1 || b.y < T - 1 || b.y > B + 1)) {
        potBall(b, ev);
      }
    }

    // 2) 球球碰撞
    const cueRef = ev.cueBall;
    for (let i = 0; i < n; i++) {
      const a = balls[i];
      if (!a.isOnTable()) continue;
      for (let j = i + 1; j < n; j++) {
        const b = balls[j];
        if (!b.isOnTable()) continue;
        if (isMotionless(a) && isMotionless(b)) continue;
        resolveCollision(a, b, cueRef, ev, inv);
      }
    }

    return moving;
  }

  // ================================================================
  //  摆放辅助
  // ================================================================
  function ballOverlaps(balls, x, y, exclude, pad) {
    pad = pad === undefined ? 1.5 : pad;
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b === exclude || !b.isOnTable()) continue;
      if (Math.hypot(x - b.x, y - b.y) < BALL_R * 2 + pad) return true;
    }
    return false;
  }

  // ================================================================
  //  彩球复位（WPBSA Rule 7）
  //
  //  旧实现用 tryPlace()：从自己的点位开始，只试 ±4/8/12/16px 的十字偏移，
  //  全部失败就**把球留在袋里**。白球正好停在黑球点位时，黑球就会直接消失。
  //
  //  正确规则：
  //    1. 自己的点位空着 → 放自己的点位；
  //    2. 自己的点位被占（包括被白球占）→ 放**分值最高的空点位**；
  //    3. 所有点位都被占 → 沿自己的点位朝顶库（本作 +X 方向）找最近的空位，
  //       仍找不到就绕自己的点位找最近的不接触其他球的位置。
  //  多个彩球同时复位时，调用方按分值从高到低依次调用本函数。
  // ================================================================
  const SPOT_PRIORITY = ['black', 'pink', 'blue', 'brown', 'green', 'yellow'];

  function canPlaceAt(balls, ball, x, y) {
    if (x < L + BALL_R || x > R - BALL_R) return false;
    if (y < T + BALL_R || y > B - BALL_R) return false;
    if (inPocketMouth(x, y)) return false;
    // 规则要求复位后不能和其他球接触；留 0.5px 余量避免浮点"刚好相切"
    return !ballOverlaps(balls, x, y, ball, 0.5);
  }

  function respotColor(balls, ball, label) {
    const own = C.getColorPos(label);
    if (!own) return false;

    // 1) 自己的点位；2) 其余点位按分值从高到低
    const order = [label].concat(SPOT_PRIORITY.filter(l => l !== label));
    for (let i = 0; i < order.length; i++) {
      const p = C.getColorPos(order[i]);
      if (p && canPlaceAt(balls, ball, p.x, p.y)) {
        ball.reset(p.x, p.y);
        return true;
      }
    }

    // 3a) 沿自己的点位朝顶库（+X）找最近的空位
    for (let x = own.x + 1; x <= R - BALL_R; x += 1) {
      if (canPlaceAt(balls, ball, x, own.y)) {
        ball.reset(x, own.y);
        return true;
      }
    }

    // 3b) 最后绕自己的点位向外找；正常球局走不到这里
    for (let r = 2; r <= BALL_D * 10; r += 2) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) {
        const x = own.x + Math.cos(a) * r;
        const y = own.y + Math.sin(a) * r;
        if (canPlaceAt(balls, ball, x, y)) {
          ball.reset(x, y);
          return true;
        }
      }
    }

    // 极端兜底：宁可和其他球接触，也不能让球从台面上消失
    ball.reset(own.x, own.y);
    return false;
  }

  function tryPlace(balls, ball, tx, ty) {
    const offsets = [[0,0],[4,0],[-4,0],[0,4],[0,-4],[8,0],[-8,0],[0,8],[0,-8],
                     [12,0],[-12,0],[0,12],[0,-12],[16,0],[-16,0],[0,16],[0,-16]];
    for (const off of offsets) {
      const nx = C.clamp(tx + off[0], L + BALL_R, R - BALL_R);
      const ny = C.clamp(ty + off[1], T + BALL_R, B - BALL_R);
      if (inPocketMouth(nx, ny)) continue;      // 别把球复位到袋口里
      if (!ballOverlaps(balls, nx, ny, ball)) {
        ball.reset(nx, ny);
        return true;
      }
    }
    return false;
  }

  // 8-ball 自由球：在台面中部附近找最近空位摆白球
  function placeCueBallInHand(balls, cueBall) {
    const spots = [
      [C.CX2, C.CY2],
      [C.BAULK_X, C.CY2],
      [C.BAULK_X - 80, C.CY2 - 100],
      [C.BAULK_X - 80, C.CY2 + 100],
      [C.CX2 - 180, C.CY2],
      [C.CX2 + 180, C.CY2],
    ];
    for (let i = 0; i < spots.length; i++) {
      const x = spots[i][0], y = spots[i][1];
      if (x < L + BALL_R || x > R - BALL_R || y < T + BALL_R || y > B - BALL_R) continue;
      if (inPocketMouth(x, y)) continue;
      if (!ballOverlaps(balls, x, y, cueBall)) {
        cueBall.reset(x, y);
        return cueBall;
      }
    }
    return placeCueBallInDZ(balls, cueBall);
  }

  // 白球回到 D 区（左侧半圆内螺旋找空位）
  function placeCueBallInDZ(balls, cueBall) {
    cueBall.reset(C.CUE_START.x, C.CUE_START.y);
    let tries = 0;
    while (ballOverlaps(balls, cueBall.x, cueBall.y, cueBall) && tries < 200) {
      const step = tries * 5;
      const angle = tries * 1.2;
      cueBall.x = C.BAULK_X - Math.abs(Math.cos(angle)) * Math.min(C.DR - BALL_R * 2, step);
      cueBall.y = C.CY2 + Math.sin(angle) * Math.min(C.DR - BALL_R * 2, step);
      if (cueBall.x > C.BAULK_X - BALL_R) cueBall.x = C.BAULK_X - BALL_R;
      tries++;
    }
    return cueBall;
  }

  // 把重叠的球推开（开局用）
  function separateBalls(balls) {
    for (let iter = 0; iter < 80; iter++) {
      let moved = false;
      for (let i = 0; i < balls.length; i++) {
        for (let j = i + 1; j < balls.length; j++) {
          const a = balls[i], b = balls[j];
          if (!a.isOnTable() || !b.isOnTable()) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.hypot(dx, dy);
          if (dist < a.r + b.r && dist > 0.01) {
            const overlap = (a.r + b.r - dist) / 2;
            const nx = dx / dist, ny = dy / dist;
            a.x -= nx * overlap; a.y -= ny * overlap;
            b.x += nx * overlap; b.y += ny * overlap;
            a.x = C.clamp(a.x, L + a.r, R - a.r);
            a.y = C.clamp(a.y, T + a.r, B - a.r);
            b.x = C.clamp(b.x, L + b.r, R - b.r);
            b.y = C.clamp(b.y, T + b.r, B - b.r);
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  }

  // ================================================================
  //  几何工具（AI 也要用）
  // ================================================================
  // 线段 (x1,y1)-(x2,y2) 是否被 balls 中任意球挡住（排除列表外的球）
  // margin：额外要求的安全间隙（px）。
  //   0 = 纯几何（两球刚好相切算通）。
  //   AI 瞄球时会给一个正余量：**擦着别的球过去**的线路在几何上"通"，
  //   但一丁点出杆误差就会换成先碰到那颗球 → 犯规/打丢。
  //   实测：这类贴容差斯的线路是"亚像素扰动丢 29% 进球"的主因之一。
  function pathBlocked(balls, x1, y1, x2, y2, ignore, ignore2, margin) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) return false;
    const need = (margin || 0) - 0.5;
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (!b.isOnTable()) continue;
      if (b === ignore || b === ignore2) continue;
      const t = ((b.x - x1) * dx + (b.y - y1) * dy) / len2;
      if (t <= 0 || t >= 1) continue;
      const cx = x1 + t * dx, cy = y1 + t * dy;
      // 球心到线段距离 < 2R + 间隙 即视为挡路（球半径 + 球半径）
      if (Math.hypot(b.x - cx, b.y - cy) < b.r * 2 + need) return true;
    }
    return false;
  }

  C.Ball = Ball;
  C.cloneBalls = cloneBalls;
  C.effectiveTip = effectiveTip;
  C.strike = strike;
  C.stepWorld = stepWorld;
  C.resolveCollision = resolveCollision;
  C.captureCheck = captureCheck;
  C.inGap = inGap;
  C.inPocketMouth = inPocketMouth;
  C.GAPS = GAPS;
  C.ballOverlaps = ballOverlaps;
  C.respotColor = respotColor;
  C.tryPlace = tryPlace;
  C.placeCueBallInDZ = placeCueBallInDZ;
  C.placeCueBallInHand = placeCueBallInHand;
  C.separateBalls = separateBalls;
  C.pathBlocked = pathBlocked;
})(window.SNK = window.SNK || {});
