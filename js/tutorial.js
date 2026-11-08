// ================================================================
//  tutorial.js — 教学模式的数据与判定
//
//  课程只保留四组核心能力：
//    1. 单球加塞：高杆 / 低杆 / 右塞 / 左塞，白球和母球各往哪走
//    2. 两球叫位：打红叫黑、打黑叫红、打黑同时拆球堆
//    3. 库边加塞：顺塞 / 反塞改变反弹角
//    4. 开球：薄碰球堆、白球回开球区
//
//  每步提供：
//    title / goal / focus   标题、目标、一句话要点
//    tip                    台面提示
//    coach                  教练笔记（目标 → 动作 → 白球线路 → 常见错误）
//    demo                   正确杆法，Watch demo 用
//    setup(C)               摆球、瞄准、力度、目标圈
//    check(ctx, C)          球停稳后的真实物理判定
// ================================================================
(function (SNK) {
  'use strict';
  if (!SNK) return;

  function L(en, zh) { return { en: en, zh: zh }; }
  function txt(o) {
    if (!o) return '';
    const lang = SNK.i18n && SNK.i18n.lang === 'zh' ? 'zh' : 'en';
    return o[lang] || o.en || '';
  }
  function near(ball, zone) {
    return zone && ball && ball.isOnTable() &&
      Math.hypot(ball.x - zone.x, ball.y - zone.y) <= zone.r;
  }
  function potted(ctx, label) {
    return ctx.potted && ctx.potted.indexOf(label) >= 0;
  }
  function aimAtPocket(cue, red, pocket, offset) {
    const dx = pocket.x - red.x, dy = pocket.y - red.y;
    const d = Math.hypot(dx, dy) || 1;
    const gx = red.x - dx / d * 2 * SNK.BALL_R;
    const gy = red.y - dy / d * 2 * SNK.BALL_R;
    return Math.atan2(gy - cue.y, gx - cue.x) + (offset || 0);
  }
  function standardRack(C) {
    const balls = [];
    const apexX = C.PINK_X + C.BALL_D + 1;
    const rowStep = Math.round(Math.sqrt(3) / 2 * C.BALL_D * 100) / 100;
    for (let row = 0; row < 5; row++) {
      const rx = apexX + row * rowStep;
      for (let col = 0; col <= row; col++) {
        balls.push({ label: 'red', x: rx, y: C.CY2 + (col - row / 2) * C.BALL_D });
      }
    }
    for (const label of C.COL_ORDER) {
      const p = C.getColorPos(label);
      if (p) balls.push({ label: label, x: p.x, y: p.y });
    }
    return balls;
  }
  function moved(ctx, label, threshold) {
    if (!ctx.startBalls || !ctx.balls) return 0;
    let n = 0;
    const lim = threshold == null ? 12 : threshold;
    for (let i = 0; i < ctx.startBalls.length; i++) {
      const a = ctx.startBalls[i], b = ctx.balls[i];
      if (!a || a.label !== label || !b) continue;
      if (Math.hypot(b.x - a.x, b.y - a.y) > lim) n++;
    }
    return n;
  }
  function redBall(ctx) {
    return ctx.balls ? ctx.balls.find(b => b.label === 'red') : null;
  }

  const LESSONS = [
    {
      id: 'spin',
      icon: '1',
      title: L('Spin on a single ball', '单球加塞'),
      intro: L('Before cushions and position, learn what each spin does on one object ball: top makes the white follow, bottom screws it back, and side makes the white deflect while throwing the object ball.',
        '先不碰库边，只看单颗球：高杆让白球跟，低杆让白球缩，侧塞让白球偏、同时把目标球甩向一侧。'),
      steps: [
        {
          title: L('Centre hit: stun', '中心击点：定杆'),
          goal: L('Leave the white near the contact point', '白球停在撞击点附近'),
          focus: L('Centre contact: stun. The red takes the pace.', '中心击点：定杆，红球带走速度。'),
          tip: L('Hit the centre of the white with a smooth stroke. The white should stop near the contact point, not follow or draw.',
            '平顺地打白球正中心。白球应停在撞击点附近，不跟也不缩。'),
          coach: L(
            '1. Centre contact, no side, no top or bottom. The white stops close to the contact point; the object ball takes most of the pace. This is a stun shot.\n' +
            '2. Keep the cue level and accelerate through the ball. A flat, committed stroke gives a clean stun; a soft poke lets gravity and cloth friction add a little roll.\n' +
            '3. Use: this is the reference shot for every spin. When the next ball is close to the contact point, stun is often the simplest position.',
            '1. 击点正中，不加塞、不高杆、不低杆。白球停在撞击点附近，目标球带走大部分速度。这就是定杆。\n' +
            '2. 球杆放平，加速穿过白球。果断的平杆得到干净的定杆；软绵绵一戳，台呢摩擦会让白球多滚一点。\n' +
            '3. 使用场景：这是所有杆法的参照。下一颗球就在撞击点附近时，定杆往往是最简单的叫位。'),
          demo: { angle: 0, power: 14, spinX: 0, spinY: 0 },
          setup: function (C) {
            return {
              cue: { x: C.CX_TABLE - 150, y: C.CY2 },
              balls: [{ label: 'red', x: C.CX_TABLE + 50, y: C.CY2 }],
              aimAngle: 0,
              power: 14, spinX: 0, spinY: 0, pitchDeg: 0,
              guideMode: 2,
              zone: { x: C.CX_TABLE + 101, y: C.CY2, r: 35 },
            };
          },
          check: function (ctx) {
            if (ctx.firstContact === 'red' && near(ctx.cue, ctx.zone) && !ctx.cue.potted) {
              return { pass: true, msg: L('Clean stun. The white stopped at the contact point.',
                '干净的定杆。白球停在撞击点附近。') };
            }
            return { pass: false, msg: L('The white ran too far. Strike the centre with a smooth, level stroke.',
              '白球跑远了。打正中心，出杆平顺。') };
          },
        },
        {
          title: L('Cue pitch: butt angle', '杆角：抬杆尾'),
          goal: L('Finish with the white inside the forward circle', '白球停在前方黄圈内'),
          focus: L('Pitch adds follow and costs power.', '抬杆增加跟球，也吃掉力量。'),
          tip: L('Use the outer pitch ring. A moderate butt angle adds follow; too steep and the white loses too much speed.',
            '用外圈俯仰环。适度抬杆会增加跟球；抬得太陡，白球反而走不远。'),
          coach: L(
            '1. Contact point and butt angle are two different controls. Contact point sets the spin; butt angle changes the cue’s approach, adds follow and loses forward speed by cos(angle).\n' +
            '2. About 15–30° gives the most follow here. At 45–60° the speed loss overtakes the follow; the white can finish shorter than a flat centre hit.\n' +
            '3. Use: when you need extra follow without moving the contact point, or when a ball or cushion forces the butt up. The game auto-raises the cue over a blocker; the pitch ring lets you add more.',
            '1. 击点和杆角是两个不同的控制。击点决定旋转；杆角改变出杆角度，增加跟球，同时按 cos(角度) 损失前向速度。\n' +
            '2. 这里 15–30° 的跟球最多。到 45–60°，速度损失超过跟球收益，白球可能比平杆停得还近。\n' +
            '3. 使用场景：需要额外跟球但不想改击点时，或者球/库边逼你把杆尾抬高时。被挡时游戏会自动抬杆，俯仰环可以再加。'),
          demo: { angle: 0, power: 16, spinX: 0, spinY: 0, pitchDeg: 25 },
          setup: function (C) {
            return {
              cue: { x: C.CX_TABLE - 150, y: C.CY2 },
              balls: [{ label: 'red', x: C.CX_TABLE + 50, y: C.CY2 }],
              aimAngle: 0,
              power: 16, spinX: 0, spinY: 0, pitchDeg: 0,
              guideMode: 2,
              zone: { x: C.CX_TABLE + 168, y: C.CY2, r: 45 },
            };
          },
          check: function (ctx) {
            if (ctx.firstContact === 'red' && near(ctx.cue, ctx.zone) && !ctx.cue.potted) {
              return { pass: true, msg: L('That is cue pitch: the butt angle added follow without changing the contact point.',
                '这就是杆角：不攻击点，靠抬杆尾增加跟球。') };
            }
            return { pass: false, msg: L('Set the pitch ring around 20–30° and hit the centre of the white.',
              '把俯仰环调到 20–30° 左右，打白球中心。') };
          },
        },
        {
          title: L('Top spin: follow', '高杆：跟球'),
          goal: L('Finish with the white inside the yellow circle ahead', '白球停在前方黄圈内'),
          focus: L('Top spin: white follows the object ball.', '高杆：白球跟着目标球走。'),
          tip: L('Strike one or two tips above centre, keep the cue level, accelerate through the white and hold the finish.',
            '打中心上方一到两个皮头，杆放平，加速穿过白球，出杆后停住。'),
          coach: L(
            '1. Contact point: one or two tips above centre. A slightly higher bridge keeps the cue level; the tip must not dig into the cloth.\n' +
            '2. Accelerate through the white and hold the finish. The cue ball keeps its forward rotation after impact, so it follows the object ball.\n' +
            '3. Common fault: a short, jabby stroke produces stun, not follow. If the white stops at contact, you decelerated.\n' +
            '4. Use: when the next ball is in front of the contact point and you want the white to travel forward through it.',
            '1. 击点：中心上方一到两个皮头。架手略高，球杆保持水平，皮头不要扎进台呢。\n' +
            '2. 加速穿过白球，出杆后停住。白球撞球后保留前滚，所以会跟着目标球走。\n' +
            '3. 常见错误：短促一戳，打出来的是定杆，不是跟球。白球撞完就停，说明你减速了。\n' +
            '4. 使用场景：下一颗球在撞击点前方，需要白球继续向前走。'),
          demo: { angle: 0, power: 14, spinX: 0, spinY: 0.6 },
          setup: function (C) {
            return {
              cue: { x: C.CX_TABLE - 150, y: C.CY2 },
              balls: [{ label: 'red', x: C.CX_TABLE + 50, y: C.CY2 }],
              aimAngle: 0,
              power: 14, spinX: 0, spinY: 0, pitchDeg: 0,
              guideMode: 2,
              zone: { x: C.CX_TABLE + 198, y: C.CY2, r: 55 },
            };
          },
          check: function (ctx) {
            if (ctx.firstContact === 'red' && near(ctx.cue, ctx.zone) && !ctx.cue.potted) {
              return { pass: true, msg: L('That is follow. The white carried its forward rotation after contact.',
                '这就是跟球。白球带着前滚继续向前走了。') };
            }
            return { pass: false, msg: L('The white did not follow far enough. More top spin, and finish the stroke.',
              '白球跟得不够远。多一些高杆，出杆送到底。') };
          },
        },
        {
          title: L('Bottom spin: draw', '低杆：缩杆'),
          goal: L('Finish with the white inside the yellow circle behind', '白球停在后方黄圈内'),
          focus: L('Bottom spin: white screws back.', '低杆：白球往回缩。'),
          tip: L('Strike one or two tips below centre, keep the cue level and accelerate. Do not poke.',
            '打中心下方一到两个皮头，杆放平，加速出杆。不要一戳就停。'),
          coach: L(
            '1. Contact point: one or two tips below centre. Keep the cue level; if the butt drops, the tip can jump or tear the cloth.\n' +
            '2. Draw needs speed through the ball. Accelerate, do not poke. The white slides first, then the backspin takes over and screws it back.\n' +
            '3. Common fault: deceleration. A soft, decelerating stroke gives stun, not screw. Play it firm and finish the stroke.\n' +
            '4. Use: when the next ball is behind the contact point, or when you need to bring the white back out of a crowd.',
            '1. 击点：中心下方一到两个皮头。球杆保持水平；杆尾一掉，皮头容易跳球或刮坏台呢。\n' +
            '2. 低杆需要穿过球的速度。加速，不要戳。白球先滑，然后回旋把它拉回来。\n' +
            '3. 常见错误：减速。软绵绵地出杆只会得到定杆，不是缩杆。发力，把杆送完。\n' +
            '4. 使用场景：下一颗球在撞击点后方，或者需要把白球从球堆里拉出来。'),
          demo: { angle: 0, power: 18, spinX: 0, spinY: -0.6 },
          setup: function (C) {
            return {
              cue: { x: C.CX_TABLE - 150, y: C.CY2 },
              balls: [{ label: 'red', x: C.CX_TABLE + 50, y: C.CY2 }],
              aimAngle: 0,
              power: 18, spinX: 0, spinY: 0, pitchDeg: 0,
              guideMode: 2,
              zone: { x: C.CX_TABLE - 108, y: C.CY2, r: 55 },
            };
          },
          check: function (ctx) {
            if (ctx.firstContact === 'red' && near(ctx.cue, ctx.zone) && !ctx.cue.potted) {
              return { pass: true, msg: L('That is draw. The white bit and came back.',
                '这就是缩杆。白球咬住后缩回来了。') };
            }
            return { pass: false, msg: L('Not enough draw. Lower contact and a firmer, accelerating stroke.',
              '缩杆不够。击点再低一点，出杆更果断、加速。') };
          },
        },
        {
          title: L('Right side: squirt and throw', '右塞：偏杆与甩球'),
          goal: L('Throw the red into the right-hand circle', '把红球甩进右侧黄圈'),
          focus: L('Right side: white deflects left, red is thrown right.', '右塞：白球往左偏，红球往右甩。'),
          tip: L('Strike the right side of the white. Watch two things: the white squirts left, and the red is thrown to the right.',
            '打白球右侧。看两件事：白球往左偏，红球被甩向右侧。'),
          coach: L(
            '1. Side is named from the player’s view: right side is the right half of the white. The cue tip pushes the white away from the tip (squirt), so the white leaves slightly left.\n' +
            '2. At contact the spinning white rubs across the red and throws it to the right. This is throw; it is not aim. Allow for it or aim to use it.\n' +
            '3. Common fault: using side on every shot. Side adds squirt, swerve and throw; on a long pot, centre ball is more reliable.\n' +
            '4. Use: to throw a ball into a pocket, to make the white squirt away from a blocker, or to set up the angle for the next cushion.',
            '1. 侧塞按球员视角命名：右塞就是白球右半边。皮头会把白球往反方向推（偏杆），所以白球出杆时略向左。\n' +
            '2. 撞球瞬间，带旋的白球在红球表面蹭过，把红球甩向右侧。这是“甩球”，不是瞄歪了；要么修正，要么利用它。\n' +
            '3. 常见错误：每杆都加塞。侧塞会带来偏杆、弧线和甩球；长台中心球更可靠。\n' +
            '4. 使用场景：把球甩进袋、让白球避开挡球，或者为下一库调整角度。'),
          demo: { angle: 0, power: 14, spinX: 0.6, spinY: 0 },
          setup: function (C) {
            return {
              cue: { x: C.CX_TABLE - 150, y: C.CY2 },
              balls: [{ label: 'red', x: C.CX_TABLE + 50, y: C.CY2 }],
              aimAngle: 0,
              power: 14, spinX: 0, spinY: 0, pitchDeg: 0,
              guideMode: 2,
              zone: { x: C.CX_TABLE + 313, y: C.CY2 + 35, r: 45 },
            };
          },
          check: function (ctx) {
            const red = redBall(ctx);
            if (ctx.firstContact === 'red' && near(red, ctx.zone) && !ctx.cue.potted) {
              return { pass: true, msg: L('That is right side: the white went left, the red was thrown right.',
                '这就是右塞：白球往左偏，红球被甩向右侧。') };
            }
            return { pass: false, msg: L('Use strong right side. Watch the white squirt left and the red throw right.',
              '用强一点的右塞。看白球往左偏、红球往右甩。') };
          },
        },
        {
          title: L('Left side: the mirror', '左塞：镜像'),
          goal: L('Throw the red into the left-hand circle', '把红球甩进左侧黄圈'),
          focus: L('Left side: white deflects right, red is thrown left.', '左塞：白球往右偏，红球往左甩。'),
          tip: L('Strike the left side of the white. Everything mirrors: the white squirts right, the red is thrown left.',
            '打白球左侧。全部镜像：白球往右偏，红球往左甩。'),
          coach: L(
            '1. Left side mirrors right side: the white leaves slightly right (squirt), and the red is thrown to the left.\n' +
            '2. The stronger the side and the slower the shot, the more time swerve has to bend the white. On firm shots, squirt dominates.\n' +
            '3. Use side with a purpose: position, cushion angle or throwing a ball into a pocket. Do not add it by habit.\n' +
            '4. Use: mirror of right side — throw the red left or make the white squirt right.',
            '1. 左塞是右塞的镜像：白球出杆略向右（偏杆），红球被甩向左侧。\n' +
            '2. 塞越强、球越慢，弧线越有时间把白球带弯；发力球以偏杆为主。\n' +
            '3. 侧塞要有目的：走位、库边角度，或者把球“甩”进袋。不要养成每杆都加的习惯。\n' +
            '4. 使用场景：右塞的镜像——把红球甩向左，或让白球向右偏。'),
          demo: { angle: 0, power: 14, spinX: -0.6, spinY: 0 },
          setup: function (C) {
            return {
              cue: { x: C.CX_TABLE - 150, y: C.CY2 },
              balls: [{ label: 'red', x: C.CX_TABLE + 50, y: C.CY2 }],
              aimAngle: 0,
              power: 14, spinX: 0, spinY: 0, pitchDeg: 0,
              guideMode: 2,
              zone: { x: C.CX_TABLE + 313, y: C.CY2 - 35, r: 45 },
            };
          },
          check: function (ctx) {
            const red = redBall(ctx);
            if (ctx.firstContact === 'red' && near(red, ctx.zone) && !ctx.cue.potted) {
              return { pass: true, msg: L('That is left side: the white went right, the red was thrown left.',
                '这就是左塞：白球往右偏，红球被甩向左侧。') };
            }
            return { pass: false, msg: L('Use strong left side. Watch the white squirt right and the red throw left.',
              '用强一点的左塞。看白球往右偏、红球往左甩。') };
          },
        },
        {
          title: L('Top + right: follow-left', '高杆右塞：前左'),
          goal: L('Finish with the white in the forward-left circle', '白球停在前方偏左的黄圈内'),
          focus: L('Forward roll plus right side: the white runs forward-left, the red is thrown right.', '前滚加右塞：白球往左前跑，红球往右甩。'),
          tip: L('Top and right side together. Watch the white run forward, then bend left; the red is thrown right.',
            '高杆加右塞。看白球先向前、再往左弯；红球被甩向右侧。'),
          coach: L(
            '1. Top + right combines forward roll and right side. The white runs forward after contact, while squirt takes it left; the red is thrown right.\n' +
            '2. Route: the white follows first, then the side bends it. Finish in the forward-left circle. The red is also thrown right, so allow for it on the pot.\n' +
            '3. Use: when the next ball is forward and to your left. A common position shot: pot the red, follow with right side, land on the black side of the table.\n' +
            '4. Common fault: too much side. The white curves away from the position circle; use one to one-and-a-half tips.',
            '1. 高杆加右塞：前滚加右塞。白球撞球后向前，同时偏杆把它带向左；红球被甩向右。\n' +
            '2. 线路：白球先跟，再被塞带弯。目标是前方偏左的黄圈。红球同时被甩向右，进球要留出修正。\n' +
            '3. 使用场景：下一颗球在前方偏左。常见叫位：打进红球，高杆右塞，白球落到黑球那一侧。\n' +
            '4. 常见错误：右塞太多，白球弯出黄圈。用一到一点五个皮头就够。'),
          demo: { angle: 0, power: 18, spinX: 0.6, spinY: 0.6 },
          setup: function (C) {
            return {
              cue: { x: C.CX_TABLE - 150, y: C.CY2 },
              balls: [{ label: 'red', x: C.CX_TABLE + 50, y: C.CY2 }],
              aimAngle: 0,
              power: 18, spinX: 0, spinY: 0, pitchDeg: 0,
              guideMode: 2,
              zone: { x: C.CX_TABLE + 282, y: C.CY2 - 82, r: 35 },
            };
          },
          check: function (ctx) {
            if (ctx.firstContact === 'red' && near(ctx.cue, ctx.zone) && !ctx.cue.potted) {
              return { pass: true, msg: L('High + right: the white followed and bent left. That is the forward-left route.',
                '高杆右塞：白球向前跟，再往左弯。这就是前左线路。') };
            }
            return { pass: false, msg: L('Use strong top and right side. Aim the white into the forward-left circle.',
              '用强高杆加右塞，把白球送到前方偏左的黄圈。') };
          },
        },
        {
          title: L('Top + left: follow-right', '高杆左塞：前右'),
          goal: L('Finish with the white in the forward-right circle', '白球停在前方偏右的黄圈内'),
          focus: L('Forward roll plus left side: the white runs forward-right, the red is thrown left.', '前滚加左塞：白球往右前跑，红球往左甩。'),
          tip: L('Top and left side. The white runs forward, then bends right; the red is thrown left.',
            '高杆加左塞。白球先向前、再往右弯；红球被甩向左侧。'),
          coach: L(
            '1. Top + left is the mirror of top + right: the white follows, then left side bends it right; the red is thrown left.\n' +
            '2. Route: forward-right circle. This is the natural route for a red on the left of the table when the next ball is on the right.\n' +
            '3. Use: when the next ball is forward and to your right, or when you want to follow into the right side of the pack.\n' +
            '4. Common fault: hitting too hard. The follow overshoots and the bend becomes harder to judge; keep the pace smooth.',
            '1. 高杆左塞是右塞的镜像：白球先跟，再被左塞带向右；红球被甩向左。\n' +
            '2. 线路：前方偏右的黄圈。下一颗球在右侧时，这是很自然的线路。\n' +
            '3. 使用场景：下一颗球在前方偏右，或者要高杆跟进球堆右侧。\n' +
            '4. 常见错误：发力过猛。白球冲过头，弯线也难判断；力度放平顺。'),
          demo: { angle: 0, power: 18, spinX: -0.6, spinY: 0.6 },
          setup: function (C) {
            return {
              cue: { x: C.CX_TABLE - 150, y: C.CY2 },
              balls: [{ label: 'red', x: C.CX_TABLE + 50, y: C.CY2 }],
              aimAngle: 0,
              power: 18, spinX: 0, spinY: 0, pitchDeg: 0,
              guideMode: 2,
              zone: { x: C.CX_TABLE + 282, y: C.CY2 + 82, r: 35 },
            };
          },
          check: function (ctx) {
            if (ctx.firstContact === 'red' && near(ctx.cue, ctx.zone) && !ctx.cue.potted) {
              return { pass: true, msg: L('High + left: the white followed and bent right. That is the forward-right route.',
                '高杆左塞：白球向前跟，再往右弯。这就是前右线路。') };
            }
            return { pass: false, msg: L('Use strong top and left side. Aim the white into the forward-right circle.',
              '用强高杆加左塞，把白球送到前方偏右的黄圈。') };
          },
        },
        {
          title: L('Bottom + right: draw-left', '低杆右塞：后左'),
          goal: L('Finish with the white in the back-left circle', '白球停在后方偏左的黄圈内'),
          focus: L('Draw plus right side: the white screws back-left, the red is thrown right.', '低杆加右塞：白球往左后缩，红球往右甩。'),
          tip: L('Bottom and right side, firm stroke. The white screws back, then bends left; the red is thrown right.',
            '低杆加右塞，发力。白球先往回缩，再往左弯；红球被甩向右侧。'),
          coach: L(
            '1. Bottom + right: the white screws back after contact, then right side bends it left; the red is thrown right.\n' +
            '2. Route: back-left circle. This is a recovery route: pot the ball and bring the white back out of the pack towards the left.\n' +
            '3. Use: when the next ball is behind and to your left, or when you need to escape a crowd after the pot.\n' +
            '4. Common fault: the draw is too weak. The white stops before the circle; commit to the low contact and accelerate.',
            '1. 低杆加右塞：白球撞球后先往回缩，再被右塞带向左；红球被甩向右。\n' +
            '2. 线路：后方偏左的黄圈。这是一条“解围”线路：进球后把白球从球堆里拉向左后方。\n' +
            '3. 使用场景：下一颗球在后方偏左，或者进球后需要从人群中脱身。\n' +
            '4. 常见错误：低杆不够。白球停在黄圈前；打低点，果断加速。'),
          demo: { angle: 0, power: 18, spinX: 0.6, spinY: -0.6 },
          setup: function (C) {
            return {
              cue: { x: C.CX_TABLE - 150, y: C.CY2 },
              balls: [{ label: 'red', x: C.CX_TABLE + 50, y: C.CY2 }],
              aimAngle: 0,
              power: 18, spinX: 0, spinY: 0, pitchDeg: 0,
              guideMode: 2,
              zone: { x: C.CX_TABLE - 23, y: C.CY2 - 34, r: 35 },
            };
          },
          check: function (ctx) {
            if (ctx.firstContact === 'red' && near(ctx.cue, ctx.zone) && !ctx.cue.potted) {
              return { pass: true, msg: L('Draw + right: the white screwed back and bent left. That is the back-left route.',
                '低杆右塞：白球缩回并向左弯。这就是后左线路。') };
            }
            return { pass: false, msg: L('Use deep draw and right side. Bring the white into the back-left circle.',
              '用强低杆加右塞，把白球送到后方偏左的黄圈。') };
          },
        },
        {
          title: L('Bottom + left: draw-right', '低杆左塞：后右'),
          goal: L('Finish with the white in the back-right circle', '白球停在后方偏右的黄圈内'),
          focus: L('Draw plus left side: the white screws back-right, the red is thrown left.', '低杆加左塞：白球往右后缩，红球往左甩。'),
          tip: L('Bottom and left side. The white screws back, then bends right; the red is thrown left.',
            '低杆加左塞。白球先往回缩，再往右弯；红球被甩向左侧。'),
          coach: L(
            '1. Bottom + left is the mirror of bottom + right: the white screws back and bends right; the red is thrown left.\n' +
            '2. Route: back-right circle. Use it when the next ball is behind and to your right.\n' +
            '3. This is the hardest of the four combinations: draw and side fight each other for the cue ball’s energy. Play it firm and keep the cue level.\n' +
            '4. Common fault: too much side on a slow shot. The white swerves; use a firm stroke and one to one-and-a-half tips.',
            '1. 低杆左塞是右塞的镜像：白球往回缩，再往右弯；红球被甩向左。\n' +
            '2. 线路：后方偏右的黄圈。下一颗球在后方偏右时用它。\n' +
            '3. 这是四种组合里最难的：低杆和侧塞在抢白球的能量。发力，杆放平。\n' +
            '4. 常见错误：慢球加太多塞，白球走出弧线。用发力球，一到一点五个皮头。'),
          demo: { angle: 0, power: 18, spinX: -0.6, spinY: -0.6 },
          setup: function (C) {
            return {
              cue: { x: C.CX_TABLE - 150, y: C.CY2 },
              balls: [{ label: 'red', x: C.CX_TABLE + 50, y: C.CY2 }],
              aimAngle: 0,
              power: 18, spinX: 0, spinY: 0, pitchDeg: 0,
              guideMode: 2,
              zone: { x: C.CX_TABLE - 23, y: C.CY2 + 34, r: 35 },
            };
          },
          check: function (ctx) {
            if (ctx.firstContact === 'red' && near(ctx.cue, ctx.zone) && !ctx.cue.potted) {
              return { pass: true, msg: L('Draw + left: the white screwed back and bent right. That is the back-right route.',
                '低杆左塞：白球缩回并向右弯。这就是后右线路。') };
            }
            return { pass: false, msg: L('Use deep draw and left side. Bring the white into the back-right circle.',
              '用强低杆加左塞，把白球送到后方偏右的黄圈。') };
          },
        },
      ],
    },

    {
      id: 'position',
      icon: '2',
      title: L('Position play', '两球叫位'),
      intro: L('Position is played one shot ahead. Pot the ball in front of you and leave the white with a natural angle to the next one.',
        '叫位要提前一杆想。打进眼前的球，把白球留到下一颗球的自然角上。'),
      steps: [
        {
          title: L('Red → black', '打红叫黑'),
          goal: L('Pot the red and finish inside the circle by the black', '红球进袋，白球停在黑球旁的黄圈内'),
          focus: L('Pot for position: leave the white on the black side.', '为下一杆而打：白球留在黑球一侧。'),
          tip: L('Read the pot first, then choose the spin for the white. The demo uses a little left side; watch where the white goes after contact.',
            '先看清进球线，再为白球选塞。演示用了少量左塞；注意白球撞球后往哪走。'),
          coach: L(
            '1. Read the pot first: ghost ball, pocket, line of aim. Then choose the spin for the cue ball route, not for the pot.\n' +
            '2. The demo uses a little left side to hold the white on the black side after contact. Side also causes squirt: the white leaves the tip slightly away from the side you strike, so allow for it.\n' +
            '3. After contact the white leaves along the tangent line, then the spin bends it. Aim to finish in the circle, not just to pot the red. A good position shot leaves the next ball easy; a great one leaves the black on a natural angle.',
            '1. 先看清进球线：假想球、袋口、瞄准线。然后为白球的线路选塞，而不是为进球选塞。\n' +
            '2. 演示用少量左塞，让白球撞球后留在黑球这一侧。侧塞还有偏杆：白球会朝皮头反方向偏，要留出修正。\n' +
            '3. 白球撞球后先沿切线走，再被塞带弯。目标是停在圈里，不是只把红球打进。好的叫位让下一杆简单，更好的叫位让黑球留下自然角。'),
          demo: function (C) {
            const cue = { x: C.CX_TABLE + 142, y: C.CY2 + 82 };
            const red = { x: C.CX_TABLE + 292, y: C.CY2 - 68 };
            return {
              angle: aimAtPocket(cue, red, { x: C.R, y: C.T }, 0),
              power: 16, spinX: -0.2, spinY: 0,
            };
          },
          setup: function (C) {
            return {
              cue: { x: C.CX_TABLE + 142, y: C.CY2 + 82 },
              balls: [
                { label: 'red', x: C.CX_TABLE + 292, y: C.CY2 - 68 },
                { label: 'black', x: C.CX_TABLE + 322, y: C.CY2 - 138 },
              ],
              aimAngle: aimAtPocket(
                { x: C.CX_TABLE + 142, y: C.CY2 + 82 },
                { x: C.CX_TABLE + 292, y: C.CY2 - 68 },
                { x: C.R, y: C.T }, 0),
              power: 16, spinX: 0, spinY: 0, pitchDeg: 0,
              guideMode: 3,
              zone: { x: C.CX_TABLE + 301, y: C.CY2 - 154, r: 55 },
            };
          },
          check: function (ctx) {
            const blackOn = ctx.balls.some(b => b.label === 'black' && b.isOnTable());
            if (potted(ctx, 'red') && blackOn && near(ctx.cue, ctx.zone) && !ctx.cue.potted) {
              return { pass: true, msg: L('Red potted and the white is on the black. That is position.',
                '红球进了，白球也走到黑球旁边。这就是叫位。') };
            }
            return { pass: false, msg: L('Pot the red, then use left side to bring the white into the circle.',
              '先打进红球，再用左塞把白球送进黄圈。') };
          },
        },
        {
          title: L('Black → red', '打黑叫红'),
          goal: L('Pot the black and finish inside the circle by the red', '黑球进袋，白球停在红球旁的黄圈内'),
          focus: L('The same principle, mirror image.', '同样的原则，镜像局面。'),
          tip: L('Black is the high-value ball, but the next red pays for the break. Pot the black and leave the white by the red.',
            '黑球分值高，但下一颗红球才让单杆继续。打进黑球，把白球留在红球旁边。'),
          coach: L(
            '1. The ball you pot and the ball you play position for are two different jobs. Pot the black cleanly; position the white for the red.\n' +
            '2. The same left side holds the white on the red side after contact. Be careful with squirt on the longer pot.\n' +
            '3. Common fault: over-hitting the black. The white runs past the red and the next shot becomes a recovery. Smooth pace, finish the stroke.',
            '1. 打进的球和叫位的球是两件事。干净打进黑球，同时把白球留到红球那边。\n' +
            '2. 同样用少量左塞，让白球撞球后留在红球这一侧。长台要注意偏杆。\n' +
            '3. 常见错误：黑球发力过猛。白球冲过红球，下一杆就变成救球。力度放平顺，送完杆。'),
          demo: function (C) {
            const cue = { x: C.CX_TABLE + 142, y: C.CY2 + 82 };
            const black = { x: C.CX_TABLE + 292, y: C.CY2 - 68 };
            return {
              angle: aimAtPocket(cue, black, { x: C.R, y: C.T }, 0),
              power: 16, spinX: -0.2, spinY: 0,
            };
          },
          setup: function (C) {
            return {
              cue: { x: C.CX_TABLE + 142, y: C.CY2 + 82 },
              balls: [
                { label: 'black', x: C.CX_TABLE + 292, y: C.CY2 - 68 },
                { label: 'red', x: C.CX_TABLE + 322, y: C.CY2 - 138 },
              ],
              aimAngle: aimAtPocket(
                { x: C.CX_TABLE + 142, y: C.CY2 + 82 },
                { x: C.CX_TABLE + 292, y: C.CY2 - 68 },
                { x: C.R, y: C.T }, 0),
              power: 16, spinX: 0, spinY: 0, pitchDeg: 0,
              guideMode: 3,
              zone: { x: C.CX_TABLE + 301, y: C.CY2 - 154, r: 55 },
            };
          },
          check: function (ctx) {
            const redOn = ctx.balls.some(b => b.label === 'red' && b.isOnTable());
            if (potted(ctx, 'black') && redOn && near(ctx.cue, ctx.zone) && !ctx.cue.potted) {
              return { pass: true, msg: L('Black potted and the white is on the red. The break continues.',
                '黑球进了，白球也走到红球旁边。单杆可以继续。') };
            }
            return { pass: false, msg: L('Pot the black, then use left side to bring the white to the red.',
              '先打进黑球，再用左塞把白球送到红球旁。') };
          },
        },
        {
          title: L('Pot black, split the pack', '打黑拆球堆'),
          goal: L('Pot the black and move at least two reds', '黑球进袋，并撞动至少两颗红球'),
          focus: L('Deep screw: pot the black, then enter the pack.', '强低杆：打进黑球，再钻进球堆。'),
          tip: L('This is a practice-table split: straight black into the top middle, deep screw, white back through the pack. Watch the demo.',
            '这是练习摆法：黑球直进上方中袋，强低杆把白球拉回球堆。先看演示。'),
          coach: L(
            '1. This drill puts the pack directly behind the white, so the geometry is honest: a straight black, deep screw, and the white comes back through the reds.\n' +
            '2. Strike low, accelerate and keep the cue level. The black goes to the pocket; the white must come back through the pack, not stop in front of it.\n' +
            '3. In a match the angle is rarely this clean. The rule is the same: only split the pack when the white can reach it with a controlled screw; otherwise play the black for position and keep the break alive.',
            '1. 这个练习把球堆放在白球正后方，几何关系是真实的：黑球直进，强低杆，白球从红球堆中穿回来。\n' +
            '2. 打低点，加速，杆放平。黑球进袋；白球必须穿进球堆，不能停在球堆前面。\n' +
            '3. 实战里很少有这么干净的角。原则一样：只有白球能用可控的低杆够到球堆时才拆；够不到就老老实实叫位，保住单杆。'),
          demo: { angle: -Math.PI / 2, power: 22, spinX: 0, spinY: -0.75 },
          setup: function (C) {
            const cx = C.CX_TABLE, cy = C.CY2;
            return {
              cue: { x: cx, y: cy + 82 },
              balls: [
                { label: 'black', x: cx, y: cy - 68 },
                { label: 'red', x: cx, y: cy + 177 },
                { label: 'red', x: cx - 12, y: cy + 197 },
                { label: 'red', x: cx + 12, y: cy + 197 },
                { label: 'red', x: cx - 24, y: cy + 217 },
                { label: 'red', x: cx, y: cy + 217 },
                { label: 'red', x: cx + 24, y: cy + 217 },
              ],
              aimAngle: -Math.PI / 2,
              power: 22, spinX: 0, spinY: 0, pitchDeg: 0,
              guideMode: 3,
              zone: { x: cx, y: cy + 197, r: 82 },
            };
          },
          check: function (ctx) {
            if (potted(ctx, 'black') && moved(ctx, 'red', 12) >= 2 && !ctx.cue.potted) {
              return { pass: true, msg: L('Black potted and the pack is open. That is a split.',
                '黑球进了，球堆也开了。这就是拆球堆。') };
            }
            return { pass: false, msg: L('Pot the black, then send the white back through the pack with deep screw.',
              '打进黑球，再用强低杆把白球从球堆中穿回来。') };
          },
        },
      ],
    },

    {
      id: 'cushion',
      icon: '3',
      title: L('Side spin and the cushion', '库边加塞'),
      intro: L('Side is named by the first cushion: running side opens the rebound and keeps speed, check side closes the angle and kills speed.',
        '侧塞按第一库命名：顺塞放大反弹角、保留速度；反塞收紧角度、吃掉速度。'),
      steps: [{
        title: L('Bend it off the rail', '用塞改变反弹'),
        goal: L('Finish with the white inside the yellow circle', '白球停在黄圈内'),
        focus: L('Running side opens the angle; check side closes it.', '顺塞开角，反塞收角。'),
        tip: L('Aim up-right at about 45°. The demo uses running side; watch the white open the rebound angle.',
          '朝右上约 45° 瞄准。演示用顺塞；注意白球把反弹角打开。'),
        coach: L(
          '1. Name the side by the first cushion: with the cushion on your left, right side is running side; with the cushion on your right, left side is running side. Running side lengthens the angle and keeps speed; check side shortens it and kills speed.\n' +
          '2. Use one or two tips, not the edge of the ball. Side also produces squirt (the white deflects away from the tip) and swerve; allow for both.\n' +
          '3. Common fault: side on every shot. On long pots, centre ball is more reliable; save side for position, cushions and escapes.',
          '1. 按第一库命名：库在你左边，右塞就是顺塞；库在你右边，左塞就是顺塞。顺塞放大反弹角、保留速度；反塞收紧角度、吃掉速度。\n' +
          '2. 用一到两个皮头，不要打到球边。侧塞还会带来偏杆（白球朝皮头反方向偏）和弧线，要留出修正。\n' +
          '3. 常见错误：每杆都加塞。长台中心球更稳；侧塞留给走位、库边和解球。'),
        demo: { angle: -Math.PI / 4, power: 14, spinX: 0.5, spinY: 0 },
        setup: function (C) {
          return {
            cue: { x: C.CX_TABLE - 308, y: C.CY2 + 132 },
            balls: [],
            aimAngle: -Math.PI / 4,
            power: 14, spinX: 0, spinY: 0, pitchDeg: 0,
            guideMode: 3,
            zone: { x: C.CX_TABLE + 221, y: C.T + 48, r: 40 },
          };
        },
        check: function (ctx) {
          if (near(ctx.cue, ctx.zone) && !ctx.cue.potted) {
            return { pass: true, msg: L('That is side spin. The cushion changed the angle and the white found the circle.',
              '这就是侧塞。库边改变了反弹角，白球进了圈。') };
          }
          return { pass: false, msg: L('Missed the circle. Try medium running side and keep the pace calm.',
            '没进圈。试中等顺塞，力度别太大。') };
        },
      }],
    },

    {
      id: 'breakoff',
      icon: '4',
      title: L('The break-off', '开球'),
      intro: L('The break is a safety shot. Thin contact on the outside red, firm pace, and the white back to baulk.',
        '开球是一杆防守。薄碰最外侧红球，力度要够，白球回到开球区。'),
      steps: [{
        title: L('Open the pack', '打开红球堆'),
        goal: L('Hit the pack first and move at least three reds', '先碰红球堆，并撞动至少三颗红球'),
        focus: L('Thin on the pack, white back to baulk.', '薄碰球堆，白球回开球区。'),
        tip: L('Aim at the outside edge of the pack, not the middle. Firm stroke, a little side, and bring the white back.',
          '瞄准球堆外侧边缘，不要打中间。发力，带一点塞，把白球送回来。'),
        coach: L(
          '1. Aim at the outside edge of the pack, not the middle. A thin contact moves the pack a little and sends the white back up the table.\n' +
          '2. Use a firm, accelerating stroke with a little side. The side helps the white come off the cushion and return towards baulk.\n' +
          '3. Aim to finish behind the baulk line and leave no easy pot. A break that spreads the pack and leaves a chance is a bad break; safety first.',
          '1. 瞄准球堆外侧边缘，不要打中间。薄碰只会轻微撞动球堆，并把白球送回台面上方。\n' +
          '2. 用有力、加速的出杆，带一点侧塞。侧塞帮助白球撞库后往开球区回。\n' +
          '3. 目标是停在开球线后方，不给对手机会。把球堆打散还漏球，是坏开球；先防守。'),
        demo: { angle: -0.02501315078939266, power: 30, spinX: -0.4, spinY: 0.35 },
        setup: function (C) {
          return {
            cue: { x: C.CUE_START.x, y: C.CUE_START.y },
            balls: standardRack(C),
            aimAngle: -0.02501315078939266,
            power: 30, spinX: 0, spinY: 0, pitchDeg: 0,
            guideMode: 3,
            zone: { x: C.PINK_X + C.BALL_D * 2, y: C.CY2, r: 80 },
          };
        },
        check: function (ctx) {
          if (ctx.firstContact === 'red' && moved(ctx, 'red', 10) >= 3 && !ctx.cue.potted) {
            return { pass: true, msg: L('Good break. The pack is open and the white is safe.',
              '开球不错。球堆开了，白球也安全。') };
          }
          return { pass: false, msg: L('Hit the reds first and spread the pack. Thin contact, firm pace.',
            '先碰到红球，并把球堆撞开。薄碰，发力。') };
        },
      }],
    },
  ];

  SNK.tutorial = {
    lessons: LESSONS,
    byId: function (id) {
      for (let i = 0; i < LESSONS.length; i++) if (LESSONS[i].id === id) return LESSONS[i];
      return null;
    },
    txt: txt,
  };
})(window.SNK = window.SNK || {});
