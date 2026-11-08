// ================================================================
//  i18n.js — 中英文界面
//
//  只做三件事：
//    1. 保存/读取语言（localStorage: snk.lang）；
//    2. t(key, vars) 给静态 UI 与格式串用；
//    3. tr(text) 给现有 showMsg/showFoul 的英文原文做整句替换。
//  动态球名、座位名、单杆数字等由 main.js 调 t / ballName 组合。
// ================================================================
(function (SNK) {
  'use strict';
  if (!SNK) return;

  const KEY = 'snk.lang';
  let lang = 'en';
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'zh' || saved === 'en') lang = saved;
    else if ((navigator.language || '').toLowerCase().indexOf('zh') === 0) lang = 'zh';
  } catch (e) { /* ignore */ }

  const DICT = {
    en: {
      'ui.human': 'Human',
      'ui.break': 'Break',
      'ui.high': 'High {n}',
      'ui.shoot': 'Shoot',
      'ui.confirm': 'Confirm',
      'ui.pause': 'Pause',
      'ui.resume': 'Resume',
      'ui.restart': 'Restart',
      'ui.view2d': '2D View',
      'ui.view3d': '3D View',
      'ui.orbit': '3D Orbit',
      'ui.topView': 'Top View',
      'ui.saves': 'Saves',
      'ui.soundOn': 'Sound On',
      'ui.soundOff': 'Sound Off',
      'ui.soundClick': 'Sound: click to enable',
      'ui.spinTitle': 'Spin / pitch',
      'ui.spinCentre': 'Centre',
      'ui.topOnly': 'top {pct}% only',
      'msg.cueBlockedTitle': 'Cue blocked',
      'msg.cueBlocked': 'A ball / cushion is tight behind the cue ball. Only the top {pct}% is reachable — cue raised about {deg}°.',
      'ui.powerDrag': 'Drag to set power',
      'ui.volume': 'Volume',
      'ui.spinHint': 'Click label to centre\nW/S or ↑/↓ power · A/D or ←/→ aim\nShift + A/D side · Shift + W/S follow\nQ/E side · X reset · outer ring pitch',
      'ui.reds': 'Reds',
      'ui.ballsLeft': 'Balls left',
      'ui.on': 'On',
      'ui.ballOn': 'Ball on',
      'ui.lowestFirst': 'lowest first',
      'ui.openTable': 'Open table',
      'ui.solids': 'Solids',
      'ui.stripes': 'Stripes',
      'ui.eight': '8-ball',
      'ui.clearance': 'Clearance',
      'ui.respotted': 'Respotted black',
      'ui.turn': 'Turn',
      'ui.thinking': 'Thinking…', 'ui.threads': 'threads', 'ui.paused': 'Paused',
      'turn.seatOn': 'Seat {seat} · on {ball}',
      'turn.eight': '8-Ball · Seat {seat} · {group}',
      'turn.nine': '9-Ball · Seat {seat} · on {ball}',
      'turn.clearance': 'Clearance · Seat {seat}',
      'turn.respotted': 'Respotted black · Seat {seat}',
      'turn.placing': 'Cue ball in hand · Seat {seat} · inside the D',
      'label.anyColor': 'any colour',
      'label.anyBall': 'any ball',
      'label.solids': 'solids',
      'label.stripes': 'stripes',
      'label.eight': 'the 8-ball',
      'label.open': 'open table',
      'label.red': 'red ball', 'label.yellow': 'yellow ball', 'label.green': 'green ball',
      'label.brown': 'brown ball', 'label.blue': 'blue ball', 'label.pink': 'pink ball',
      'label.black': 'black ball', 'label.white': 'white ball',
      'summary.frame': 'Frame',
      'summary.max': 'Frame · Maximum 147',
      'summary.points': 'Points', 'summary.shots': 'Shots', 'summary.pots': 'Balls potted',
      'summary.rate': 'Pot rate*', 'summary.best': 'Highest break', 'summary.fouls': 'Fouls',
      'summary.foulPoints': 'Points given away', 'summary.safeties': 'Safeties played',
      'summary.snookers': 'Snookers made', 'summary.visits': 'Visits',
      'summary.avg': 'Points per visit',
      'summary.nextAuto': 'Next frame starts automatically…',
      'summary.hint': 'Press R to rematch · Esc to close',
      'summary.rematch': 'Rematch', 'summary.close': 'Close',
      'save.title': 'Saved games', 'save.empty': 'Empty', 'save.save': 'Save', 'save.load': 'Load',
      'save.export': 'Export save file…', 'save.import': 'Import save file…',
      'save.auto': 'Auto', 'save.slot': 'Slot {n}',
      'save.saveTo': 'Save to {slot}', 'save.wait': 'Wait for the balls to stop',
      'save.savedTo': 'Saved to {slot}',
      'mode.restart': 'Restart', 'mode.classic': 'Snooker', 'mode.eight': '8-Ball',
      'mode.nine': '9-Ball', 'mode.clearance': 'Clearance', 'mode.respotted': 'Respotted Black',
      'speed.slow': 'Slow', 'speed.normal': 'Normal', 'speed.fast': 'Fast', 'speed.turbo': 'Turbo',
      'amb.auto': 'Auto (real time)', 'amb.match': 'Match', 'amb.day': 'Day',
      'amb.evening': 'Evening', 'amb.night': 'Night',
      'guide.off': 'Guide: Off', 'guide.cue': 'Guide: Cue',
      'guide.first': 'Guide: Cue + First', 'guide.all': 'Guide: All',
    },
    zh: {
      'ui.human': '玩家',
      'ui.break': '单杆',
      'ui.high': '最高 {n}',
      'ui.shoot': '击球',
      'ui.confirm': '确认',
      'ui.pause': '暂停',
      'ui.resume': '继续',
      'ui.restart': '重新开始',
      'ui.view2d': '2D 视图',
      'ui.view3d': '3D 视图',
      'ui.orbit': '3D 环绕',
      'ui.topView': '俯视图',
      'ui.saves': '存档',
      'ui.soundOn': '声音开',
      'ui.soundOff': '声音关',
      'ui.soundClick': '声音：点击启用',
      'ui.spinTitle': '加塞 / 俯仰',
      'ui.spinCentre': '中心',
      'ui.topOnly': '只能打上部 {pct}%',
      'msg.cueBlockedTitle': '后斯诺克',
      'msg.cueBlocked': '白球背后被球/库边挡住，只能打白球上部 {pct}%，球杆约抬高 {deg}°。',
      'ui.powerDrag': '拖动力度条设置力度',
      'ui.volume': '音量',
      'ui.spinHint': '点击文字回正\nW/S 或 ↑/↓ 力度 · A/D 或 ←/→ 方向\nShift + A/D 左右塞 · Shift + W/S 高低杆\nQ/E 左右塞 · X 清空 · 外圈调俯仰',
      'ui.reds': '红球',
      'ui.ballsLeft': '剩余球',
      'ui.on': '目标',
      'ui.ballOn': '目标球',
      'ui.lowestFirst': '先打最小号',
      'ui.openTable': '开放球台',
      'ui.solids': '全色球',
      'ui.stripes': '花色球',
      'ui.eight': '8 号球',
      'ui.clearance': '清彩',
      'ui.respotted': '复位黑球',
      'ui.turn': '回合',
      'ui.thinking': '思考中…', 'ui.threads': '线程', 'ui.paused': '已暂停',
      'turn.seatOn': '座位 {seat} · 目标 {ball}',
      'turn.eight': '8 球 · 座位 {seat} · {group}',
      'turn.nine': '9 球 · 座位 {seat} · 目标 {ball}',
      'turn.clearance': '清彩 · 座位 {seat}',
      'turn.respotted': '复位黑球 · 座位 {seat}',
      'turn.placing': '自由球 · 座位 {seat} · D 区内摆球',
      'label.anyColor': '任意彩球',
      'label.anyBall': '任意球',
      'label.solids': '全色球',
      'label.stripes': '花色球',
      'label.eight': '8 号球',
      'label.open': '开放球台',
      'label.red': '红球', 'label.yellow': '黄球', 'label.green': '绿球',
      'label.brown': '棕球', 'label.blue': '蓝球', 'label.pink': '粉球',
      'label.black': '黑球', 'label.white': '白球',
      'summary.frame': '本局',
      'summary.max': '本局 · 满分 147',
      'summary.points': '得分', 'summary.shots': '出杆', 'summary.pots': '进球',
      'summary.rate': '进球率*', 'summary.best': '最高单杆', 'summary.fouls': '犯规',
      'summary.foulPoints': '送分', 'summary.safeties': '防守',
      'summary.snookers': '做成斯诺克', 'summary.visits': '上手',
      'summary.avg': '每次上手得分',
      'summary.nextAuto': '下一局将自动开始…',
      'summary.hint': '按 R 再来一局 · Esc 关闭',
      'summary.rematch': '再来一局', 'summary.close': '关闭',
      'save.title': '存档', 'save.empty': '空', 'save.save': '保存', 'save.load': '读取',
      'save.export': '导出存档…', 'save.import': '导入存档…',
      'save.auto': '自动', 'save.slot': '存档 {n}',
      'save.saveTo': '保存到 {slot}', 'save.wait': '等球停稳',
      'save.savedTo': '已保存到 {slot}',
      'mode.restart': '重新开始', 'mode.classic': '斯诺克', 'mode.eight': '8 球',
      'mode.nine': '9 球', 'mode.clearance': '清彩', 'mode.respotted': '复位黑球',
      'speed.slow': '慢速', 'speed.normal': '正常', 'speed.fast': '快速', 'speed.turbo': '极快',
      'amb.auto': '自动（跟随时间）', 'amb.match': '比赛', 'amb.day': '白天',
      'amb.evening': '傍晚', 'amb.night': '夜晚',
      'guide.off': '辅助线：关', 'guide.cue': '辅助线：母球',
      'guide.first': '辅助线：母球 + 首触', 'guide.all': '辅助线：全部',
    },
  };

  // 现有 showMsg/showFoul 的整句替换。英文原文作为 key，只维护中文。
  const PHRASES = {
    'New frame': '新的一局',
    'Aim with the mouse · set power on the bar · <em>Shoot</em> with Space':
      '鼠标瞄准 · 力度条设置力度 · 按 <em>空格</em> 或点击击球',
    'Set some power first': '先设置力度',
    'Drag the power bar, or press <em>&larr;</em> <em>&rarr;</em>':
      '拖动力度条，或按方向键调整',
    'Drag the power bar, or press <em>W</em>/<em>S</em> or <em>&uarr;</em>/<em>&darr;</em>':
      '拖动力度条，或按 W/S 或 ↑/↓ 调整',
    'Cue ball in hand': '白球自由球',
    'Drag the white anywhere inside the D, then press <em>Space</em> to confirm':
      '把白球拖到 D 区任意位置，然后按 <em>空格</em> 确认',
    'Placing the cue ball': '摆放白球',
    'Drag inside the D, then press Space to confirm': '在 D 区内拖动，按空格确认',
    'The cue ball must be inside the D': '白球必须放在 D 区内',
    '8-Ball': '8 球',
    'Open table · pot any colour to choose solids or stripes, then the 8-ball':
      '开放球台 · 先进任意球定组，再打 8 号球',
    '9-Ball': '9 球',
    'Hit the lowest-numbered ball first · pot the 9 to win':
      '必须先碰台面最小号球 · 打进 9 号球获胜',
    'Clearance': '清彩',
    'Pot the colours in order: yellow &rarr; green &rarr; brown &rarr; blue &rarr; pink &rarr; black':
      '按顺序清彩：黄球 &rarr; 绿球 &rarr; 棕球 &rarr; 蓝球 &rarr; 粉球 &rarr; 黑球',
    'Respotted black': '复位黑球',
    'Pot the black to win the frame': '打进黑球赢下本局',
    'Snooker': '斯诺克',
    '8-Ball break': '8 球开球',
    '8-ball potted on the break — re-racking': '开球打进 8 号球——重新摆球',
    '147 on': '147 在望',
    'Maximum 147': '满分 147',
    'Century': '百分杆',
    'Half-century': '五十分杆',
    'Snookers required': '需要斯诺克',
    'Negative play': '消极球',
    'Must score': '必须进球',
    'Game loaded': '读档成功',
    'Orbit view': '环绕视角',
    'Move mouse to aim · drag to look around · wheel zoom · Space/Shoot to play · C reset · Esc top view':
      '移动鼠标瞄准 · 拖动看四周 · 滚轮缩放 · 空格/击球按钮出杆 · C 重置 · Esc 回俯视',
    '3D unavailable': '3D 不可用',
    'three.js not found, or this browser has no WebGL': 'three.js 未加载，或浏览器不支持 WebGL',
    'Frame': '本局',
    'Frame · Maximum 147': '本局 · 满分 147',
    'Points': '得分', 'Shots': '出杆', 'Balls potted': '进球', 'Pot rate*': '进球率*',
    'Highest break': '最高单杆', 'Fouls': '犯规', 'Points given away': '送分',
    'Safeties played': '防守', 'Snookers made': '做成斯诺克', 'Visits': '上手',
    'Points per visit': '每次上手得分',
    'Next frame starts automatically…': '下一局将自动开始…',
    'Press R to rematch · Esc to close': '按 R 再来一局 · Esc 关闭',
    'Rematch': '再来一局', 'Close': '关闭',
    'Saved games': '存档', 'Empty': '空', 'Save': '保存', 'Load': '读取',
    'Export save file…': '导出存档…', 'Import save file…': '导入存档…',
    'Auto': '自动',
    'Ball on': '目标球',
    'Open table': '开放球台', 'Solids': '全色球', 'Stripes': '花色球',
    'Reds': '红球', 'Balls left': '剩余球', 'On': '目标', 'Clearance': '清彩',
    'Respotted black': '复位黑球', '8-ball': '8 号球',
    'any colour': '任意彩球', 'any ball': '任意球', 'solids': '全色球',
    'stripes': '花色球', 'the 8-ball': '8 号球', 'open table': '开放球台',
    'red ball': '红球', 'yellow ball': '黄球', 'green ball': '绿球',
    'brown ball': '棕球', 'blue ball': '蓝球', 'pink ball': '粉球',
    'black ball': '黑球', 'white ball': '白球',
    'Centre': '中心', 'Top': '高杆', 'Bottom': '低杆', 'Left': '左塞', 'Right': '右塞',
    'Top + Right': '高杆 + 右塞', 'Top + Left': '高杆 + 左塞',
    'Bottom + Right': '低杆 + 右塞', 'Bottom + Left': '低杆 + 左塞',
    'Idle a minute and the camera takes over · Drag to orbit · Wheel to zoom · C for the top view · H to hide the UI':
      '闲置一分钟镜头会自动接管 · 拖动环绕 · 滚轮缩放 · C 回俯视 · H 隐藏界面',
    'Spectating (2D view) · H to hide the UI': '观战中（2D）· 按 H 隐藏界面',
    'Aim locked · click to move · wheel or ← → to fine-tune':
      '瞄准已锁定 · 点击解锁 · 滚轮或 ← → 微调',
    'Click the table to lock the aim': '点击台面锁定瞄准',
    'Free ball': '自由球',
    'Foul': '犯规',
    'Foul: no ball hit': '犯规：空杆',
    'Foul: wrong ball first': '犯规：先碰错球',
    'Foul: cue ball potted': '犯规：白球落袋',
    'Foul: no ball on the table': '犯规：台面无目标球',
    'Foul: no ball hit the cushion': '犯规：没有球碰库',
    'Foul: ball off the table': '犯规：球跳出台面',
    'Foul: push shot': '犯规：推杆',
  };

  function dict() { return DICT[lang] || DICT.en; }

  function t(key, vars) {
    const d = dict();
    let s = d[key];
    if (s === undefined) s = (DICT.en[key] !== undefined ? DICT.en[key] : key);
    if (vars) {
      for (const k in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, k)) {
          s = s.split('{' + k + '}').join(String(vars[k]));
        }
      }
    }
    return s;
  }

  function tr(text) {
    if (lang === 'en' || !text) return text;
    if (PHRASES[text] !== undefined) return PHRASES[text];

    let m;
    if ((m = /^(.+) has made a 147$/.exec(text))) return m[1] + ' 打出了 147';
    if ((m = /^(.+) breaks 100$/.exec(text))) return m[1] + ' 单杆破百';
    if ((m = /^(.+) passes 50$/.exec(text))) return m[1] + ' 单杆超过 50';
    if ((m = /^(.+) is snookered — no direct line to a legal ball$/.exec(text)))
      return m[1] + ' 被做斯诺克——没有直接解球线路';
    if ((m = /^(.+) is on for a maximum — (.+) scored, (.+) left$/.exec(text)))
      return m[1] + ' 有机会打出 147——已得 ' + m[2] + '，台面剩 ' + m[3];
    if ((m = /^(.+) trails by (\d+) with (\d+) on the table$/.exec(text)))
      return m[1] + ' 落后 ' + m[2] + ' 分，台面还剩 ' + m[3] + ' 分';
    if ((m = /^(.+) has gone three shots without a pot — forcing the attack$/.exec(text)))
      return m[1] + ' 连续三杆没进球，开始强制进攻';
    if ((m = /^Scores level at (.+) — black respotted, first pot wins$/.exec(text)))
      return '比分 ' + m[1] + ' 打平，黑球复位，先打进者获胜';
    if ((m = /^(.+) · (\d+) away$/.exec(text))) return m[1] + ' · 罚 ' + m[2] + ' 分';

    if (text === 'No ball hit') return '空杆';
    if (text === 'Cue ball potted') return '白球落袋';
    if (text === 'Must hit a colour first, but hit a red') return '必须先碰彩球，但碰到了红球';
    if ((m = /^Must hit a red first, but hit (.+)$/.exec(text))) return '必须先碰红球，但碰到了' + m[1];
    if ((m = /^Must hit (.+) first, but hit (.+)$/.exec(text))) return '必须先碰' + m[1] + '，但碰到了' + m[2];
    if ((m = /^Potted (.+) while on a red$/.exec(text))) return '打红球阶段打进了' + m[1];
    if ((m = /^Must pot (.+), but potted (.+)$/.exec(text))) return '必须打进' + m[1] + '，但打进了' + m[2];
    if (text === 'Potted a red while on a colour') return '打彩球阶段打进了红球';
    if ((m = /^Must hit (.+) first$/.exec(text))) return '必须先碰' + m[1];
    if (text === 'Must hit your own group first') return '必须先碰自己组别的球';
    if (text === 'Must hit the 8-ball first') return '必须先碰 8 号球';
    if (text === 'Open table · must hit a colour first') return '开放球台 · 必须先碰彩球';
    if (text === '8-ball potted too early') return '8 号球打进过早';
    if (text === 'Repeated short safeties / cue ball left in the pack — open the table')
      return '连续短防守 / 白球留在球堆里 —— 把台面打开';
    return text;
  }

  function ballName(label) {
    if (lang === 'zh') {
      if (label === 'red') return '红球';
      if (label === 'yellow') return '黄球';
      if (label === 'green') return '绿球';
      if (label === 'brown') return '棕球';
      if (label === 'blue') return '蓝球';
      if (label === 'pink') return '粉球';
      if (label === 'black') return '黑球';
      if (label === 'white') return '白球';
    }
    return SNK.COL_CN[label] || label;
  }

  function labelText(label) {
    if (!label) return '—';
    if (label === 'any') return t('label.anyColor');
    if (label === 'any ball') return t('label.anyBall');
    if (label === 'open table') return t('label.open');
    if (label === 'solids') return t('label.solids');
    if (label === 'stripes') return t('label.stripes');
    if (label === 'eight') return t('label.eight');
    if (lang === 'zh') {
      const key = 'label.' + label;
      const s = t(key);
      if (s !== key) return s;
    }
    return (SNK.COL_CN[label] || label) + (lang === 'en' ? ' ball' : '');
  }

  function setLang(next) {
    if (next !== 'en' && next !== 'zh') return;
    lang = next;
    try { localStorage.setItem(KEY, lang); } catch (e) { /* ignore */ }
  }

  SNK.i18n = {
    get lang() { return lang; },
    setLang: setLang,
    t: t,
    tr: tr,
    ballName: ballName,
    labelText: labelText,
    humanName: function () { return t('ui.human'); },
  };
})(window.SNK = window.SNK || {});
