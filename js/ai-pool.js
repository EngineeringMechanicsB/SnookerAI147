// ================================================================
//  ai-pool.js — AI 搜索的 Web Worker 线程池
//
//  为什么不用「主线程算」：
//    Master 147 一杆要跑 1000+ 杆模拟，单线程会把 UI 卡住一秒；
//    而且现在多数机器都有 8~32 个逻辑核，只用一个核是浪费。
//
//  做法：
//    · worker 用 Blob 创建（file:// 下 `new Worker('js/xxx.js')` 会被浏览器
//      拦，但 Blob worker 允许）；worker 内部用 importScripts 加载
//      constants / physics / rules / sim / ai —— 和主线程是**同一份源码**，
//      所以物理/AI 不会出现两套实现。
//    · 把根层候选按 oi % total 切片，每个 worker 只算自己那一份；
//      深层递归本来就是每个根候选独立子树，不会重复。
//    · 主线程合并各 worker 的 best/top，再做稳健性复排和安全球兜底。
//    · 任何一步失败（旧浏览器、file:// 限制、worker 报错）都自动退回
//      原来的同步 decide()，不影响可玩性。
// ================================================================
(function (SNK) {
  'use strict';

  if (!SNK || typeof Worker === 'undefined') return;

  const C = SNK;
  const MAX_WORKERS = 8;

  let workers = [];
  let failed = false;
  let nextId = 1;
  const pending = new Map();

  function workerCount() {
    // 调试/调优入口：window.__AI_POOL_WORKERS = 1 可强制单 worker 对照
    if (typeof window !== 'undefined' && window.__AI_POOL_WORKERS) {
      return Math.max(1, Math.min(MAX_WORKERS, window.__AI_POOL_WORKERS | 0));
    }
    const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    // 留一个核给主线程/渲染；上限 8，避免小机器上开太多
    return Math.max(1, Math.min(MAX_WORKERS, hc - 1));
  }

  // 必须在脚本**执行时**取当前 script 的 URL。buildPool 是懒加载的，
  // 等到第一次 AI 决策时 document.currentScript 已经是 null，只能拿到
  // index.html，拼出来的 worker 路径会少一个 js/。
  const SCRIPT_BASE = (function () {
    const s = document.currentScript;
    return new URL('./', (s && s.src) || location.href).href;
  })();

  function scriptBase() { return SCRIPT_BASE; }

  function buildPool() {
    if (workers.length || failed) return;
    try {
      const base = scriptBase();
      const files = ['constants.js', 'cueclear.js', 'physics.js', 'rules.js', 'sim.js', 'ai.js'];
      const urls = files.map(f => new URL(f, base).href);
      const src = [
        'self.window = self;',
        'importScripts(' + urls.map(u => JSON.stringify(u)).join(',') + ');',
        'self.onmessage = function (e) {',
        '  var d = e.data, id = d.id;',
        '  try {',
        '    var out = SNK.ai.searchSlice(d.state, d.balls, d.level, d.budgetMs, d.index, d.total, d.mode);',
        '    self.postMessage({ id: id, ok: true, out: out });',
        '  } catch (err) {',
        '    self.postMessage({ id: id, ok: false, err: String((err && err.stack) || err) });',
        '  }',
        '};',
      ].join('\n');
      const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const n = workerCount();
      for (let i = 0; i < n; i++) {
        const w = new Worker(blobUrl);
        w.onmessage = function (e) {
          const m = e.data;
          const p = pending.get(m.id);
          if (!p) return;
          clearTimeout(p.timer);
          pending.delete(m.id);
          if (m.ok) p.resolve(m.out);
          else p.reject(new Error(m.err || 'worker error'));
        };
        w.onerror = function (e) {
          // 一个 worker 挂了就整体退回同步路径，别让每个请求都等超时
          for (const [id, p] of pending) {
            if (p.worker === w) {
              clearTimeout(p.timer);
              pending.delete(id);
              p.reject(new Error(String(e.message || 'worker failed')));
            }
          }
          failed = true;
        };
        workers.push(w);
      }
    } catch (e) {
      failed = true;
      workers = [];
    }
  }

  function request(worker, payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const id = nextId++;
      const timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error('worker timeout'));
      }, timeoutMs);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer, worker: worker });
      worker.postMessage(Object.assign({ id: id }, payload));
    });
  }

  function toPlainBalls(balls) {
    const out = new Array(balls.length);
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      out[i] = {
        x: b.x, y: b.y, label: b.label,
        vx: b.vx, vy: b.vy, wx: b.wx, wy: b.wy, wz: b.wz,
        sx: b.sx, sy: b.sy, active: b.active, potted: b.potted,
      };
    }
    return out;
  }

  function runRound(state, ballData, level, budgetMs, mode, select) {
    select = select || 'packed';
    buildPool();
    if (failed || !workers.length) throw new Error('pool unavailable');
    const jobs = workers.map(function (w, i) {
      return request(w, {
        state: state, balls: ballData, level: level,
        budgetMs: budgetMs, index: i, total: workers.length, mode: mode,
      }, budgetMs + 1800).catch(function () { return null; });
    });
    return Promise.all(jobs).then(function (arr) {
      return arr.filter(Boolean).map(function (p) { return p[select]; }).filter(Boolean);
    });
  }

  function entryKey(e) {
    const s = e.entry && e.entry.shot;
    return s ? [s.angle.toFixed(6), s.power.toFixed(4), s.spinX.toFixed(4), s.spinY.toFixed(4)].join('|') : '';
  }

  function mergeParts(parts) {
    const seen = new Set();
    const all = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const list = (p.top || []).slice();
      if (p.best) list.push(p.best);
      for (let j = 0; j < list.length; j++) {
        const e = list[j];
        if (!e) continue;
        const k = entryKey(e);
        if (seen.has(k)) continue;
        seen.add(k);
        all.push(e);
      }
    }
    all.sort(function (a, b) { return b.value - a.value; });
    return all;
  }

  function chooseFromTop(state, balls, top, prof, force) {
    if (!top.length) return null;
    let pick = null;
    if (!force && (prof.noise || prof.powerErr)) {
      try { pick = C.ai.rerankRobust(state, balls, top, prof); } catch (e) { pick = null; }
    }
    const entry = pick && pick.entry ? pick.entry : top[0];
    if (!entry || !entry.entry || entry.entry.verdict.points <= 0) return null;
    return C.ai.decisionFromBest(entry, prof, force);
  }

  function decideAsync(state, balls, opts) {
    opts = opts || {};
    // 8-ball 用独立的轻量决策，暂时不走斯诺克搜索线程池
    if (state && (state.mode === 'eightball' || state.mode === 'nineball')) {
      return Promise.resolve(C.ai.decide(state, balls, opts));
    }
    // 开球是一次性、廉价的专用搜索，直接在主线程做；不需要动线程池
    if (state && state.opening) {
      const br = C.ai.breakOff(state, balls);
      if (br) return Promise.resolve(br);
    }
    const level = opts.level;
    const prof = C.ai.PROFILES[level];
    if (failed || !prof || prof.style !== 'strong' || typeof Worker === 'undefined') {
      return Promise.resolve(C.ai.decide(state, balls, opts));
    }

    const budget = (opts.budgetMs === undefined || opts.budgetMs === null)
      ? (prof.budget || 800) : opts.budgetMs;
    const ballData = toPlainBalls(balls);
    const force = !!(state.forcePot || (state.noPotStreak || 0) >= 3);

    // 连续不进：交给单个 worker 跑完整的强制进球搜索（直达/加塞/翻袋/组合球）。
    // 不切片：这是一次性的穷举，切碎后每个 worker 都只看到一部分线路。
    function runForce() {
      buildPool();
      if (failed || !workers.length) throw new Error('pool unavailable');
      return request(workers[0], {
        state: state, balls: ballData, level: level,
        budgetMs: Math.max(700, budget * 0.9), index: 0, total: 1, mode: 'force',
      }, budget + 4200).then(function (out) {
        return out.forced || null;
      });
    }

    function runSafety() {
      // 安全球不做切片：它的耗时主要来自"找到完美斯诺克后立刻停"。
      // 切成 8 份后每个 worker 都看不到完整组合表，反而各自跑满预算，
      // 实测比单线程还慢。这里只放到 1 个 worker 里，至少不卡主线程。
      buildPool();
      if (failed || !workers.length) throw new Error('pool unavailable');
      return request(workers[0], {
        state: state, balls: ballData, level: level,
        budgetMs: budget, index: 0, total: 1, mode: 'safety',
      }, budget * 1.4 + 1800).then(function (out) {
        const d = C.ai.safetyDecisionFromParts(out.safety ? [out.safety] : [], prof)
          || C.ai.fallbackOnly(state, ballData, level);
        return C.ai.maybeFlair(d, state, balls, level);
      });
    }

    // 同一份预算切给 N 个 worker：每个 worker 的 deadline 只负责自己那一片，
    // 墙钟时间大约降到 1/N；总 CPU 工作量不变，但不再卡主线程。
    return runRound(state, ballData, level, budget, 'normal').then(function (parts) {
      const top = mergeParts(parts);
      const decision = chooseFromTop(state, balls, top, prof, force);

      // 连续不进：先穷举所有进球线路（含翻袋/组合球），没有才退回防守
      if (force) {
        return (decision ? Promise.resolve(decision) : runForce())
          .then(function (d) { return d || runSafety(); });
      }

      // 常规搜索没捞到球：和同步路径一样，再跑两轮"广撒网"
      if (!decision && (prof.desperate || prof.deepSearch)) {
        return runRound(state, ballData, level,
          Math.max(150, budget * 0.45), 'wide1').then(function (w1) {
          const d1 = chooseFromTop(state, balls, mergeParts(w1), prof);
          if (d1) return d1;
          return runRound(state, ballData, level,
            Math.max(120, budget * 0.35), 'wide2').then(function (w2) {
            return chooseFromTop(state, balls, mergeParts(w2), prof);
          });
        }).then(function (d) {
          return d || runSafety();
        });
      }

      return decision || runSafety();
    }).catch(function () {
      // worker 出问题：完全退回原来的单线程路径
      failed = true;
      return C.ai.decide(state, balls, opts);
    });
  }

  function cancel() {
    for (let i = 0; i < workers.length; i++) {
      try { workers[i].terminate(); } catch (e) { /* ignore */ }
    }
    workers = [];
    for (const [, p] of pending) clearTimeout(p.timer);
    pending.clear();
  }

  C.aiPool = {
    decide: decideAsync,
    size: function () { return workers.length; },
    available: function () { return !failed && typeof Worker !== 'undefined'; },
    cancel: cancel,
  };
})(window.SNK = window.SNK || {});
