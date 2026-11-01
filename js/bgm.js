// ================================================================
//  bgm.js — 台球厅背景音乐 + 击球音效（纯代码合成）
//
//  为什么不再用 mp3：
//    整个项目要能双击 index.html 离线玩，体积越小越好。音频全部改成
//    Web Audio 实时合成，不再依赖任何音频文件：
//      · BGM：程序化爵士三重奏（钢琴 comping / walking bass / 刷鼓 + 秋千
//        八分音符），8 小节循环，和弦进行随机轮换声部；
//      · 音效：皮头、球球碰撞、撞库、落袋，用噪声 + 带通 + 短包络合成；
//      · 环境：街道低频噪声、室内人声底噪，以及随机出现的远处喇叭、
//        警笛和低声交谈——全部是振荡器 / 滤波噪声。
//
//  参考思路（不是直接引库，项目保持零依赖）：
//    · felixroos/jazzband：Web Audio 实时 comping 的和弦/贝斯分工；
//    · mysimulator.uk "Procedural Music with Web Audio API"：
//      lookahead 时钟 + ADSR + 和弦进行；
//    · collision-synth：短促冲击声 = 噪声瞬态 + 快速指数衰减。
//
//  浏览器自动播放策略：AudioContext 必须在一次真实用户手势里 resume()。
//  对外接口与上一版完全一致，main.js 不用改。
// ================================================================
(function (SNK) {
  'use strict';

  if (!SNK) return;

  // ----------------------------------------------------------------
  //  状态与持久化
  // ----------------------------------------------------------------
  const S = { on: false, vol: 0.7 };
  const listeners = [];

  let ctx = null;
  let master = null, musicBus = null, ambBus = null, sfxBus = null;
  let sfxVerb = null, sfxVerbSend = null, sfxLp = null;
  let ready = false;
  let unlocked = false;
  let ducked = false;

  try {
    const raw = window.localStorage.getItem('snk.audio.v2');
    const old = raw ? null : window.localStorage.getItem('snk.audio');
    const o = JSON.parse(raw || old || 'null');
    if (o) {
      if (typeof o.on === 'boolean') S.on = o.on;
      if (typeof o.vol === 'number') S.vol = Math.min(1, Math.max(0, o.vol));
    }
  } catch (e) { /* 读不到就用默认值 */ }

  function save() {
    try { window.localStorage.setItem('snk.audio.v2', JSON.stringify({ on: S.on, vol: S.vol })); }
    catch (e) { /* 存不了不影响本局 */ }
  }

  function notify() {
    for (let i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) { /* 回调出错不能拖垮音频 */ }
    }
  }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  // ----------------------------------------------------------------
  //  AudioContext / 总线
  // ----------------------------------------------------------------
  const MUSIC_LEVEL = 0.55;
  const AMB_LEVEL = 0.62;
  const SFX_LEVEL = 0.95;

  function ensureCtx() {
    if (ctx) return ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = clamp01(S.vol);
      master.connect(ctx.destination);

      musicBus = ctx.createGain();
      musicBus.gain.value = 0;
      musicBus.connect(master);

      ambBus = ctx.createGain();
      ambBus.gain.value = 0;
      ambBus.connect(master);

      sfxBus = ctx.createGain();
      sfxBus.gain.value = SFX_LEVEL;
      // 音效总线上加一道 6.5kHz 低通：保留咔哒的轮廓，削掉刺耳的"玻璃渣"
      sfxLp = ctx.createBiquadFilter();
      sfxLp.type = 'lowpass';
      sfxLp.frequency.value = 5200;
      sfxLp.Q.value = 0.7;
      sfxBus.connect(sfxLp);
      sfxLp.connect(master);

      // 极短的房间混响：球厅的硬墙会把 clack 拉出一点点尾巴。
      // 冲激响应是代码生成的衰减噪声，没有采样文件。
      if (ctx.createConvolver) {
        const len = Math.floor(ctx.sampleRate * 0.16);
        const buf = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
          const d = buf.getChannelData(ch);
          for (let i = 0; i < len; i++) {
            d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
          }
        }
        sfxVerb = ctx.createConvolver();
        sfxVerb.buffer = buf;
        sfxVerbSend = ctx.createGain();
        sfxVerbSend.gain.value = 0.085;
        sfxLp.connect(sfxVerbSend);
        sfxVerbSend.connect(sfxVerb);
        sfxVerb.connect(master);
      }

      ready = true;
    } catch (e) {
      ctx = null;
      ready = false;
    }
    return ctx;
  }

  function now() { return ctx ? ctx.currentTime : 0; }

  function rampTo(node, v, seconds) {
    if (!ctx || !node) return;
    const t = ctx.currentTime;
    try {
      node.gain.cancelScheduledValues(t);
      node.gain.setTargetAtTime(v, t, Math.max(0.01, seconds / 3));
    } catch (e) { node.gain.value = v; }
  }

  function refreshBusLevels() {
    if (!ctx) return;
    const duck = ducked ? 0.25 : 1;
    rampTo(musicBus, S.on ? MUSIC_LEVEL * duck : 0, 0.35);
    rampTo(ambBus, S.on ? AMB_LEVEL * duck : 0, 0.6);
    master.gain.setTargetAtTime(clamp01(S.vol), ctx.currentTime, 0.05);
  }

  // 共享噪声源：白噪声用于瞬态/人声，棕噪声用于街道底噪
  let whiteBuf = null, brownBuf = null;
  function whiteNoise() {
    if (whiteBuf) return whiteBuf;
    const len = Math.floor(ctx.sampleRate * 2);
    whiteBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = whiteBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return whiteBuf;
  }
  function brownNoise() {
    if (brownBuf) return brownBuf;
    const len = Math.floor(ctx.sampleRate * 4);
    brownBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = brownBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
    return brownBuf;
  }

  function noiseSource(buffer, loop) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = !!loop;
    return src;
  }

  function osc(type, freq, when, stop) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, when);
    o.start(when);
    o.stop(stop);
    return o;
  }

  // ----------------------------------------------------------------
  //  音效合成
  // ----------------------------------------------------------------
  // 带指数阻尼的单个模态。冲击声不是一段噪声，而是一组很快衰减的正弦。
  function mode(freq, when, decay, gain) {
    const o = osc('sine', freq, when, when + decay + 0.03);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.0012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    o.connect(g); g.connect(sfxBus);
    return o;
  }

  function sfxCue(power) {
    const t = now() + 0.001;
    const p = clamp01(power);
    // 皮头打在白球上：1~2ms 的木头冲击，频率低、衰减快。
    // 不要高频噪声——那是"碎玻璃"的来源。
    const src = noiseSource(whiteNoise(), false);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(620 + p * 320, t);
    bp.Q.value = 0.75;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16 + p * 0.28, t + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035 + p * 0.015);
    src.connect(bp); bp.connect(g); g.connect(sfxBus);
    src.start(t); src.stop(t + 0.07);

    // 杆身前段的木头共鸣（整体压低，更闷、更沉）
    mode(150 + p * 38, t, 0.090, 0.12 + p * 0.14);
    mode(290 + p * 60, t, 0.058, 0.055 + p * 0.075);
    // 中频"嗒"给一点木头轮廓；仍远低于碎玻璃的频段
    mode(610 + p * 100, t, 0.026, 0.028 + p * 0.028);
    // 极少量皮头边缘，只给一点瞬态
    mode(1420, t, 0.010, 0.010 + p * 0.007);
  }

  function sfxBall(vol, rate) {
    const t = now() + 0.001;
    const amp = Math.min(1, clamp01(vol));
    const k = Math.max(0.76, Math.min(1.34, rate || 1));
    // 真实碰撞的"咔"主要落在 0.8~2.2kHz，且只有几毫秒。
    // 这里把基频再压低到约 760~880Hz，整体更低沉。
    // 用一组非谐模态 + 一点点带通噪声，避免每帧随机高频造成的玻璃感。
    const f0 = (760 + Math.random() * 120) * k;

    // 接触瞬态：带通噪声，短到几乎只是一个边缘
    const src = noiseSource(whiteNoise(), false);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(f0 * 1.35, t);
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07 + amp * 0.20, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.016 + amp * 0.008);
    src.connect(bp); bp.connect(g); g.connect(sfxBus);
    src.start(t); src.stop(t + 0.05);

    // 酚醛树脂球的模态：基频 + 三个非谐分音，越高越弱、衰减越快。
    const modalGain = 0.16 + amp * 0.58;
    mode(f0, t, 0.060, modalGain);
    mode(f0 * 1.51, t, 0.045, modalGain * 0.42);
    mode(f0 * 2.23, t, 0.032, modalGain * 0.17);
    mode(f0 * 3.02, t, 0.021, modalGain * 0.045);

    // 球体的一点低频重量，让近距离听起来"实"
    mode(255, t, 0.050, 0.035 + amp * 0.065);
  }

  function sfxCushion(vol, rate) {
    const t = now() + 0.001;
    const amp = clamp01(vol);
    // 橡胶库边：低频"咚"，没有高频边缘
    const src = noiseSource(whiteNoise(), false);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(360, t);
    lp.frequency.exponentialRampToValueAtTime(150, t + 0.10);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07 + amp * 0.26, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    src.connect(lp); lp.connect(g); g.connect(sfxBus);
    src.start(t); src.stop(t + 0.18);

    const o = osc('sine', 105 * (rate || 1), t, t + 0.22);
    o.frequency.exponentialRampToValueAtTime(64, t + 0.16);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.07 + amp * 0.14, t + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
    o.connect(og); og.connect(sfxBus);

    // 橡胶的短共鸣，给"库边"一点材质感
    mode(190, t, 0.055, 0.02 + amp * 0.035);
  }

  function sfxPot(vol) {
    const t = now() + 0.001;
    const amp = clamp01(vol);
    // 袋子里的球不是再"咔"一次：先是轻碰袋口，再是软垫上的下坠。
    mode(620, t, 0.032, 0.10 + amp * 0.10);
    mode(940, t, 0.022, 0.04 + amp * 0.05);

    const o = osc('sine', 210, t, t + 0.30);
    o.frequency.exponentialRampToValueAtTime(78, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07 + amp * 0.12, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.27);
    o.connect(g); g.connect(sfxBus);

    const src = noiseSource(whiteNoise(), false);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 260;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t + 0.03);
    ng.gain.linearRampToValueAtTime(0.06 + amp * 0.09, t + 0.06);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    src.connect(lp); lp.connect(ng); ng.connect(sfxBus);
    src.start(t); src.stop(t + 0.32);
  }

  function playSfx(key, vol, rate) {
    if (!ensureCtx() || !S.on || ducked || !unlocked) return;
    if (ctx.state === 'suspended') return;
    try {
      if (key === 'cue') sfxCue(rate === undefined ? vol : vol);
      else if (key === 'ball') sfxBall(vol, rate);
      else if (key === 'cushion') sfxCushion(vol, rate);
      else if (key === 'pot') sfxPot(vol);
    } catch (e) { /* 合成失败不能影响游戏 */ }
  }

  // ----------------------------------------------------------------
  //  BGM：8 小节爵士循环
  //
  //  Cmaj7 | Am7 | Dm7 | G7 | Em7 | A7 | Dm7 | G7
  //  钢琴只弹 3 个音（省 CPU，也更像 comping）；贝斯走四分音符；
  //  鼓组用滤波噪声做 ride / brush，奇数八分音符稍微延后 = swing。
  // ----------------------------------------------------------------
  const MIDI = [48, 45, 50, 43, 40, 45, 50, 43];
  const CHORDS = [
    [52, 55, 59, 62],  // Cmaj7
    [48, 52, 55, 59],  // Am7
    [53, 57, 60, 62],  // Dm7
    [47, 50, 53, 57],  // G7
    [52, 55, 59, 62],  // Em7 (voiced high)
    [49, 52, 55, 59],  // A7
    [53, 57, 60, 62],  // Dm7
    [47, 50, 53, 57],  // G7
  ];
  const BPM = 92;
  const BEAT = 60 / BPM;
  const EIGHTH = BEAT / 2;
  const STEPS = 64;                    // 8 小节 × 8 个八分音符

  let musicStep = 0;
  let nextStepTime = 0;
  let musicTimer = null;

  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  function pianoNote(midi, when, dur, gain) {
    const f = mtof(midi);
    // 两个略微失谐的三角波 + 一个正弦，听起来像电钢琴
    const a = osc('triangle', f, when, when + dur + 0.08);
    const b = osc('triangle', f * 1.0025, when, when + dur + 0.08);
    const c = osc('sine', f * 2, when, when + dur + 0.06);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2600, when);
    lp.frequency.exponentialRampToValueAtTime(900, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    a.connect(lp); b.connect(lp); c.connect(lp);
    lp.connect(g); g.connect(musicBus);
    const cg = ctx.createGain();
    cg.gain.value = 0.35;
    c.connect(cg); cg.connect(g);
  }

  function bassNote(midi, when, dur, gain) {
    const f = mtof(midi);
    const o = osc('sine', f, when, when + dur + 0.05);
    const o2 = osc('triangle', f, when, when + dur + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(musicBus);
  }

  function ride(when, accent) {
    const src = noiseSource(whiteNoise(), false);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(accent ? 0.026 : 0.015, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.055);
    src.connect(hp); hp.connect(g); g.connect(musicBus);
    src.start(when); src.stop(when + 0.08);
  }

  function brush(when) {
    const src = noiseSource(whiteNoise(), false);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.030, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.13);
    src.connect(bp); bp.connect(g); g.connect(musicBus);
    src.start(when); src.stop(when + 0.17);
  }

  function nextChordRoot(bar) {
    return MIDI[(bar + 1) % 8];
  }

  function scheduleStep(step, when) {
    const bar = Math.floor(step / 8);
    const sub = step % 8;
    const chord = CHORDS[bar];
    const root = MIDI[bar];

    // 贝斯：四分音符 walking
    if (sub % 2 === 0) {
      const q = sub / 2;
      let midi;
      if (q === 0) midi = root;
      else if (q === 1) midi = root + 7;
      else if (q === 2) midi = chord[1] - 12;
      else {
        const nr = nextChordRoot(bar);
        midi = Math.abs((root - 1) - nr) <= Math.abs((root + 1) - nr) ? root - 1 : root + 1;
      }
      bassNote(midi, when, BEAT * 0.72, 0.075);
    }

    // 钢琴 comping：第 1 拍和（有时）第 3 拍
    if (sub === 0 || (sub === 4 && Math.random() < 0.7)) {
      const voicing = chord.slice(1, 4);
      for (let i = 0; i < voicing.length; i++) {
        pianoNote(voicing[i], when + i * 0.006, BEAT * (sub === 0 ? 1.5 : 0.9), 0.028);
      }
    }

    // 稀疏旋律：偶尔在高音区补一个和弦音，像 vibraphone
    if ((sub === 5 || sub === 7) && Math.random() < 0.30) {
      const m = chord[(Math.random() * chord.length) | 0] + 12;
      pianoNote(m, when + 0.01, BEAT * 1.1, 0.020);
    }

    // 鼓：ride 每个八分；2、4 拍加 brush
    if (Math.random() < 0.92) ride(when, sub === 0 || sub === 2 || sub === 4 || sub === 6);
    if (sub === 2 || sub === 6) brush(when);
  }

  function musicTick() {
    if (!ctx || !S.on || ducked || ctx.state === 'suspended') return;
    const ahead = ctx.currentTime + 0.28;
    if (!nextStepTime || nextStepTime < ctx.currentTime - 0.4) {
      nextStepTime = ctx.currentTime + 0.08;
    }
    let guard = 0;
    while (nextStepTime < ahead && guard++ < 32) {
      const step = musicStep % STEPS;
      const sub = step % 8;
      // swing：奇数八分音符延后约 1/6 拍
      const when = nextStepTime + (sub % 2 ? BEAT * 0.10 : 0);
      scheduleStep(step, when);
      nextStepTime += EIGHTH;
      musicStep = (musicStep + 1) % STEPS;
    }
  }

  function startMusic() {
    if (!ctx || !S.on || ducked) return;
    if (musicTimer) return;
    nextStepTime = ctx.currentTime + 0.10;
    musicTicker();
  }

  function musicTicker() {
    if (!S.on || ducked) { musicTimer = null; return; }
    musicTick();
    musicTimer = setTimeout(musicTicker, 55);
  }

  function stopMusic() {
    if (musicTimer) { clearTimeout(musicTimer); musicTimer = null; }
  }

  // ----------------------------------------------------------------
  //  环境声：城市低频 + 室内人声底噪 + 随机单次事件
  // ----------------------------------------------------------------
  let ambBuilt = false;
  let ambNodes = null;
  let ambTimer = null;
  let ambDriftTimer = null;

  function buildAmbience() {
    if (ambBuilt || !ctx) return;
    ambBuilt = true;
    const city = noiseSource(brownNoise(), true);
    const cityLp = ctx.createBiquadFilter();
    cityLp.type = 'lowpass';
    cityLp.frequency.value = 300;
    const cityGain = ctx.createGain();
    cityGain.gain.value = 0.10;
    const cityPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    city.connect(cityLp); cityLp.connect(cityGain);
    if (cityPan) { cityPan.pan.value = -0.15; cityGain.connect(cityPan); cityPan.connect(ambBus); }
    else cityGain.connect(ambBus);

    const room = noiseSource(whiteNoise(), true);
    const roomBp = ctx.createBiquadFilter();
    roomBp.type = 'bandpass';
    roomBp.frequency.value = 480;
    roomBp.Q.value = 0.55;
    const roomGain = ctx.createGain();
    roomGain.gain.value = 0.018;
    const roomPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    room.connect(roomBp); roomBp.connect(roomGain);
    if (roomPan) { roomPan.pan.value = 0.12; roomGain.connect(roomPan); roomPan.connect(ambBus); }
    else roomGain.connect(ambBus);

    try { city.start(); room.start(); } catch (e) { /* ignore */ }
    ambNodes = {
      city: city, cityGain: cityGain, cityPan: cityPan,
      room: room, roomGain: roomGain, roomPan: roomPan,
    };
  }

  function driftAmbience() {
    if (!ctx || !ambNodes) return;
    const t = ctx.currentTime;
    if (ambNodes.cityPan) ambNodes.cityPan.pan.linearRampToValueAtTime(-0.35 + Math.random() * 0.7, t + 9);
    if (ambNodes.roomPan) ambNodes.roomPan.pan.linearRampToValueAtTime(-0.25 + Math.random() * 0.5, t + 7);
    // 室内人声像涨潮退潮一样缓慢起伏
    if (ambNodes.roomGain) {
      ambNodes.roomGain.gain.setTargetAtTime(0.012 + Math.random() * 0.020, t, 3.5);
    }
  }

  function startAmbience() {
    if (!ensureCtx() || !S.on) return;
    buildAmbience();
    if (ambDriftTimer) clearInterval(ambDriftTimer);
    ambDriftTimer = setInterval(driftAmbience, 8500);
    driftAmbience();
    if (!ambTimer) scheduleAmbient();
  }

  function stopAmbience() {
    if (ambTimer) { clearTimeout(ambTimer); ambTimer = null; }
    if (ambDriftTimer) { clearInterval(ambDriftTimer); ambDriftTimer = null; }
  }

  function scheduleAmbient() {
    if (ambTimer) clearTimeout(ambTimer);
    ambTimer = setTimeout(function () {
      ambTimer = null;
      if (S.on && !ducked && unlocked) playAmbientOneShot();
      scheduleAmbient();
    }, 22000 + Math.random() * 42000);
  }

  // 单次环境事件：喇叭 / 警笛 / 低声交谈
  function ambientPan() {
    if (!ctx.createStereoPanner) return null;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.random() * 1.6 - 0.8;
    p.connect(ambBus);
    return p;
  }

  function synthHorn(t, dest) {
    const dur = 1.1 + Math.random() * 1.2;
    const base = 210 + Math.random() * 160;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.045, t + 0.08);
    g.gain.setValueAtTime(0.045, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    g.connect(lp); lp.connect(dest);
    for (const k of [1, 1.25, 1.5]) {
      const o = osc('sawtooth', base * k, t, t + dur + 0.05);
      o.frequency.linearRampToValueAtTime(base * k * 0.94, t + dur);
      const og = ctx.createGain();
      og.gain.value = k === 1 ? 0.55 : 0.28;
      o.connect(og); og.connect(g);
    }
  }

  // 单声短促喇叭：square/saw 经低通，像远处车辆
  function carBeep(t, base, dur, pan, vol) {
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = pan; p.connect(ambBus); }
    const out = p || ambBus;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.015);
    g.gain.setValueAtTime(vol, t + Math.max(0.04, dur * 0.65));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g); g.connect(out);
    const o = osc('square', base, t, t + dur + 0.03);
    const o2 = osc('sawtooth', base * 1.5, t, t + dur + 0.03);
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    o.connect(lp); o2.connect(g2); g2.connect(lp);
    // 播完把一次性 panner 从总线摘掉，长时间挂机不会积累节点
    if (p) {
      o.onended = function () {
        try { p.disconnect(); } catch (e) { /* ignore */ }
      };
    }
  }

  // 城市堵车：几辆远处车错开按喇叭，噼噼叭叭
  function synthTraffic(t) {
    const n = 2 + ((Math.random() * 5) | 0);
    for (let i = 0; i < n; i++) {
      const tt = t + Math.random() * 2.8;
      const base = 280 + Math.random() * 420;
      carBeep(tt, base, 0.10 + Math.random() * 0.22,
        Math.random() * 1.6 - 0.8, 0.010 + Math.random() * 0.018);
    }
  }

  // 近距离双音短喇叭
  function synthHornShort(t, dest) {
    carBeep(t, 360 + Math.random() * 90, 0.16, (Math.random() * 1.2 - 0.6), 0.030);
    carBeep(t + 0.22, 420 + Math.random() * 100, 0.20, (Math.random() * 1.2 - 0.6), 0.026);
  }

  // 卡车低音气喇叭
  function synthAirHorn(t, dest) {
    const dur = 1.2 + Math.random() * 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.045, t + 0.08);
    g.gain.setValueAtTime(0.045, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900;
    g.connect(lp); lp.connect(dest);
    for (const f of [170, 226, 285]) {
      const o = osc('sawtooth', f, t, t + dur + 0.05);
      o.frequency.linearRampToValueAtTime(f * 0.965, t + dur);
      const og = ctx.createGain();
      og.gain.value = 0.35;
      o.connect(og); og.connect(g);
    }
  }

  function synthSiren(t, dest) {
    const dur = 3.2 + Math.random() * 1.5;
    const o = osc('sine', 620, t, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.022, t + 0.25);
    g.gain.setValueAtTime(0.022, t + dur - 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const cycles = 2;
    for (let i = 0; i < cycles; i++) {
      const t0 = t + i * dur / cycles;
      o.frequency.setValueAtTime(600, t0);
      o.frequency.linearRampToValueAtTime(1250, t0 + dur / cycles * 0.45);
      o.frequency.linearRampToValueAtTime(600, t0 + dur / cycles * 0.9);
    }
    o.connect(g); g.connect(dest);
  }

  function synthMurmur(t, dest) {
    const dur = 2.0 + Math.random() * 2.2;
    const pan = Math.random() * 1.2 - 0.6;
    if (dest && dest.pan) dest.pan.setValueAtTime(pan, t);

    // 3 个共振峰叠在一起，像隔着一堵墙的人声
    const src = noiseSource(whiteNoise(), false);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.connect(dest);
    const formants = [520, 1180, 2400];
    for (let i = 0; i < formants.length; i++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = formants[i] * (0.9 + Math.random() * 0.2);
      bp.Q.value = 4 + i * 2;
      const fg = ctx.createGain();
      fg.gain.value = [0.30, 0.18, 0.09][i];
      src.connect(bp); bp.connect(fg); fg.connect(g);
    }

    // 音节包络：每秒 3~5 个短促起伏
    const syllables = Math.max(4, Math.floor(dur * (3 + Math.random() * 2)));
    for (let i = 0; i < syllables; i++) {
      const tt = t + (i / syllables) * dur;
      const peak = i === 0 ? 0.06 : 0.02 + Math.random() * 0.035;
      g.gain.setValueAtTime(0.008, tt);
      g.gain.linearRampToValueAtTime(peak, tt + 0.035);
      g.gain.exponentialRampToValueAtTime(0.006, tt + Math.min(0.18, dur / syllables * 0.8));
    }
    g.gain.setValueAtTime(0.0001, t + dur);
    src.start(t); src.stop(t + dur + 0.05);
  }

  function playAmbientOneShot() {
    if (!ensureCtx() || !S.on || ducked || !unlocked) return;
    if (!ambBuilt) buildAmbience();
    const t = ctx.currentTime + 0.05;
    const dest = ambientPan() || ambBus;
    const r = Math.random();
    try {
      if (r < 0.12) synthHorn(t, dest);           // 远处长喇叭
      else if (r < 0.38) synthTraffic(t);         // 堵车：噼噼叭叭
      else if (r < 0.48) synthHornShort(t, dest); // 近距离双音
      else if (r < 0.56) synthAirHorn(t, dest);   // 卡车气喇叭
      else if (r < 0.68) synthSiren(t, dest);     // 警笛
      else synthMurmur(t, dest);                  // 低声交谈
      if (dest && dest !== ambBus) {
        setTimeout(function () {
          try { dest.disconnect(); } catch (e) { /* ignore */ }
        }, 9000);
      }
    } catch (e) { /* ignore */ }
  }

  // ----------------------------------------------------------------
  //  撞球"感知合批"：保留上一版参数
  // ----------------------------------------------------------------
  const HIT_WINDOW_MS = 55;
  const HIT_MAX_WINDOW = 175;
  const HIT_COOLDOWN = 95;
  let pendingHits = [];
  let hitTimer = null;
  let hitBatchStart = 0;
  let lastHitFlush = 0;
  let pendingCushion = 0;
  let cushionTimer = null;

  function clearImpactQueue() {
    pendingHits = [];
    if (hitTimer) { clearTimeout(hitTimer); hitTimer = null; }
    hitBatchStart = 0;
    lastHitFlush = 0;
    pendingCushion = 0;
    if (cushionTimer) { clearTimeout(cushionTimer); cushionTimer = null; }
  }

  function queueHits(hits) {
    if (!hits || !hits.length) return;
    for (let i = 0; i < hits.length; i++) {
      if (hits[i].v > 0.35) pendingHits.push(hits[i].v);
    }
    if (!pendingHits.length) return;

    const nw = performance.now();
    if (!hitTimer) hitBatchStart = nw;
    else clearTimeout(hitTimer);

    const since = nw - hitBatchStart;
    const quiet = Math.max(0, HIT_WINDOW_MS - 0);
    const room = Math.max(0, HIT_MAX_WINDOW - since);
    const gap = Math.max(0, HIT_COOLDOWN - (nw - lastHitFlush));
    hitTimer = setTimeout(flushHits, Math.max(18, Math.min(quiet, room), gap));
  }

  function flushHits() {
    hitTimer = null;
    lastHitFlush = performance.now();
    const batch = pendingHits;
    pendingHits = [];
    if (!batch.length || !S.on || ducked || !unlocked) return;

    let maxV = 0, energy = 0;
    for (let i = 0; i < batch.length; i++) {
      const v = batch[i];
      if (v > maxV) maxV = v;
      energy += v * v;
    }
    const n = batch.length;
    const eq = Math.sqrt(energy);
    const amp = Math.min(0.92, 0.10 + eq / 30 + Math.log2(n + 1) * 0.04);
    const rate = Math.min(1.30, 0.74 + maxV / 60);
    playSfx('ball', amp, rate);

    if (n >= 5) {
      setTimeout(function () {
        if (S.on && !ducked && unlocked) playSfx('ball', Math.min(0.42, amp * 0.42), 0.62);
      }, 18);
    }
  }

  function queueCushion(v) {
    if (!(v > 1.2)) return;
    if (v > pendingCushion) pendingCushion = v;
    if (cushionTimer) return;
    const gap = Math.max(0, 90 - (performance.now() - lastHitFlush));
    cushionTimer = setTimeout(function () {
      cushionTimer = null;
      const vv = pendingCushion;
      pendingCushion = 0;
      if (!S.on || ducked || !unlocked) return;
      playSfx('cushion', Math.min(0.42, 0.08 + vv / 45), 0.60);
    }, 70 + gap);
  }

  // ----------------------------------------------------------------
  //  生命周期
  // ----------------------------------------------------------------
  function init() {
    return ensureCtx() !== null;
  }

  function resume() {
    if (!ensureCtx()) return;
    const finish = function () {
      unlocked = true;
      if (S.on) { startMusic(); startAmbience(); }
      refreshBusLevels();
      notify();
    };
    if (ctx.state === 'running') {
      finish();
      return;
    }
    try {
      const p = ctx.resume();
      if (p && p.then) p.then(finish).catch(function () { unlocked = false; });
      else finish();
    } catch (e) {
      unlocked = false;
    }
  }

  function stopAll() {
    stopMusic();
    stopAmbience();
    clearImpactQueue();
    refreshBusLevels();
  }

  // ----------------------------------------------------------------
  //  对外接口（与旧版同名）
  // ----------------------------------------------------------------
  SNK.bgm = {
    init: init,
    resume: resume,
    enabled: function () { return S.on; },
    unlocked: function () { return unlocked; },
    audible: function () {
      if (!ready || !S.on || ducked || !unlocked || !ctx) return false;
      return ctx.state === 'running';
    },
    ambientActive: function () { return !!(S.on && ambBuilt && !ducked); },
    setEnabled: function (on) {
      S.on = !!on;
      save();
      if (S.on) { ensureCtx(); resume(); } else { stopAll(); }
      notify();
    },
    volume: function () { return S.vol; },
    setVolume: function (v) {
      S.vol = clamp01(Number(v) || 0);
      save();
      refreshBusLevels();
      notify();
    },
    duck: function (on) {
      ducked = !!on;
      if (ducked) clearImpactQueue();
      refreshBusLevels();
      if (!ducked && S.on && unlocked) {
        startMusic();
        startAmbience();
      }
    },
    onchange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    credits: function () {
      return [{ title: 'Procedural lounge trio', artist: 'Generated in code' }];
    },

    cueHit: function (power) {
      init();
      const p = Math.min(1, Math.max(0, (Number(power) || 0) / (SNK.MAX_POWER || 36)));
      playSfx('cue', 0.30 + p * 0.50, 0.95 + p * 0.10);
    },

    // 调试入口：立即触发一次环境单次声，用来检查喇叭/警笛合成
    _ambientTest: function () { playAmbientOneShot(); },

    shot: function (ev) {
      init();
      if (!ev || !S.on || ducked) return;

      queueHits(ev.hits);

      const cs = ev.cushions;
      if (cs && cs.length) {
        let best = cs[0];
        for (let i = 1; i < cs.length; i++) if (cs[i].v > best.v) best = cs[i];
        queueCushion(best.v);
      }

      const potted = ev.potted;
      if (potted && potted.length) {
        for (let i = 0; i < potted.length; i++) playSfx('pot', 0.72, 1);
      }
    },
  };
})(window.SNK);
