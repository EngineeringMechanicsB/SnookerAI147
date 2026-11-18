// ================================================================
//  celebration.js — 胜利庆祝
//
//  不使用图片/音频文件：
//    · 彩纸由 Canvas 2D 实时绘制（重力、阻尼、旋转、飘落）；
//    · 欢呼/喇叭声由 bgm.js 的 Web Audio 合成。
//  只在人类赢下高分局时触发，避免每局都刷屏。
// ================================================================
(function (SNK) {
  'use strict';

  let canvas = null, ctx = null;
  let raf = 0, until = 0;
  let pieces = [];

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'celebrationCanvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.position = 'fixed';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '45';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
  }

  function resize() {
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function makePiece(w, h, palette) {
    return {
      x: w * (0.35 + Math.random() * 0.30) + (Math.random() - 0.5) * w * 0.25,
      y: h * (0.25 + Math.random() * 0.18),
      vx: (Math.random() - 0.5) * 520,
      vy: -180 - Math.random() * 520,
      g: 620 + Math.random() * 360,
      drag: 0.985,
      w: 5 + Math.random() * 7,
      h: 3 + Math.random() * 5,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 14,
      color: palette[(Math.random() * palette.length) | 0],
      sway: Math.random() * Math.PI * 2,
      swayAmp: 6 + Math.random() * 12,
    };
  }

  function tick(now) {
    if (!canvas) return;
    const w = window.innerWidth, h = window.innerHeight;
    const dt = Math.min(0.05, (now - (tick.last || now)) / 1000);
    tick.last = now;
    ctx.clearRect(0, 0, w, h);

    let alive = 0;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (p.y > h + 80) continue;
      alive++;
      p.vy += p.g * dt;
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.x += p.vx * dt + Math.sin(p.sway) * p.swayAmp * dt;
      p.y += p.vy * dt;
      p.sway += dt * 2.2;
      p.rot += p.vr * dt;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }

    if (alive && now < until) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = 0;
      ctx.clearRect(0, 0, w, h);
      tick.last = 0;
    }
  }

  function play(kind) {
    ensureCanvas();
    resize();
    const max = kind === 'maximum';
    const palette = max
      ? ['#ff4757', '#ffd93d', '#2ed573', '#4dabf7', '#ff6b9d', '#f5f5f5']
      : ['#ff4757', '#ffd93d', '#2ed573', '#4dabf7'];
    const count = max ? 260 : 150;
    const w = window.innerWidth, h = window.innerHeight;
    pieces = [];
    for (let i = 0; i < count; i++) pieces.push(makePiece(w, h, palette));
    until = performance.now() + (max ? 4200 : 2800);
    if (!raf) { tick.last = 0; raf = requestAnimationFrame(tick); }
    if (SNK.bgm && SNK.bgm.celebrate) SNK.bgm.celebrate(kind);
  }

  window.addEventListener('resize', function () {
    if (canvas) resize();
  });

  SNK.celebration = {
    play: play,
    _pieces: function () { return pieces.length; },
  };
})(window.SNK = window.SNK || {});
