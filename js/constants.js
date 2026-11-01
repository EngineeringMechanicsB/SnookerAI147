// ================================================================
//  constants.js — 台面几何 / 物理常量 / 颜色与点位
//  所有模块挂在 window.SNK 命名空间下，避免污染全局
// ================================================================
(function (SNK) {
  'use strict';

  // ---------- 台面几何 ----------
  // 斯诺克：可打区 3569×1778 mm，球径 52.5 mm，角袋 86 / 中袋 102 mm
  // 美式 8/9 球：9ft 台 2540×1270 mm，球径 57.15 mm，角袋 114 / 中袋 127 mm
  // 画布固定 1416×736；池球台居中缩小，球本身按同一 px/mm 比例放大。
  let TABLE_MODE = 'snooker';
  let REQUESTED_MODE = 'classic';
  try {
    const m = /[?&]mode=([a-zA-Z]+)/.exec(location.search);
    if (m) REQUESTED_MODE = m[1];
    if (REQUESTED_MODE === 'eightball' || REQUESTED_MODE === 'nineball') TABLE_MODE = REQUESTED_MODE;
  } catch (e) { /* 非浏览器环境默认斯诺克 */ }
  const IS_POOL_TABLE = TABLE_MODE === 'eightball' || TABLE_MODE === 'nineball';

  const W = 1416, H = 736;       // 固定画布
  const CUSHION = IS_POOL_TABLE ? 26 : 28;
  const SCALE = 1360 / 3569;     // px/mm，两种台共用
  const BALL_R = IS_POOL_TABLE ? 57.15 * SCALE / 2 : 10;
  const BALL_D = BALL_R * 2;
  // 斯诺克 3569×1778；8-ball 用 8ft（2337×1168），9-ball 用 9ft（2540×1270）。
  const POOL_W_MM = TABLE_MODE === 'eightball' ? 2337 : 2540;
  const POOL_H_MM = TABLE_MODE === 'eightball' ? 1168 : 1270;
  const TABLE_W = IS_POOL_TABLE ? POOL_W_MM * SCALE : 3569 * SCALE;
  const TABLE_H = IS_POOL_TABLE ? POOL_H_MM * SCALE : 1778 * SCALE;

  const POCKET_R = IS_POOL_TABLE ? 24 : 22;

  // 桌角圆角半径（画布像素）。2D 和 3D 共用。
  const CORNER_R = IS_POOL_TABLE ? 28 : 32;

  // 可打区在画布中居中；W/H 仍是完整画布。
  const L = (W - TABLE_W) / 2;
  const R = L + TABLE_W;
  const T = (H - TABLE_H) / 2;
  const B = T + TABLE_H;

  const CX_TABLE = L + TABLE_W / 2;

  // ---------- 物理常量 ----------
  // 摩擦：真实布料对球是**恒定减速度**（不是每帧按比例衰减）。
  // 所以滑行距离 ∝ 初速度²——轻杆真的走不远，重杆真的走很远。
  // 取值换算：a ≈ 0.6 m/s²（斯诺克台布实测量级）
  //   1px = 1/0.38106 ≈ 2.624mm，60fps
  //   a[px/帧²] = 0.6 × 6.35 ÷ 60 ≈ 0.0635
  const ROLL_DECEL = 0.0635;
  const BOUNCE = 0.82;             // 库边恢复系数
  const BALL_RESTITUTION = 0.94;   // 球球碰撞恢复系数（真实象牙/树脂球 ≈0.94：
                                   //   正碰时白球几乎停住、目标球带走绝大部分动能。
                                   //   原版 0.82 会让白球碰完还留着 18% 速度往前溜）
  const MIN_SPEED = 0.06;          // 低于此速度判定为静止
  // 满力 ≈ 36px/帧 ≈ 5.6 m/s；新行程模型（先滑动后滚动）下 ≈ 6740px，
  // 约 4.9 个台长——重杆能把白球打出去再绕回来，与真实量级一致。
  const MAX_POWER = 36;
  // 有效最小力度：低于它的出杆连轻微碰球都做不到，直接拒绝。
  const MIN_POWER = 1.5;
  const SPACING = BALL_D + 0.5;

  // 模拟上限：满力滑动 ≈41 帧 + 滚动 ≈337 帧 ≈378 帧停下，留出多次撞库余量。
  const MAX_SIM_FRAMES = 1200;

  // ---------- 加塞（spin）常量 ----------
  // 击点偏移以球半径为单位，|s| 上限——超过容易跳球，实际也打不准
  const SPIN_MAX = 0.75;

  // ---------- 球杆俯仰（第八轮）----------
  // 0° = 平杆；抬到 60° 时速度 ×cos(60°)=0.5，并额外带一点高杆（跟球）。
  // 只做“抬高杆尾 → 打到球心上方”的简化，不做跳球/扎杆弹起。
  const PITCH_MAX_DEG = 60;
  const PITCH_FOLLOW_K = 0.45;   // 60° 时额外 sy ≈ +0.39（会被 SPIN_MAX 夹住）

  const SQUIRT_K = 0.035;      // 偏杆出杆偏转：每 1.0R 侧偏约 2°（0.25R ≈ 0.5°）
  // 侧旋弧线强度（低速时明显）。实测满塞慢杆弯 ≈27px（1.4 个球径）
  // 注意：摩擦改成恒定减速度后，球的慢速段变短，这个系数要跟着放大
  const SWERVE_K = 0.045;
  const SIDE_CUSHION_K = 0.24; // 侧旋撞库后的切向增量系数
  const FOLLOW_K = 0.90;       // 高杆/低杆：撞球后沿原方向附加速度系数
  const SPIN_DECAY = 0.995;    // 侧旋（绕竖轴）每帧指数衰减
  const CUSHION_SPIN_LOSS = 0.6; // 旧模型残留，已由库边摩擦取代
  const CONTACT_SPIN_LOSS = 0.25; // 旧模型残留，已由球球切向摩擦取代
  const SPIN_POWER_LOSS = 0.25;  // 击点偏离中心的最大力量损失比例（0.75R 时损失 25%）

  // ---------- 真实球体旋转（第十一轮）----------
  // 球在台呢上不是"一直滚动"：击球后先**滑动**，摩擦把平动和转动拉到
  // 纯滚动关系（v = ωR），之后才是滚动阻力。下面这些量把 SI 换算到
  // "px / 60Hz 帧"：g = 9.80665 m/s² → 1.0384 px/帧²。
  const G_PX = 9.80665 * 1000 * SCALE / 3600;
  const MU_SLIDE = 0.20;       // 球-台呢滑动摩擦系数（Dr. Dave / pooltool 常用值）
  const MU_BALL = 0.06;        // 球-球切向摩擦（throw）
  const MU_CUSHION = 0.30;     // 库边切向摩擦（斯诺克库布比台呢涩）
  const CUSHION_H = BALL_R * 0.27; // 库边鼻线高于球心约 0.27R
  const SLIP_EPS = 0.02;       // 接触点滑移小于此值视为纯滚动
  const STOP_SPIN = 0.02;      // 停球时允许残留的角速度
  // 中心击球（无塞）的总行程系数：滑动段 + 滚动段
  //   d = [12/(49 μs g) + 25/(98 μr g)] · v²
  const TRAVEL_K = 12 / (49 * MU_SLIDE * G_PX) + 25 / (98 * ROLL_DECEL);
  // AI 的力度估算与预览都走这一个反函数，避免"物理改了 AI 还按旧公式"。
  function speedForDistance(dist, vEnd) {
    const d = Math.max(0, dist || 0);
    const ve = Math.max(0, vEnd || 0);
    return Math.sqrt(d / TRAVEL_K + ve * ve);
  }
  function distanceForSpeed(v) {
    return TRAVEL_K * v * v;
  }

  // ---------- 袋口 ----------
  // 真实开口：角袋 86mm、中袋 102mm（沿库边量）
  //   → 半宽 43mm / 51mm → 16.4px / 19.4px
  // 换成球径单位：1.64 个球 / 1.95 个球。
  // 老版本一律 51px 全宽（2.55 球），角袋大了 55%——所以"什么球都进"。
  // 捕获圈比"半袋宽"再放宽 2px：台呢上真正挖出来的洞半径是 17/20px
  // （pockets[].r），球心一旦进到洞口边缘就应当落袋。旧值 16.4/19.4
  // 比画出来的洞还小，慢球经常停在洞口边缘，手感像"必须大力才能进"。
  // 只放宽 2px，不会回到老版本 51px"什么都进"的吸球感。
  const MOUTH_CORNER = (IS_POOL_TABLE ? 114 : 86) * SCALE / 2 + (IS_POOL_TABLE ? 1.5 : 4);
  const MOUTH_MIDDLE = (IS_POOL_TABLE ? 127 : 102) * SCALE / 2 + (IS_POOL_TABLE ? 1.5 : 4);

  // 落袋规则：**球心进入袋口的捕获圈即落袋**。
  // 角袋捕获圆心 = 台面角点，半径 = 半袋宽。
  // 这个圈全部压在台面外沿，只有贴库的球才够得着，
  // 所以既不会吸走台中的球，也能让贴库滚进角的球正常落袋。
  const CORNER_HOLE_R = IS_POOL_TABLE ? 22 : 17;
  const MIDDLE_HOLE_R = IS_POOL_TABLE ? 25 : 20;
  const pockets = [
    { x: L,        y: T, kind: 'corner', mouth: MOUTH_CORNER, r: CORNER_HOLE_R },  // 左上角袋
    { x: L,        y: B, kind: 'corner', mouth: MOUTH_CORNER, r: CORNER_HOLE_R },  // 左下角袋
    { x: CX_TABLE, y: T, kind: 'middle', mouth: MOUTH_MIDDLE, r: MIDDLE_HOLE_R },  // 上侧中袋
    { x: CX_TABLE, y: B, kind: 'middle', mouth: MOUTH_MIDDLE, r: MIDDLE_HOLE_R },  // 下侧中袋
    { x: R,        y: T, kind: 'corner', mouth: MOUTH_CORNER, r: CORNER_HOLE_R },  // 右上角袋
    { x: R,        y: B, kind: 'corner', mouth: MOUTH_CORNER, r: CORNER_HOLE_R },  // 右下角袋
  ];

  // ---------- 颜色 ----------
  const COL = {
    red:    '#ff4757',
    yellow: '#ffd93d',
    green:  '#2ed573',
    brown:  '#c0854a',
    blue:   '#4dabf7',
    pink:   '#ff6b9d',
    black:  '#222',
    white:  '#f5f5f5',
    // 8-ball 球色：s1~s7 全色，t1~t7 花色，eight 黑八
    s1: '#f2c200', s2: '#1f5fbf', s3: '#d6382f', s4: '#7b3f9e',
    s5: '#e07a1f', s6: '#1f8a4c', s7: '#7a1f1f',
    t1: '#f2c200', t2: '#1f5fbf', t3: '#d6382f', t4: '#7b3f9e',
    t5: '#e07a1f', t6: '#1f8a4c', t7: '#7a1f1f',
    eight: '#161616',
    b1: '#f2c200', b2: '#1f5fbf', b3: '#d6382f', b4: '#7b3f9e',
    b5: '#e07a1f', b6: '#1f8a4c', b7: '#7a1f1f', b8: '#161616',
    b9: '#f2c200',
  };
  const COL_VAL = {
    red: 1, yellow: 2, green: 3, brown: 4, blue: 5, pink: 6, black: 7,
    s1: 1, s2: 1, s3: 1, s4: 1, s5: 1, s6: 1, s7: 1,
    t1: 1, t2: 1, t3: 1, t4: 1, t5: 1, t6: 1, t7: 1, eight: 8,
    b1: 1, b2: 1, b3: 1, b4: 1, b5: 1, b6: 1, b7: 1, b8: 1, b9: 9,
  };
  const COL_ORDER = ['yellow', 'green', 'brown', 'blue', 'pink', 'black'];
  const COL_CN = {
    red: 'red', yellow: 'yellow', green: 'green', brown: 'brown',
    blue: 'blue', pink: 'pink', black: 'black', white: 'white',
    s1: '1', s2: '2', s3: '3', s4: '4', s5: '5', s6: '6', s7: '7',
    t1: '9', t2: '10', t3: '11', t4: '12', t5: '13', t6: '14', t7: '15',
    eight: '8',
    b1: '1', b2: '2', b3: '3', b4: '4', b5: '5', b6: '6', b7: '7', b8: '8', b9: '9',
  };
  const POOL_SOLIDS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];
  const POOL_STRIPES = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
  const POOL_NINE = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9'];
  const isStriped = (l) => (l && l.charAt(0) === 't') || l === 'b9';
  const isPoolLabel = (l) => l === 'eight' || POOL_SOLIDS.indexOf(l) >= 0 ||
    POOL_STRIPES.indexOf(l) >= 0 || POOL_NINE.indexOf(l) >= 0;

  // ---------- 点位（横向：开球区在左，黑球端在右）----------
  // 真实尺寸：开球线距底库 737mm、D 区半径 292mm、
  //          黑球点距顶库 324mm、粉球点在中心点与顶库正中间
  const CX2 = CX_TABLE;          // 708
  const CY2 = T + TABLE_H / 2;   // 368

  const BAULK_X = IS_POOL_TABLE ? L + TABLE_W * 0.20 : L + Math.round(737 * SCALE);
  const DR = IS_POOL_TABLE ? TABLE_H * 0.18 : Math.round(292 * SCALE);
  const BLACK_X = IS_POOL_TABLE ? R - TABLE_W * 0.08 : R - Math.round(324 * SCALE);
  // 斯诺克粉球点同时用作红球堆顶点；池球也用这个位置作为球堆顶点。
  const PINK_X = IS_POOL_TABLE ? L + TABLE_W * 0.72 : L + Math.round(2676.75 * SCALE);

  // 白球开球位置：D 区里偏左后侧。
  // 不能放在 D 区正中（= BAULK_X - DR/2, CY2）——那里正对棕球，
  // 距离只有 55px，棕球会挡住通往红球堆的整个扇面（±21°），
  // 开球第一杆在几何上就是犯规。真实球手也从 D 区侧后方开球。
  const CUE_START = IS_POOL_TABLE
    ? { x: L + TABLE_W * 0.18, y: CY2 }
    : { x: BAULK_X - Math.round(DR * 0.52), y: CY2 + Math.round(DR * 0.5) };

  function getColorPos(label) {
    const map = {
      yellow: { x: BAULK_X, y: CY2 + DR },
      green:  { x: BAULK_X, y: CY2 - DR },
      brown:  { x: BAULK_X, y: CY2 },
      blue:   { x: CX2,     y: CY2 },
      pink:   { x: PINK_X,  y: CY2 },
      black:  { x: BLACK_X, y: CY2 },
    };
    return map[label] || null;
  }

  // ---------- 小工具 ----------
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // 角度归一化到 (-π, π]
  function normAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a <= -Math.PI) a += 2 * Math.PI;
    return a;
  }

  SNK.BALL_R = BALL_R;
  SNK.BALL_D = BALL_D;
  SNK.CUSHION = CUSHION;
  SNK.TABLE_MODE = TABLE_MODE;
  SNK.REQUESTED_MODE = REQUESTED_MODE;
  SNK.IS_POOL_TABLE = IS_POOL_TABLE;
  SNK.TABLE_W = TABLE_W;
  SNK.TABLE_H = TABLE_H;
  SNK.POCKET_R = POCKET_R;
  SNK.CORNER_R = CORNER_R;
  SNK.W = W;
  SNK.H = H;
  SNK.L = L; SNK.R = R; SNK.T = T; SNK.B = B;

  SNK.ROLL_DECEL = ROLL_DECEL;
  SNK.BOUNCE = BOUNCE;
  SNK.BALL_RESTITUTION = BALL_RESTITUTION;
  SNK.MIN_SPEED = MIN_SPEED;
  SNK.MAX_POWER = MAX_POWER;
  SNK.MIN_POWER = MIN_POWER;
  SNK.SPACING = SPACING;
  SNK.MAX_SIM_FRAMES = MAX_SIM_FRAMES;

  SNK.SPIN_MAX = SPIN_MAX;
  SNK.PITCH_MAX_DEG = PITCH_MAX_DEG;
  SNK.PITCH_FOLLOW_K = PITCH_FOLLOW_K;
  SNK.SQUIRT_K = SQUIRT_K;
  SNK.SWERVE_K = SWERVE_K;
  SNK.SIDE_CUSHION_K = SIDE_CUSHION_K;
  SNK.FOLLOW_K = FOLLOW_K;
  SNK.SPIN_DECAY = SPIN_DECAY;
  SNK.CUSHION_SPIN_LOSS = CUSHION_SPIN_LOSS;
  SNK.CONTACT_SPIN_LOSS = CONTACT_SPIN_LOSS;
  SNK.SPIN_POWER_LOSS = SPIN_POWER_LOSS;

  SNK.G_PX = G_PX;
  SNK.MU_SLIDE = MU_SLIDE;
  SNK.MU_BALL = MU_BALL;
  SNK.MU_CUSHION = MU_CUSHION;
  SNK.CUSHION_H = CUSHION_H;
  SNK.SLIP_EPS = SLIP_EPS;
  SNK.STOP_SPIN = STOP_SPIN;
  SNK.TRAVEL_K = TRAVEL_K;
  SNK.speedForDistance = speedForDistance;
  SNK.distanceForSpeed = distanceForSpeed;

  SNK.CX_TABLE = CX_TABLE;
  SNK.pockets = pockets;
  SNK.MOUTH_CORNER = MOUTH_CORNER;
  SNK.MOUTH_MIDDLE = MOUTH_MIDDLE;

  SNK.COL = COL;
  SNK.COL_VAL = COL_VAL;
  SNK.COL_ORDER = COL_ORDER;
  SNK.COL_CN = COL_CN;
  SNK.POOL_SOLIDS = POOL_SOLIDS;
  SNK.POOL_STRIPES = POOL_STRIPES;
  SNK.POOL_NINE = POOL_NINE;
  SNK.isPoolLabel = isPoolLabel;
  SNK.isStriped = isStriped;

  SNK.CX2 = CX2;
  SNK.CY2 = CY2;
  SNK.SCALE = SCALE;
  SNK.BAULK_X = BAULK_X;
  SNK.DR = DR;
  SNK.BLACK_X = BLACK_X;
  SNK.PINK_X = PINK_X;
  SNK.getColorPos = getColorPos;
  SNK.CUE_START = CUE_START;

  SNK.clamp = clamp;
  SNK.normAngle = normAngle;
})(window.SNK = window.SNK || {});
