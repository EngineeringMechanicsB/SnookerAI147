// ================================================================
//  tutorial.js — 教学模式的数据与判定
//
//  每条 lesson 由若干 step 组成；每个 step 给出：
//    title / goal / tip   中英双语文字
//    setup(C)             摆球、瞄准、力度、练习目标圈
//    check(ctx, C)        球停稳后判定是否通过
//
//  main.js 负责把 setup 变成真实的 Ball、拦截结算、显示菜单/结果。
//  判定只看真实物理结果（进袋/首碰/白球最终位置），不看玩家点了什么按钮。
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

  const LESSONS = [
    {
      id: 'aim',
      icon: '1',
      title: L('Straight pot', '直线进球'),
      intro: L('Line up the cue ball and the red, then send the red into the top middle pocket.',
        '把白球和红球摆成一条直线，把红球打进上方中袋。'),
      steps: [{
        title: L('Aim and pot', '瞄准与入袋'),
        goal: L('Pot the red into the top middle pocket', '红球进上方中袋'),
        tip: L('Move the mouse to aim, click the table to lock, set power, then Shoot / Space.',
          '移动鼠标瞄准，点击台面锁定，调好力度，按击球 / 空格。'),
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
            return { pass: true, msg: L('Red potted. That is the basic straight shot.',
              '红球进了。这就是最基本的直线球。') };
          }
          return { pass: false, msg: L('Not potted. Check the line: white, red, pocket must be straight.',
            '没进。检查瞄准线：白球、红球、袋口要成一条直线。') };
        },
      }],
    },

    {
      id: 'follow',
      icon: '2',
      title: L('Top spin / follow', '高杆 / 跟球'),
      intro: L('Top spin makes the cue ball follow the object ball after contact.',
        '高杆让白球在撞到目标球后继续向前跟。'),
      steps: [{
        title: L('Follow through', '跟球练习'),
        goal: L('Finish with the cue ball inside the yellow circle', '白球停在黄圈内'),
        tip: L('Hit the top half of the white (Shift + W, or drag the spin dot up), then shoot at medium power.',
          '打白球上半部（Shift + W，或把红点往上拖），用中等力度出杆。'),
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
        check: function (ctx, C) {
          if (ctx.firstContact === 'red' && near(ctx.cue, ctx.zone) && !ctx.cue.potted) {
            return { pass: true, msg: L('Good follow. The cue ball carried on after contact.',
              '漂亮。白球撞球后继续向前跟了。') };
          }
          return { pass: false, msg: L('The cue ball did not follow far enough. Add more top spin.',
            '白球跟得不够远。加一点高杆再试。') };
        },
      }],
    },

    {
      id: 'draw',
      icon: '3',
      title: L('Bottom spin / draw', '低杆 / 缩杆'),
      intro: L('Bottom spin makes the cue ball come back towards you after contact.',
        '低杆让白球撞球后往回缩。'),
      steps: [{
        title: L('Draw back', '缩杆练习'),
        goal: L('Finish with the cue ball inside the yellow circle behind its start', '白球停在起点后方的黄圈内'),
        tip: L('Hit the bottom half of the white (Shift + S), use firm power, and keep the cue flat.',
          '打白球下半部（Shift + S），力度大一点，杆保持平。'),
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
            return { pass: true, msg: L('Good draw. The cue ball came back off the red.',
              '漂亮。白球从红球那里缩回来了。') };
          }
          return { pass: false, msg: L('Not enough draw. Hit lower and use a firmer stroke.',
            '缩杆不够。击点再低一点，力度再大一点。') };
        },
      }],
    },

    {
      id: 'side',
      icon: '4',
      title: L('Side spin / cushion', '侧塞 / 库边'),
      intro: L('Side spin changes the angle off a cushion. This is why players use it for position and kicks.',
        '侧塞会改变撞库后的反弹角。走位和解球都靠它。'),
      steps: [{
        title: L('Bend it off the rail', '用塞改变反弹'),
        goal: L('Finish with the cue ball inside the yellow circle', '白球停在黄圈内'),
        tip: L('Aim up-right at about 45°, use medium right side spin, and shoot at about 40% power.',
          '朝右上约 45° 瞄准，加中等右塞，力度保持约 40%。'),
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
            return { pass: true, msg: L('That is side spin. The cushion changed the angle.',
              '这就是侧塞。库边把反弹角改变了。') };
          }
          return { pass: false, msg: L('Missed the circle. Try a medium right-side hit.',
            '没进圈。试试中等偏上的右塞。') };
        },
      }],
    },

    {
      id: 'rules',
      icon: '5',
      title: L('Scoring rules', '计分规则'),
      intro: L('In snooker, reds and colours alternate. A red is 1 point; each colour has its own value.',
        '斯诺克里红球和彩球必须交替打。红球 1 分，彩球按颜色计分。'),
      steps: [
        {
          title: L('First: a red', '第一杆：红球'),
          goal: L('Pot the red', '打进红球'),
          tip: L('Reds are 1 point. Pot this red into the top middle pocket.',
            '红球 1 分。把这颗红球打进上方中袋。'),
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
              return { pass: true, msg: L('Red is 1 point. Next you must hit a colour.',
                '红球 1 分。下一杆必须打彩球。') };
            }
            return { pass: false, msg: L('Pot the red first.', '先打进红球。') };
          },
        },
        {
          title: L('Then: a colour', '第二杆：彩球'),
          goal: L('Pot the blue', '打进蓝球'),
          tip: L('After a red, any colour is on. Blue is worth 5 points. It respots after being potted.',
            '打进红球后可以打任意彩球。蓝球 5 分，进袋后会复位。'),
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
              return { pass: true, msg: L('Blue is 5 points. Red, colour, red, colour… until the reds are gone.',
                '蓝球 5 分。红、彩、红、彩……直到红球打完。') };
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
      intro: L('When a ball is tight behind the cue ball, the cue must be raised. The game raises it automatically, but the shot loses power.',
        '白球背后贴球时，球杆必须抬高。游戏会自动抬杆，但力量会变小。'),
      steps: [{
        title: L('Hit the blue', '击中蓝球'),
        goal: L('First contact must be the blue', '第一颗必须碰到蓝球'),
        tip: L('A red is sitting just behind the white. Aim at the blue and shoot; watch the cue angle and power loss.',
          '一颗红球紧贴在白球后方。瞄准蓝球直接打；注意杆角和力量损失。'),
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
            return { pass: true, msg: L('You cleared the blocking ball. That is why the cue was raised.',
              '你越过了挡球。这就是球杆被抬高的原因。') };
          }
          return { pass: false, msg: L('The blue was not hit first. Aim straight at it and shoot again.',
            '没有先碰到蓝球。直接瞄准蓝球再试。') };
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
