// ================================================================
//  save.js — 存档序列化 / localStorage / 导入导出
//
//  只负责“把一局球变成普通对象再变回来”，不碰 DOM、不碰 main.js 的 G。
//  main.js 负责何时存、何时读，以及读完以后恢复 UI / AI 调度。
//
//  存档内容只包含规则与球位，不包含动画、计时器、音效状态 ——
//  读档一律回到“球已停稳、等待出杆”的干净状态。
// ================================================================
(function (SNK) {
  'use strict';

  const VERSION = 2;
  const PREFIX = 'snk.save.v1.';
  const SLOTS = ['auto', 'slot1', 'slot2', 'slot3'];
  const MODES = ['classic', 'eightball', 'nineball', 'clearance', 'respottedBlack'];
  const LABELS = ['white', 'red', 'yellow', 'green', 'brown', 'blue', 'pink', 'black'];

  function finite(v, fallback) {
    return typeof v === 'number' && isFinite(v) ? v : (fallback || 0);
  }

  // Ball 的可持久字段。物理状态（v / ω）也存，虽然目前只在停稳时存档，
  // 但保留它们可以让以后支持“中途存档”时不必改 schema。
  function serializeBall(b) {
    return {
      label: b.label,
      x: finite(b.x), y: finite(b.y),
      active: b.active !== false, potted: !!b.potted,
      vx: finite(b.vx), vy: finite(b.vy),
      wx: finite(b.wx), wy: finite(b.wy), wz: finite(b.wz),
    };
  }

  function serialize(G) {
    return {
      v: VERSION,
      savedAt: Date.now(),
      mode: G.gameMode,
      players: G.players.map(p => ({ type: p.type, level: p.level })),
      currentPlayer: G.currentPlayer,
      scores: [G.scores[0], G.scores[1]],
      breaks: [G.breaks[0], G.breaks[1]],
      highBreak: G.highBreak,
      needRed: !!G.needRed,
      pottedRedThisTurn: !!G.pottedRedThisTurn,
      isRespottedBlack: !!G.isRespottedBlack,
      opening: !!G.opening,
      cueInHand: !!G.cueInHand,
      negativeStreak: finite(G.negativeStreak),
      noPotStreak: Array.isArray(G.noPotStreak)
        ? [finite(G.noPotStreak[0]), finite(G.noPotStreak[1])]
        : [0, 0],
      poolOpen: G.poolOpen !== false,
      poolGroups: Array.isArray(G.poolGroups) ? G.poolGroups.slice(0, 2) : [null, null],
      aimAngle: finite(G.aimAngle),
      power: finite(G.power),
      spinX: finite(G.spinX),
      spinY: finite(G.spinY),
      pitchDeg: finite(G.pitchDeg),
      guideMode: G.guideMode,
      stats: JSON.parse(JSON.stringify(G.stats)),
      balls: G.balls.map(serializeBall),
    };
  }

  // 校验 + 还原成 Ball 实例。导入的文件可能是任意 JSON，所有字段都要挡。
  function deserialize(data) {
    if (!data || typeof data !== 'object') throw new Error('Not a save file');
    if (data.v !== 1 && data.v !== VERSION) throw new Error('Unsupported save version');
    if (MODES.indexOf(data.mode) < 0) throw new Error('Unknown game mode');
    if (!Array.isArray(data.balls) || data.balls.length === 0) throw new Error('Save has no balls');

    const balls = [];
    for (const raw of data.balls) {
      if (!raw || LABELS.indexOf(raw.label) < 0) throw new Error('Bad ball in save');
      const b = new SNK.Ball(finite(raw.x), finite(raw.y), raw.label);
      b.active = raw.active !== false;
      b.potted = !!raw.potted;
      b.vx = finite(raw.vx); b.vy = finite(raw.vy);
      b.wx = finite(raw.wx); b.wy = finite(raw.wy); b.wz = finite(raw.wz);
      // 物理子步的临时量绝不信任存档
      b.px = b.x; b.py = b.y; b.pdx = 0; b.pdy = 0;
      balls.push(b);
    }
    const cueBall = balls.find(b => b.label === 'white');
    if (!cueBall) throw new Error('Save has no cue ball');

    const players = Array.isArray(data.players) && data.players.length === 2
      ? data.players.map(p => ({
          type: p && p.type === 'ai' ? 'ai' : 'human',
          level: (p && typeof p.level === 'string') ? p.level : 'master',
        }))
      : [{ type: 'human', level: 'master' }, { type: 'ai', level: 'master' }];

    const stats = Array.isArray(data.stats) && data.stats.length === 2
      ? JSON.parse(JSON.stringify(data.stats))
      : [null, null];
    for (let i = 0; i < 2; i++) {
      if (!stats[i] || typeof stats[i] !== 'object') throw new Error('Bad stats in save');
    }

    return {
      mode: data.mode,
      players,
      currentPlayer: data.currentPlayer === 1 ? 1 : 0,
      scores: [finite(data.scores && data.scores[0]), finite(data.scores && data.scores[1])],
      breaks: [finite(data.breaks && data.breaks[0]), finite(data.breaks && data.breaks[1])],
      highBreak: finite(data.highBreak),
      needRed: !!data.needRed,
      pottedRedThisTurn: !!data.pottedRedThisTurn,
      isRespottedBlack: !!data.isRespottedBlack,
      opening: data.opening === true,
      cueInHand: data.cueInHand === true,
      negativeStreak: finite(data.negativeStreak),
      noPotStreak: Array.isArray(data.noPotStreak)
        ? [finite(data.noPotStreak[0]), finite(data.noPotStreak[1])]
        : [0, 0],
      poolOpen: data.poolOpen !== false,
      poolGroups: Array.isArray(data.poolGroups) ? data.poolGroups.slice(0, 2) : [null, null],
      aimAngle: finite(data.aimAngle),
      power: Math.max(0, Math.min(SNK.MAX_POWER, finite(data.power))),
      spinX: Math.max(-SNK.SPIN_MAX, Math.min(SNK.SPIN_MAX, finite(data.spinX))),
      spinY: Math.max(-SNK.SPIN_MAX, Math.min(SNK.SPIN_MAX, finite(data.spinY))),
      pitchDeg: Math.max(0, Math.min(SNK.PITCH_MAX_DEG, finite(data.pitchDeg))),
      guideMode: [0, 1, 2, 3].indexOf(data.guideMode) >= 0 ? data.guideMode : 2,
      stats,
      balls,
      cueBall,
    };
  }

  function slotKey(slot) {
    return PREFIX + slot;
  }

  function read(slot) {
    try {
      const raw = localStorage.getItem(slotKey(slot));
      if (!raw) return null;
      const data = JSON.parse(raw);
      return (data && data.v) ? data : null;
    } catch (e) {
      return null;
    }
  }

  function write(slot, data) {
    try {
      localStorage.setItem(slotKey(slot), JSON.stringify(data));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'Storage unavailable' };
    }
  }

  function remove(slot) {
    try { localStorage.removeItem(slotKey(slot)); return true; }
    catch (e) { return false; }
  }

  function slotInfo(slot) {
    const data = read(slot);
    return data ? { empty: false, savedAt: data.savedAt || 0, data } : { empty: true, savedAt: 0, data: null };
  }

  SNK.save = {
    VERSION,
    SLOTS,
    serialize,
    deserialize,
    read,
    write,
    remove,
    slotInfo,
    slotKey,
  };
})(window.SNK = window.SNK || {});
