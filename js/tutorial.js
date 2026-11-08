// ================================================================
//  tutorial.js — 教学模式的数据与判定
//
//  每条 lesson 由若干 step 组成；每个 step 给出：
//    title / goal / focus   课程标题、目标、一句话要点
//    tip                    台面提示条上的短句
//    coach                  教练笔记（可换行，完整讲解）
//    demo                   正确杆法，Watch demo 用
//    setup(C)               摆球、瞄准、力度、目标圈
//    check(ctx, C)          球停稳后判定是否通过
//
//  main.js 负责把 setup 变成真实的 Ball、拦截结算、显示菜单/结果。
//  判定只看真实物理结果（进袋/首碰/白球最终位置），不看玩家点了什么按钮。
//  文案按职业教练的口吻组织：目标 → 动作 → 白球线路 → 常见错误。
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
  function near(cue, zone) {
    return zone && cue && cue.isOnTable() &&
      Math.hypot(cue.x - zone.x, cue.y - zone.y) <= zone.r;
  }
  function potted(ctx, label) {
    return ctx.potted && ctx.potted.indexOf(label) >= 0;
  }
  // 目标球 → 袋口的假想球中心；返回白球应该瞄准的角度。
  function aimAtPocket(cue, red, pocket, offset) {
    const dx = pocket.x - red.x, dy = pocket.y - red.y;
    const d = Math.hypot(dx, dy) || 1;
    const gx = red.x - dx / d * 2 * SNK.BALL_R;
    const gy = red.y - dy / d * 2 * SNK.BALL_R;
    return Math.atan2(gy - cue.y, gx - cue.x) + (offset || 0);
  }
  // 标准 15 红球三角 + 六颗彩球（与主游戏开球摆法一致）
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
  // 与摆球初始位置相比，某类球被撞动了多少颗
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

  const LESSONS = [
    {
      id: 'aim',
      icon: '1',
      title: L('The line of aim', '瞄准线'),
      intro: L('Build the line before you build the shot: cue ball, ghost ball, pocket. A repeatable set-up and a cue that travels straight through the ball are the foundation of every pot.',
        '先把线搭好：白球、假想球、袋口。稳定的站位和一条穿过白球的直线，是所有进球的根。'),
      steps: [{
        title: L('Pot the straight red', '直线红球'),
        goal: L('Pot the red into the top middle pocket', '红球进上方中袋'),
        focus: L('Bridge on the line; cue through the ball.', '架手压在线上，杆穿过白球。'),
        tip: L('Find the ghost ball, put your bridge hand on the line and finish the cue towards the pocket.',
          '找到假想球，架手放在线上，出杆送向袋口。'),
        coach: L(
          '1. Stand behind the line and find the ghost ball — the spot the white must occupy at impact for the red to travel to the pocket.\n' +
          '2. Put the bridge hand down on that line, keep the cue level and strike through the centre of the white. The cue should finish towards the target, not stop at the ball.\n' +
          '3. Common fault: steering with the shoulder or lifting the butt on the final stroke. Keep the action smooth and accelerate through the ball.',
          '1. 先站在击球线后方，找到假想球——白球在撞击瞬间必须占据的位置，目标球才会朝袋口走。\n' +
          '2. 架手放在这条线上，球杆保持水平，击穿白球中心。出杆要送向目标，不要打到球就停。\n' +
          '3. 常见错误：用肩膀去掰杆，或者最后一下抬杆尾。动作要平顺，加速穿过白球。'),
        demo: { angle: -Math.PI / 2, power: 16, spinX: 0, spinY: 0 },
        setup: function (C) {
          return {
            cue: { x: C.CX_TABLE, y: C.CY2 + 150 },
            balls: [{ label: 'red', x: C.CX_TABLE, y: C.CY2 - 68 }],
            aimAngle: -Math.PI / 2,
            power: 16, spinX: 0, spinY: 0, pitchDeg: 0,
            guideMode: 3,
            zone: { x: C.CX_TABLE, y: C.T, r: 26 },
          };
        },
        check: function (ctx) {
          if (potted(ctx, 'red') && !ctx.cue.potted) {
            return { pass: true, msg: L('Red potted. That is the line: white, ghost ball, pocket.',
              '红球进了。就是这条线：白球、假想球、袋口。') };
          }
          return { pass: false, msg: L('Not potted. Check the line: white, ghost ball and pocket must be straight.',
            '没进。检查瞄准线：白球、假想球、袋口要成一条直线。') };
        },
      }],
    },

    {
      id: 'follow',
      icon: '2',
      title: L('Top spin / follow', '高杆 / 跟球'),
      intro: L('Top spin is a cueing action, not a flick. Strike above centre, accelerate through the ball and the white will keep travelling after contact.',
        '高杆是一种出杆动作，不是手腕一抖。打白球中心上方，加速送杆，白球撞球后会继续向前。'),
      steps: [{
        title: L('Follow through', '跟球练习'),
        goal: L('Finish with the cue ball inside the yellow circle', '白球停在黄圈内'),
        focus: L('Strike above centre and finish the stroke.', '打中心上方，出杆送到底。'),
        tip: L('Hit one or two tips above centre. Keep the cue level, accelerate through the white and hold the finish.',
          '打中心上方一到两个皮头。杆保持水平，加速穿过白球，出杆后停住。'),
        coach: L(
          '1. Contact point: one or two tips above centre. A slightly higher bridge keeps the cue level; the tip must not dig into the cloth.\n' +
          '2. Accelerate through the white and hold the finish. The cue ball keeps its forward rotation after impact, so it follows the object ball.\n' +
          '3. Common fault: a short, jabby stroke produces stun, not follow. If the white stops at contact, you decelerated.',
          '1. 击点：中心上方一到两个皮头。架手略高一点，球杆保持水平，皮头不要扎进台呢。\n' +
          '2. 加速穿过白球，出杆后停住。白球撞球后保留前滚，所以会跟着目标球走。\n' +
          '3. 常见错误：短促一戳，打出来的是定杆，不是跟球。白球撞完就停，说明你减速了。'),
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
            return { pass: true, msg: L('Good follow. The white carried its forward rotation after contact.',
              '漂亮。白球带着前滚继续向前走了。') };
          }
          return { pass: false, msg: L('The white did not follow far enough. More top spin, and finish the stroke.',
            '白球跟得不够远。多一些高杆，出杆送到底。') };
        },
      }],
    },

    {
      id: 'draw',
      icon: '3',
      title: L('Bottom spin / draw', '低杆 / 缩杆'),
      intro: L('Draw is played with a firm, accelerating stroke below centre. The white bites, then screws back towards you.',
        '低杆要用有力的加速出杆，打中心下方。白球先咬住，再往回缩。'),
      steps: [{
        title: L('Screw back', '缩杆练习'),
        goal: L('Finish with the cue ball inside the yellow circle behind its start', '白球停在起点后方的黄圈内'),
        focus: L('Low contact, firm stroke, cue level.', '低击点、发力、杆放平。'),
        tip: L('Strike one or two tips below centre, keep the cue level and accelerate through the ball. Do not poke.',
          '打中心下方一到两个皮头，杆保持水平，加速穿过白球。不要一戳就停。'),
        coach: L(
          '1. Contact point: one or two tips below centre. Keep the cue level; if the butt drops, the tip can jump or tear the cloth.\n' +
          '2. Draw needs speed through the ball. Accelerate, do not poke. The cue ball slides first, then the backspin takes over and screws it back.\n' +
          '3. Common fault: deceleration. A soft, decelerating stroke gives stun, not screw. Play it firm and finish the stroke.',
          '1. 击点：中心下方一到两个皮头。球杆保持水平；杆尾一掉，皮头容易跳球或刮坏台呢。\n' +
          '2. 低杆需要穿过球的速度。加速，不要戳。白球先滑，然后回旋把它拉回来。\n' +
          '3. 常见错误：减速。软绵绵地出杆只会得到定杆，不是缩杆。发力，把杆送完。'),
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
            return { pass: true, msg: L('Good draw. The white bit and came back.',
              '漂亮。白球咬住后缩回来了。') };
          }
          return { pass: false, msg: L('Not enough draw. Lower contact and a firmer, accelerating stroke.',
            '缩杆不够。击点再低一点，出杆更果断、加速。') };
        },
      }],
    },

    {
      id: 'side',
      icon: '4',
      title: L('Side spin and the cushion', '侧塞与库边'),
      intro: L('Side is named by the first cushion: running side opens the rebound and keeps speed, check side closes the angle and kills speed.',
        '侧塞按第一库来命名：顺塞放大反弹角、保留速度；反塞收紧角度、吃掉速度。'),
      steps: [{
        title: L('Bend it off the rail', '用塞改变反弹'),
        goal: L('Finish with the cue ball inside the yellow circle', '白球停在黄圈内'),
        focus: L('Running side opens the angle; check side closes it.', '顺塞开角，反塞收角。'),
        tip: L('Aim up-right at about 45°. The demo uses running side; watch the white open the rebound angle.',
          '朝右上约 45° 瞄准。演示用的是顺塞；注意白球把反弹角打开。'),
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
      id: 'rules',
      icon: '5',
      title: L('Scoring and the colour sequence', '计分与彩球顺序'),
      intro: L('A break is built on a simple rhythm: red, colour, red, colour. Know the value of every ball and the order of the colours at the end.',
        '单杆是简单的节奏：红、彩、红、彩。记住每颗球的分值，以及最后清彩的顺序。'),
      steps: [
        {
          title: L('First: a red', '第一杆：红球'),
          goal: L('Pot the red', '打进红球'),
          focus: L('Red = 1. Then you must hit a colour.', '红球 1 分，下一杆必须打彩球。'),
          tip: L('A red is worth one point. Pot it cleanly and stay on the line for the colour.',
            '红球 1 分。干净打进，并为下一颗彩球留好线路。'),
          coach: L(
            '1. Red = 1 point. After potting a red you must nominate and hit a colour; the colour is worth its own value.\n' +
            '2. While reds remain, potted colours are respotted. Black = 7, pink = 6, blue = 5, brown = 4, green = 3, yellow = 2.\n' +
            '3. Common fault: thinking only about the red. Plan which colour you want next before you strike.',
            '1. 红球 1 分。打进红球后必须指定并先碰彩球；彩球按自身分值计分。\n' +
            '2. 红球还在时，打进的彩球会复位。黑 7、粉 6、蓝 5、棕 4、绿 3、黄 2。\n' +
            '3. 常见错误：只想着这颗红球。出杆前先想好下一颗彩球打哪颗。'),
          demo: { angle: -Math.PI / 2, power: 16, spinX: 0, spinY: 0 },
          setup: function (C) {
            return {
              cue: { x: C.CX_TABLE, y: C.CY2 + 150 },
              balls: [{ label: 'red', x: C.CX_TABLE, y: C.CY2 - 68 }],
              aimAngle: -Math.PI / 2,
              power: 16, spinX: 0, spinY: 0, pitchDeg: 0,
              guideMode: 3,
              zone: { x: C.CX_TABLE, y: C.T, r: 26 },
            };
          },
          check: function (ctx) {
            if (potted(ctx, 'red') && !ctx.cue.potted) {
              return { pass: true, msg: L('Red is 1. Next ball: a colour of your choice.',
                '红球 1 分。下一杆：任选一颗彩球。') };
            }
            return { pass: false, msg: L('Pot the red first.', '先打进红球。') };
          },
        },
        {
          title: L('Then: a colour', '第二杆：彩球'),
          goal: L('Pot the blue', '打进蓝球'),
          focus: L('Blue = 5. It respots while reds remain.', '蓝球 5 分，红球还在时会复位。'),
          tip: L('After a red, any colour is on. Blue is worth five and respots. Stay on a red for the next shot.',
            '打进红球后可以打任意彩球。蓝球 5 分，进袋后复位。下一杆要回到红球。'),
          coach: L(
            '1. Blue = 5. It respots while reds remain, so the table stays the same shape.\n' +
            '2. Think about the next red before you pot the blue; the colour is only useful if it leaves a red.\n' +
            '3. When the reds are gone, the colours are taken in ascending order: yellow, green, brown, blue, pink, black.',
            '1. 蓝球 5 分，红球还在时会复位，台面形状基本不变。\n' +
            '2. 打蓝球前先想好下一颗红球；彩球只有留下红球才有价值。\n' +
            '3. 红球打完后，彩球按分值从低到高清：黄、绿、棕、蓝、粉、黑。'),
          demo: { angle: -Math.PI / 2, power: 16, spinX: 0, spinY: 0 },
          setup: function (C) {
            return {
              cue: { x: C.CX_TABLE, y: C.CY2 + 150 },
              balls: [{ label: 'blue', x: C.CX_TABLE, y: C.CY2 - 68 }],
              aimAngle: -Math.PI / 2,
              power: 16, spinX: 0, spinY: 0, pitchDeg: 0,
              guideMode: 3,
              zone: { x: C.CX_TABLE, y: C.T, r: 26 },
            };
          },
          check: function (ctx) {
            if (potted(ctx, 'blue') && !ctx.cue.potted) {
              return { pass: true, msg: L('Blue is 5. Red, colour, red, colour — until the reds are gone.',
                '蓝球 5 分。红、彩、红、彩——直到红球打完。') };
            }
            return { pass: false, msg: L('Pot the blue into the middle pocket.', '把蓝球打进中袋。') };
          },
        },
      ],
    },

    {
      id: 'cueblock',
      icon: '6',
      title: L('Cue over a ball', '后斯诺克 / 抬杆'),
      intro: L('When a ball sits tight behind the white, the cue has to be raised to clear it. The game raises it for you; the price is power.',
        '白球背后贴着球时，球杆必须抬高才能越过去。游戏会替你抬杆，代价是力量。'),
      steps: [{
        title: L('Clear the blocker', '越过挡球'),
        goal: L('First contact must be the blue', '第一颗必须碰到蓝球'),
        focus: L('A blocked cue must rise; power is the price.', '被挡的杆必须抬起，代价是力量。'),
        tip: L('A red is sitting just behind the white. The cue is raised automatically; accept the power loss and hit the blue.',
          '一颗红球紧贴白球后方。球杆会自动抬高；接受力量损失，击中蓝球。'),
        coach: L(
          '1. The cue is a straight line. If a ball sits behind the white, the butt must rise so the shaft passes over it.\n' +
          '2. The steeper the cue, the more the white wants to follow and the more forward speed is lost to the angle. You cannot cue flat through a blocking ball.\n' +
          '3. Common fault: trying to force it. Pick a higher contact point or more power and accept the loss; do not fight the blocker.',
          '1. 球杆是一条直线。白球背后有球，杆尾就必须抬高，让杆身从挡球上方过去。\n' +
          '2. 杆越陡，白球越容易跟球，前向速度损失越大。平杆是不可能从挡球中间穿过去的。\n' +
          '3. 常见错误：硬发力。改打高一点的击点，或者加一点力量，接受损失；不要跟挡球较劲。'),
        demo: { angle: 0, power: 18, spinX: 0, spinY: 0 },
        setup: function (C) {
          return {
            cue: { x: C.CX_TABLE - 8, y: C.CY2 },
            balls: [
              { label: 'red', x: C.CX_TABLE - 8 - C.BALL_R * 2 - 3, y: C.CY2 },
              { label: 'blue', x: C.CX_TABLE + 192, y: C.CY2 },
            ],
            aimAngle: 0,
            power: 18, spinX: 0, spinY: 0, pitchDeg: 0,
            guideMode: 2,
            zone: { x: C.CX_TABLE + 192, y: C.CY2, r: 30 },
          };
        },
        check: function (ctx) {
          if (ctx.firstContact === 'blue' && !ctx.cue.potted) {
            return { pass: true, msg: L('You cleared the blocker. That is why the cue was raised.',
              '你越过了挡球。这就是球杆被抬高的原因。') };
          }
          return { pass: false, msg: L('The blue was not hit first. Aim straight at it and let the cue rise.',
            '没有先碰到蓝球。直接瞄准蓝球，让球杆自己抬起来。') };
        },
      }],
    },

    {
      id: 'redblack',
      icon: '7',
      title: L('Red → black position', '打红叫黑'),
      intro: L('Position is played one shot ahead. Pot the red and leave the white on the black side of the table, with a natural angle to the black.',
        '叫位要提前一杆想。打进红球，把白球留在黑球这一侧，并给黑球留一个自然角。'),
      steps: [{
        title: L('Pot red, find the black', '打红球，叫黑球'),
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
      }],
    },

    {
      id: 'blackpack',
      icon: '8',
      title: L('Pot black, split the pack', '打黑散红'),
      intro: L('The black is the key ball. Pot it and screw the white back into the reds: one shot pots the black and opens the pack.',
        '黑球是关键球。打进黑球，同时用低杆把白球拉回红球堆：一杆既得分又开球堆。'),
      steps: [{
        title: L('Black + pack', '黑球 + 散红'),
        goal: L('Pot the black and move at least two reds', '黑球进袋，并撞动至少两颗红球'),
        focus: L('Deep screw: pot the black and enter the pack.', '强低杆：打进黑球，钻进球堆。'),
        tip: L('Strike low and commit. The white must screw back into the reds, not stop short.',
          '打低杆，果断发力。白球必须倒退回红球堆，不能停在半路。'),
        coach: L(
          '1. Strike low on the white and accelerate. The black goes to the pocket; the white bites and screws back along the line.\n' +
          '2. The white must enter the reds, not stop short. Pick the red you want to hit and use the pack to open the table.\n' +
          '3. Common fault: a soft draw that leaves the white in the middle of the table. Commit to the shot; if you cannot reach the pack, play the black for position instead of forcing the split.',
          '1. 打白球低点，加速出杆。黑球进袋，白球咬住后沿原线倒回。\n' +
          '2. 白球必须钻进红球堆，不能停在半路。选好要撞的红球，用球堆把台面打开。\n' +
          '3. 常见错误：软绵绵的低杆，白球停在台中。要打就果断；如果够不到球堆，就老老实实叫位，不要硬散。'),
        demo: function (C) {
          const cue = { x: C.CX_TABLE + 392, y: C.CY2 + 82 };
          const black = { x: C.BLACK_X, y: C.CY2 };
          return {
            angle: aimAtPocket(cue, black, { x: C.R, y: C.B }, 0.08),
            power: 26, spinX: 0, spinY: -0.75,
          };
        },
        setup: function (C) {
          const cue = { x: C.CX_TABLE + 392, y: C.CY2 + 82 };
          const black = { x: C.BLACK_X, y: C.CY2 };
          return {
            cue: cue,
            balls: [
              { label: 'black', x: black.x, y: black.y },
              { label: 'red', x: C.CX_TABLE + 212, y: C.CY2 + 32 },
              { label: 'red', x: C.CX_TABLE + 212, y: C.CY2 + 52 },
              { label: 'red', x: C.CX_TABLE + 212, y: C.CY2 + 72 },
              { label: 'red', x: C.CX_TABLE + 232, y: C.CY2 + 42 },
              { label: 'red', x: C.CX_TABLE + 232, y: C.CY2 + 62 },
              { label: 'red', x: C.CX_TABLE + 232, y: C.CY2 + 82 },
            ],
            aimAngle: aimAtPocket(cue, black, { x: C.R, y: C.B }, 0.08),
            power: 26, spinX: 0, spinY: 0, pitchDeg: 0,
            guideMode: 3,
            zone: { x: C.CX_TABLE + 222, y: C.CY2 + 57, r: 78 },
          };
        },
        check: function (ctx) {
          if (potted(ctx, 'black') && moved(ctx, 'red', 12) >= 2 && !ctx.cue.potted) {
            return { pass: true, msg: L('Black potted and the pack is open. One shot, two jobs.',
              '黑球进了，球堆也开了。一杆两用。') };
          }
          return { pass: false, msg: L('Pot the black and send the white back into the reds with deep screw.',
            '打进黑球，同时用强低杆把白球拉回红球堆。') };
        },
      }],
    },

    {
      id: 'breakoff',
      icon: '9',
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
