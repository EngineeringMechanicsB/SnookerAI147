// ================================================================
//  render.js — 绘制
//  台面 / 球 / 瞄准预览（真实模拟轨迹，含加塞弧线）/ 上一杆回放 / 加塞控制盘
// ================================================================
(function (SNK) {
  'use strict';

  const C = SNK;
  const L = C.L, R = C.R, T = C.T, B = C.B;
  const W = C.W, H = C.H;

  function lighten(hex, amt) {
    const c = hex.replace('#', '');
    const r = Math.min(255, parseInt(c.substr(0, 2), 16) + amt);
    const g = Math.min(255, parseInt(c.substr(2, 2), 16) + amt);
    const b = Math.min(255, parseInt(c.substr(4, 2), 16) + amt);
    return `rgb(${r},${g},${b})`;
  }
  function darken(hex, amt) {
    const c = hex.replace('#', '');
    const r = Math.max(0, parseInt(c.substr(0, 2), 16) - amt);
    const g = Math.max(0, parseInt(c.substr(2, 2), 16) - amt);
    const b = Math.max(0, parseInt(c.substr(4, 2), 16) - amt);
    return `rgb(${r},${g},${b})`;
  }

  // ================================================================
  //  台面
  // ================================================================
  // 桌角圆角半径（画布像素）。**和 render3d.js 共用 C.CORNER_R 这一个数**：
  // 两个画布的缓冲都是 1416×736、显示尺寸也一样，所以同一个数在屏幕上就是同一个圆角 ——
  // 以前 2D 的圆角其实只是画布自己的 CSS border-radius 顺手裁出来的（10px），
  // 3D 里台子是房间中的一个直角盒子，于是"2D 有圆角、3D 没有"。
  // 现在两边都在**几何/绘制**上倒角，CSS 那层只负责窗口本身。
  const CORNER_R = C.CORNER_R;

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawTable(ctx) {
    // 台面裁进一个圆角矩形里。池球的台面比画布小，居中留出房间边距。
    const outL = L - C.CUSHION, outT = T - C.CUSHION;
    const outW = C.TABLE_W + C.CUSHION * 2, outH = C.TABLE_H + C.CUSHION * 2;
    ctx.save();
    roundRectPath(ctx, outL, outT, outW, outH, CORNER_R);
    ctx.clip();

    // 外框木纹
    const fg = ctx.createLinearGradient(0, 0, W, H);
    fg.addColorStop(0, '#4a2e18'); fg.addColorStop(0.5, '#6b4428');
    fg.addColorStop(1, '#3d2412');
    ctx.fillStyle = fg;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.globalAlpha = 0.05;
    for (let i = 0; i < 50; i++) {
      const yy = i * 10 + 3;
      ctx.strokeStyle = '#000'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(0, yy + Math.sin(i * 0.7) * 2);
      for (let x = 0; x < W; x += 15) {
        ctx.lineTo(x, yy + Math.sin((x + i * 60) * 0.007) * 1.5 + Math.sin(i * 1.2) * 1);
      }
      ctx.stroke();
    }
    ctx.restore();

    // 台呢
    ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 4;
    // 台呢色：**末端必须等于 3D 台呢的 0x08401f**。
    // 3D 那边的总光量约 1.0（相对白纸，见 README §7），所以它的 albedo 基本就是观感色；
    // 2D 没有光照、直接落色，因此两边末段取同一个值，切 2D/3D 才不会"整块台呢跳一下"。
    // 保留径向渐变是刻意的：3D 那块亮斑是真实灯光打的，2D 得自己画出来。
    const fg2 = ctx.createRadialGradient(L + C.TABLE_W * 0.3, T + C.TABLE_H * 0.35, 30,
      L + C.TABLE_W * 0.5, T + C.TABLE_H * 0.5, C.TABLE_W * 0.65);
    fg2.addColorStop(0, '#1b5e35'); fg2.addColorStop(0.3, '#14502c');
    fg2.addColorStop(0.6, '#0e4726'); fg2.addColorStop(1, '#08401f');
    ctx.fillStyle = fg2;
    ctx.fillRect(L, T, C.TABLE_W, C.TABLE_H);
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

    // 台呢纹理
    ctx.save(); ctx.globalAlpha = 0.025;
    for (let y = T; y < B; y += 2.5) {
      ctx.strokeStyle = '#000'; ctx.lineWidth = 0.4;
      ctx.beginPath(); ctx.moveTo(L, y);
      for (let x = L; x < R; x += 6) ctx.lineTo(x, y + Math.sin((x + y * 9) * 0.018) * 0.6);
      ctx.stroke();
    }
    ctx.restore();

    // 库边（先画，袋口再把缺口盖出来）
    ctx.strokeStyle = '#0a4823'; ctx.lineWidth = 5;
    ctx.strokeRect(L, T, C.TABLE_W, C.TABLE_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
    ctx.strokeRect(L + 6, T + 6, C.TABLE_W - 12, C.TABLE_H - 12);

    // 斯诺克专用标记：池球台不画开球线/D 区/彩球点
    if (C.TABLE_MODE === 'snooker') {
      // 开球线
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(C.BAULK_X, T + 6); ctx.lineTo(C.BAULK_X, B - 6); ctx.stroke();
      ctx.setLineDash([]);
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.font = '8px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText('BAULK', C.BAULK_X, T + 8);
      ctx.textBaseline = 'bottom';
      ctx.fillText('BAULK', C.BAULK_X, B - 8);
      ctx.restore();

      // D 区（朝左开口的半圆）
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(C.BAULK_X, C.CY2, C.DR, 3 * Math.PI / 2, Math.PI / 2, true);
      ctx.stroke();

      // 点位
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      const spots = [[C.BAULK_X, C.CY2], [C.CX2, C.CY2], [C.PINK_X, C.CY2], [C.BLACK_X, C.CY2]];
      for (const sp of spots) {
        ctx.beginPath(); ctx.arc(sp[0], sp[1], 3.5, 0, Math.PI * 2); ctx.fill();
      }
    }

    // 袋口：画在台面外沿，半径用真实袋口尺寸（角袋 86mm / 中袋 102mm）
    for (const p of C.pockets) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 8;
      ctx.fillStyle = '#111';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 3, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      const pg = ctx.createRadialGradient(p.x - 2, p.y - 2, 1, p.x, p.y, p.r);
      pg.addColorStop(0, '#222'); pg.addColorStop(1, '#080808');
      ctx.fillStyle = pg;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    ctx.restore();   // 撤销 drawTable 开头那个圆角裁剪
  }

  // ================================================================
  //  球
  // ================================================================
  function drawBall(ctx, ball) {
    if (!ball.isOnTable()) return;
    const x = ball.x, y = ball.y, r = ball.r, color = ball.color, label = ball.label;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 7;
    ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 3;

    const pool = C.isPoolLabel && C.isPoolLabel(label);
    const stripe = C.isStriped ? C.isStriped(label) : (label && label.charAt(0) === 't');
    if (stripe) {
      // 花色球：白底 + 中间彩色带
      const sg = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
      sg.addColorStop(0, '#fff'); sg.addColorStop(0.7, '#f2f2f2'); sg.addColorStop(1, '#c8c8c8');
      ctx.shadowBlur = 0; ctx.fillStyle = sg;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = color;
      ctx.fillRect(x - r, y - r * 0.52, r * 2, r * 1.04);
      ctx.restore();
    } else {
      const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
      if (label === 'white') {
        g.addColorStop(0, '#fff'); g.addColorStop(0.5, '#f0f0f0'); g.addColorStop(1, '#ccc');
      } else if (label === 'black' || label === 'eight') {
        g.addColorStop(0, '#555'); g.addColorStop(0.5, '#333'); g.addColorStop(1, '#111');
      } else {
        g.addColorStop(0, lighten(color, 50)); g.addColorStop(0.5, color); g.addColorStop(1, darken(color, 25));
      }
      ctx.shadowBlur = 0; ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }

    if (pool) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath(); ctx.arc(x, y, r * 0.46, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#111';
      ctx.font = 'bold ' + Math.max(6, Math.round(r * 0.78)) + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(C.COL_CN[label] || ''), x, y + 0.5);
    }

    const hg = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, 0, x - r * 0.3, y - r * 0.35, r * 0.55);
    hg.addColorStop(0, 'rgba(255,255,255,0.45)'); hg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.arc(x - r * 0.35, y - r * 0.38, r * 0.18, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // 白球上的击点标记（加塞）
  //
  // 标记画的是**球杆真正碰到的那一点**，不是"球顶上的一个偏移点"。
  // 把击点看成球面上的单位向量：
  //   朝向球杆：-d          （d = 出杆方向，球杆在球的 -d 侧）
  //   横向偏移：sx * (ẑ×d)
  //   高度偏移：sy * 上
  // 俯视图只能看到水平投影，所以 sy 不直接出现在屏幕坐标里，只通过
  // √(1−sx²−sy²) 把接触点从球边往球心收。
  function drawSpinMark(ctx, ball, spinX, spinY, aimAngle, pitchDeg) {
    if (!ball.isOnTable()) return;
    if (!spinX && !spinY) return;
    const a = aimAngle || 0;
    const dx = Math.cos(a), dy = Math.sin(a);
    const sideX = -dy, sideY = dx;               // ẑ×d（与出杆方向垂直）
    // 和 physics.strike 用同一个 effectiveTip：俯仰会把击点抬高，
    // 红点要跟着移到球杆真正碰到的那一点，而不是停在原来的高度。
    const tip = C.effectiveTip
      ? C.effectiveTip(spinX, spinY, (pitchDeg || 0) * Math.PI / 180)
      : { sx: spinX, sy: spinY };
    const sx = tip.sx / C.SPIN_MAX;
    const sy = tip.sy / C.SPIN_MAX;
    const hs = Math.sqrt(Math.max(0, 1 - sx * sx - sy * sy));
    const px = ball.x + (-dx * hs + sideX * sx) * ball.r;
    const py = ball.y + (-dy * hs + sideY * sx) * ball.r;
    ctx.save();
    ctx.fillStyle = 'rgba(255,72,72,0.95)';
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(px, py, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // ================================================================
  //  目标高亮
  // ================================================================
  function pulse() { return Math.sin(Date.now() * 0.005) * 0.3 + 0.7; }

  function drawTargets(ctx, balls, on) {
    if (!on) return;
    const p = pulse();
    ctx.save();
    ctx.setLineDash([3, 6]);
    ctx.lineWidth = 1.8;
    for (const b of balls) {
      if (!b.isOnTable()) continue;
      if (on.targets.indexOf(b.label) < 0) continue;
      ctx.strokeStyle = `rgba(255,255,255,${p * 0.28})`;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 5, 0, Math.PI * 2); ctx.stroke();
    }
    // 清彩/抢黑：当前目标标个字
    if (on.phase === 'clearance' || on.phase === 'respottedBlack') {
      for (const b of balls) {
        if (!b.isOnTable() || on.targets.indexOf(b.label) < 0) continue;
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('ON', b.x, b.y - b.r - 9);
        break;
      }
    }
    ctx.restore();
  }

  // ================================================================
  //  瞄准预览（真实模拟轨迹）
  // ================================================================
  // 画一条路径，顺手去掉相邻重复点（sim 每 4 帧采样一次，静止球会重复很多）
  function strokePath(ctx, pts, minMove) {
    if (!pts || pts.length < 2) return;
    const m2 = (minMove || 0) * (minMove || 0);
    // 轨迹点由物理事件补齐，拐角就是真实接触点；圆角接头只是让折线
    // 在视觉上不出现尖刺，不再改变几何。
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    let px = pts[0].x, py = pts[0].y, drew = false;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - px, dy = pts[i].y - py;
      if (dx * dx + dy * dy < m2) continue;
      ctx.lineTo(pts[i].x, pts[i].y);
      px = pts[i].x; py = pts[i].y; drew = true;
    }
    if (drew) ctx.stroke();
  }

  // 库边接触点：在**库边面**上画一个小点，把"球心轨迹离库一个半径"
  // 这段空隙明确连起来。只对真正反弹的拐角画，贴库直线滚动不画。
  function drawRailTicks(ctx, pts) {
    if (!pts || pts.length < 3) return;
    const near = (v, target) => Math.abs(v - target) < 0.8;
    const offL = L + C.BALL_R, offR = R - C.BALL_R;
    const offT = T + C.BALL_R, offB = B - C.BALL_R;
    ctx.save();
    ctx.fillStyle = 'rgba(255,238,102,0.55)';
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], a = pts[i - 1], b = pts[i + 1];
      let wx = 0, wy = 0, hit = false;
      if (near(p.x, offL)) { wx = L; wy = p.y; hit = true; }
      else if (near(p.x, offR)) { wx = R; wy = p.y; hit = true; }
      else if (near(p.y, offT)) { wx = p.x; wy = T; hit = true; }
      else if (near(p.y, offB)) { wx = p.x; wy = B; hit = true; }
      if (!hit) continue;
      // 叉积 ≈ 0 表示只是沿库边直走，不是反弹
      const cr = (p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x);
      if (Math.abs(cr) < 0.5) continue;
      ctx.beginPath();
      ctx.arc(wx, wy, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // 辅助线末端的白点：这一杆模拟下来该球进洞时，在它轨迹的最后一点画个白点。
  // 点比线略宽一点即可（lineWidth 的 0.75 倍当半径 → 直径是线宽的 1.5 倍 + 2px）。
  // 用 `finalBalls[i].potted` 判断，与 sim.js 的落袋结果同源，不另算几何。
  function drawPotDot(ctx, preview, i, lineWidth) {
    if (!preview || !preview.paths || !preview.finalBalls) return;
    const fb = preview.finalBalls[i];
    const pts = preview.paths[i];
    if (!fb || !fb.potted || !pts || pts.length < 2) return;
    const p = pts[pts.length - 1];
    ctx.save();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, lineWidth * 0.75 + 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // mode: 0 全无（调用方已拦）/ 1 只有母球 / 2 母球 + 第一颗被撞球 / 3 所有动的球
  function drawPreview(ctx, cueBall, preview, angle, mode) {
    if (!cueBall.isOnTable()) return;
    mode = (mode === undefined || mode === null) ? 2 : mode;
    if (mode === 0) return;

    ctx.save();
    if (preview && preview.cuePath && preview.cuePath.length > 1) {
      // 白球实际会走的路线（含加塞弧线）
      ctx.strokeStyle = 'rgba(255,238,102,0.85)';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#ffee66'; ctx.shadowBlur = 8;
      strokePath(ctx, preview.cuePath, 0);
      ctx.shadowBlur = 0;
      drawRailTicks(ctx, preview.cuePath);
      drawPotDot(ctx, preview, preview.cueIdx, 2);

      const fc = preview.firstContact;

      if (mode >= 2) {
        // 幽灵球 + 被撞球的出球线
        if (fc && preview.paths && preview.paths[fc.__i]) {
          const tp = preview.paths[fc.__i];
          ctx.strokeStyle = 'rgba(249,168,37,0.8)'; ctx.lineWidth = 2;
          strokePath(ctx, tp, 0);
          drawPotDot(ctx, preview, fc.__i, 2);
          // 接触瞬间的白球位置 = 幽灵球
          const last = preview.cuePath[preview.cuePath.length - 1];
          ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.arc(last.x, last.y, C.BALL_R, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      if (mode >= 3 && preview.paths) {
        // 其余所有会动的球：暗绿细线，与母球/首触对象区分开
        ctx.strokeStyle = 'rgba(150,255,190,0.45)';
        ctx.lineWidth = 1.4;
        const skip = (fc && fc.__i >= 0) ? fc.__i : -1;
        for (let i = 0; i < preview.paths.length; i++) {
          if (i === preview.cueIdx || i === skip) continue;
          strokePath(ctx, preview.paths[i], 0.75);
          drawPotDot(ctx, preview, i, 1.4);
        }
      }
    } else {
      // 没有模拟结果时给条虚线，别让玩家完全没参考
      const a = (angle === undefined || angle === null) ? 0 : angle;
      ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
      ctx.setLineDash([5, 8]);
      ctx.beginPath();
      ctx.moveTo(cueBall.x, cueBall.y);
      ctx.lineTo(cueBall.x + Math.cos(a) * 220, cueBall.y + Math.sin(a) * 220);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  // 球杆（第八轮：加出杆后拉/前送 + 俯仰）
  function drawCue(ctx, cueBall, angle, power, state, pitchDeg, strokePull) {
    if (!cueBall.isOnTable()) return;
    const pitch = (pitchDeg || 0) * Math.PI / 180;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let pull = (state === 'powering' || state === 'dragging')
      ? 4 + Math.min(26, power * 1.5) : 6;
    if (state === 'stroking') pull = 4 + Math.min(26, power * 1.5) + (strokePull || 0) * 30;
    const start = C.BALL_R + pull;
    // 俯视下“抬高杆尾”没有真正的透视，用长度 ×cos 近似前缩，
    // 再沿瞄准线补一条偏移的暗影子，读起来就是“杆尾离开台面”。
    const cueLen = 340 * Math.cos(pitch);
    const sx = cueBall.x - dx * start, sy = cueBall.y - dy * start;
    const ex = cueBall.x - dx * (start + cueLen), ey = cueBall.y - dy * (start + cueLen);

    ctx.save();
    if (pitch > 0.01) {
      // 抬杆后杆身的“影子”：沿瞄准方向平移，越抬越远、越淡
      const off = Math.sin(pitch) * 10;
      ctx.strokeStyle = 'rgba(0,0,0,' + (0.18 + Math.sin(pitch) * 0.18).toFixed(3) + ')';
      ctx.lineWidth = 4.5 + Math.sin(pitch) * 1.5; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx + dx * off, sy + dy * off);
      ctx.lineTo(ex + dx * (off * 1.3), ey + dy * (off * 1.3));
      ctx.stroke();
    }
    ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 5;
    const cg = ctx.createLinearGradient(sx, sy, ex, ey);
    cg.addColorStop(0, '#f5e6c8'); cg.addColorStop(0.3, '#e8d5a8');
    cg.addColorStop(0.7, '#d4b87a'); cg.addColorStop(0.85, '#b89850');
    cg.addColorStop(1, '#7a5a28');
    ctx.strokeStyle = cg; ctx.lineWidth = 5.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1.5;
    const perpX = -dy * 1.2, perpY = dx * 1.2;
    ctx.beginPath();
    ctx.moveTo(sx + perpX, sy + perpY);
    ctx.lineTo(ex + perpX, ey + perpY);
    ctx.stroke();

    ctx.fillStyle = '#5a9fd4';
    ctx.beginPath(); ctx.arc(sx, sy, 2.8, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ================================================================
  //  上一杆回放（半透明轨迹）
  // ================================================================
  function drawTrail(ctx, trail, alpha) {
    if (!trail || !trail.length) return;
    ctx.save();
    ctx.lineCap = 'round';
    for (const line of trail) {
      if (!line.pts || line.pts.length < 2) continue;
      ctx.strokeStyle = line.color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(line.pts[0].x, line.pts[0].y);
      for (let i = 1; i < line.pts.length; i++) ctx.lineTo(line.pts[i].x, line.pts[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ================================================================
  //  加塞控制盘
  // ================================================================
  function drawSpinPad(ctx, size, spinX, spinY, enabled, pitchDeg, eff) {
    const cx = size / 2, cy = size / 2;
    // 球面比外圈半环小一圈，把环留给俯仰
    const r = size * 0.30;
    const ringR = size * 0.42;
    const ringW = 9;
    const pitch = C.clamp(pitchDeg || 0, 0, C.PITCH_MAX_DEG);
    ctx.clearRect(0, 0, size, size);

    ctx.save();
    // 球底
    const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
    g.addColorStop(0, '#fff'); g.addColorStop(0.6, '#eee'); g.addColorStop(1, '#c8c8c8');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1;
    ctx.stroke();

    // 十字准线
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.stroke();

    // 有效击点范围（0.75R）
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(cx, cy, r * C.SPIN_MAX, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);

    // ---- 后斯诺克：60° 仰角也够不到的极限区 ----
    // 正常情况不会有阴影——低杆只是要求更高的杆角，不是不能打。
    // 只有贴死 + 极限低塞/侧塞，抬到 60° 仍会碰到障碍时才画红区。
    const hardSy = eff && Number.isFinite(eff.hardSy) ? eff.hardSy : -C.SPIN_MAX;
    if (hardSy > -C.SPIN_MAX + 1e-4) {
      const by = cy - C.clamp(hardSy, -1, 1) * r;
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = 'rgba(255,71,87,0.17)';
      ctx.fillRect(cx - r, by, r * 2, cy + r - by);
      ctx.strokeStyle = 'rgba(255,71,87,0.32)';
      ctx.lineWidth = 1;
      for (let x = -r * 2; x <= r * 2; x += 7) {
        ctx.beginPath();
        ctx.moveTo(cx + x, cy + r);
        ctx.lineTo(cx + x + (cy + r - by), by);
        ctx.stroke();
      }
      ctx.restore();

      const half = Math.sqrt(Math.max(0, r * r - (by - cy) * (by - cy)));
      ctx.strokeStyle = 'rgba(255,71,87,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - half, by); ctx.lineTo(cx + half, by);
      ctx.stroke();

      ctx.fillStyle = 'rgba(255,150,150,0.95)';
      ctx.font = 'bold 8px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('MAX', cx, by + (cy + r - by) * 0.55);
    }

    // 击点。**纵轴要反过来**：canvas 的 y 向下，而物理里 spinY>0 = 高杆。
    // 直接 cy + spinY*… 会让"点在球心下方"显示成高杆 —— 真实台球里打
    // 球心下方是低杆/缩杆，正好相反。
    // spinX/spinY 已经是物理单位（0..SPIN_MAX），直接乘球面半径。
    const px = cx + spinX * r;
    const py = cy - spinY * r;
    if (enabled) {
      ctx.shadowColor = '#ff4757'; ctx.shadowBlur = 8;
      ctx.fillStyle = '#ff4757';
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
    }
    ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2); ctx.fill();

    // ---- 俯仰半环（第八轮）：下半圆，左端 0°、右端 60° ----
    const pitchTh = Math.PI * (1 - pitch / C.PITCH_MAX_DEG);

    ctx.globalAlpha = enabled ? 1 : 0.35;
    ctx.lineCap = 'butt';

    // 底轨
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = ringW;
    ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI); ctx.stroke();

    // 已选区间（左端 → 旋钮）
    if (pitch > 0.5) {
      ctx.strokeStyle = 'rgba(255,217,61,0.55)';
      ctx.lineWidth = ringW;
      ctx.beginPath(); ctx.arc(cx, cy, ringR, pitchTh, Math.PI); ctx.stroke();
    }

    // 刻度 0 / 15 / 30 / 45 / 60
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let p = 0; p <= C.PITCH_MAX_DEG; p += 15) {
      const th = Math.PI * (1 - p / C.PITCH_MAX_DEG);
      const c = Math.cos(th), s = Math.sin(th);
      ctx.beginPath();
      ctx.moveTo(cx + c * (ringR - ringW / 2), cy + s * (ringR - ringW / 2));
      ctx.lineTo(cx + c * (ringR + ringW / 2), cy + s * (ringR + ringW / 2));
      ctx.stroke();
      if (p === 0 || p === C.PITCH_MAX_DEG) {
        ctx.fillText(p + '°', cx + c * (ringR + ringW / 2 + 5), cy + s * (ringR + ringW / 2 + 5));
      }
    }

    // 旋钮 + 读数
    const kx = cx + Math.cos(pitchTh) * ringR;
    const ky = cy + Math.sin(pitchTh) * ringR;
    ctx.shadowColor = '#ffd93d'; ctx.shadowBlur = 6;
    ctx.fillStyle = enabled ? '#ffd93d' : 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.arc(kx, ky, 4, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '9px sans-serif';
    ctx.fillText('Pitch ' + Math.round(pitch) + '°', cx, cy + ringR - 13);

    // 后斯诺克的最低仰角：在俯仰环上标一道红刻度。
    // 杆角低于它时 fitContact 会自动抬上去，所以旋钮本身显示实际角度。
    if (eff && eff.requiredDeg >= 8) {
      const req = C.clamp(eff.requiredDeg, 0, C.PITCH_MAX_DEG);
      const thReq = Math.PI * (1 - req / C.PITCH_MAX_DEG);
      const cR = Math.cos(thReq), sR = Math.sin(thReq);
      ctx.strokeStyle = 'rgba(255,120,120,0.95)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx + cR * (ringR - ringW / 2 - 2), cy + sR * (ringR - ringW / 2 - 2));
      ctx.lineTo(cx + cR * (ringR + ringW / 2 + 2), cy + sR * (ringR + ringW / 2 + 2));
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,150,150,0.9)';
      ctx.font = '8px sans-serif';
      ctx.fillText('min ' + Math.round(req) + '°', cx, cy + ringR + 9);
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // 击点文字描述
  function spinText(spinX, spinY) {
    if (Math.abs(spinX) < 0.08 && Math.abs(spinY) < 0.08) return 'Centre';
    const parts = [];
    if (spinY > 0.08) parts.push('Top');
    else if (spinY < -0.08) parts.push('Bottom');
    if (spinX > 0.08) parts.push('Right');
    else if (spinX < -0.08) parts.push('Left');
    return parts.join(' + ') || 'Centre';
  }

  SNK.render = {
    drawTable: drawTable,
    drawBall: drawBall,
    drawBalls: function (ctx, balls, cueBall, spinX, spinY, aimAngle, pitchDeg) {
      for (const b of balls) drawBall(ctx, b);
      if (cueBall) drawSpinMark(ctx, cueBall, spinX, spinY, aimAngle, pitchDeg);
    },
    drawTargets: drawTargets,
    drawPreview: drawPreview,
    drawCue: drawCue,
    drawTrail: drawTrail,
    drawSpinPad: drawSpinPad,
    spinText: spinText,
    lighten: lighten,
    darken: darken,
  };
})(window.SNK = window.SNK || {});
