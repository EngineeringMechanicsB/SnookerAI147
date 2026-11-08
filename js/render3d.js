// ================================================================
//  render3d.js — 俯视正交 3D 渲染（three.js）
//
//  为什么是"俯视正交"而不是透视：
//    · 透视相机会让鼠标坐标 → 台面坐标的映射变成非线性，瞄准会飘；
//    · 正交 + 正上方俯视时，屏幕坐标 = 台面坐标（只差一个平移），
//      主循环里那套 cpos() 一个字都不用改。
//  3D 感来自：球体的真实光照与高光、方向光投下的真实阴影、
//            台呢的织纹、库边/木框的高度差。不做透视，视野更直观。
//
//  台面坐标 → three 坐标：  X = x - W/2,  Z = y - H/2,  Y = 高度
// ================================================================
(function (SNK) {
  'use strict';

  if (typeof THREE === 'undefined') {
    // 没加载到 three.js（比如 vendor 目录丢了）→ 优雅退化回 2D
    SNK.render3d = {
      available: function () { return false; },
      on: false,
      render: function () {},
      // 观战 API 在无 3D 时全部是空操作，主循环可以无脑调用
      setSpectate: function () {},
      spectating: function () { return false; },
      setOrbit: function () {},
      orbitActive: function () { return false; },
      orbitDrag: function () {}, orbitPan: function () {}, orbitZoom: function () {},
      orbitReset: function () {}, orbitNudge: function () {},
      pickTable: function () { return null; },
      notifyActivity: function () {}, resetView: function () {},
      setAmbience: function () {}, ambience: function () { return 'match'; },
      onAmbience: function () {},
    };
    return;
  }

  // ---- 颜色管理（three r149 的写法）----
  // 旧代码只设了 renderer.outputEncoding = sRGBEncoding，但没有开色彩管理：
  // 材质里的 0x08401f 被当成**线性值**，输出时再做一次 sRGB 编码，
  // 于是台呢从深墨绿被抬成中等草绿 —— 这正是"3D 桌布颜色很奇怪"的根因。
  // 开启后 setHex/setStyle 会把 sRGB 输入转进线性工作空间，再经 outputEncoding
  // 转回 sRGB，屏幕颜色与色号一致。所有颜色必须在这行之后创建。
  if (THREE.ColorManagement) THREE.ColorManagement.legacyMode = false;

  const C = SNK;
  const W = C.W, H = C.H;
  const BALL_R = C.BALL_R;
  const CUSHION_H = 14;        // 库边鼻高（约 37mm，真实值）
  const RAIL_W = 12;           // 木框宽度（我们 28px 的库边带里，外侧 12px 是木头）

  let renderer = null, scene = null;
  // 两台相机、两套用途，永远只渲染其中一台：
  //   camOrtho  —— 正上方俯视正交。**手打时唯一使用的相机**：屏幕坐标 == 台面坐标，
  //                cpos() 和所有瞄准换算都建立在它上面，所以它的参数一个字都不能动。
  //   camPersp  —— 观战用的透视相机，由手写轨道控制。
  // 分成两台（而不是一台插值）的意义：透视相机在结构上不可能泄漏到手动模式里。
  let camOrtho = null, camPersp = null;
  let ready = false;

  // ---------- 观战镜头状态机 ----------
  // 只有两个机位，但**什么时候用哪个**是有讲究的：
  //   ortho —— 正上方俯视（正交机）。观战一开始就是这个，每一局重开也回到这里。
  //   persp —— 透视机（斜视）。用户自己拖出来，或者观战闲置够久后自动巡游飞过去。
  // ⚠ 手打时**永远**是 ortho：屏幕坐标 == 台面坐标是 cpos() 和全部瞄准换算的地基。
  //   透视机只有在 spectating 且用户/巡游要它时才顶上。
  let spectating = false;               // 是否处于观战（两边都是 AI）
  let manualOrbit = false;              // 人类主动进入的轨道视角（第九轮）
  let perspCam = false;                 // 这一帧用不用透视机
  let cineOn = false;                   // 自动巡游中（缓慢自转 + 偶尔跟球）
  let cineFollow = false, cineFollowT = 6;
  let orbDamp = 0.0015;                 // 相机阻尼底数；飞入时临时放慢（见 updateOrb）
  let idleSince = 0;                    // 最近一次用户操作的时刻
  const CINE_IDLE_MS = 60000;           // 观战时闲置多久自动切侧视巡游（1 分钟）
  const perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // 三盏吊灯里"看得见的那部分"（吊绳/灯罩/发光面片）各自的 Group。
  // 俯视图下整组隐藏：灯罩罩在台面上方 620px，正交投影上去就是三个大圆，
  // 糊在台呢正中，瞄准都看不清。观战（透视）时再放出来。
  // 灯的 SpotLight 不在这里面 —— 它挂在外层 Group 上，见 buildLamp 的注释。
  const lampVis = [];
  let lampVisOn = true;                 // 当前可见状态，只在变化时改（每帧赋值也行，但不必要）

  // ---------- 环境动态元素（第十三轮）----------
  // 这三组东西只做"活气"：吊灯轻摆、暖光微闪、空气里的灰尘。
  // 全部是振幅极小的低频运动，不会干扰瞄准和物理。
  const lampSway = [];                  // { g, phase } 吊灯外层 Group
  const lampBase = [];                  // 三盏吊灯的基准强度（氛围预设写入）
  const flickerLights = [];             // { light, base, phase, amp } 酒吧灯 / 壁灯
  let neonSign = null, neonLight = null, neonBase = 0.22;
  let dust = null, dustData = null;
  let clockFace = null;                 // 会走的挂钟：canvas + texture + 上次秒数
  const ceilingVis = [];                // 天花横梁：俯视正交下会压在台面上，必须藏

  // ---------- 生活细节（第十四轮）----------
  // 只加"低频、极小幅度"的东西：植物叶片摆动、蜡烛火苗/青烟、偶尔飞过的苍蝇。
  // 它们全部收进 ceilingVis 的父组：俯视正交时隐藏，避免干扰瞄准。
  const plantBlades = [];               // { m, baseX, baseZ, phase, amp }
  const candleFlames = [];              // { m, baseY, phase }
  const smokePuffs = [];                // { s, baseX, baseY, baseZ, phase, dur, drift }
  let flyRoot = null, flyGroup = null, flyWings = [];
  let dZone = null;                     // 开球摆球时高亮的 D 区

  // ---------- 球桌细节：包金、袋口铜圈、回球轨道 ----------
  let returnRoot = null;
  let returnTrayX = 0;
  let returnGeom = null;               // 轨道/斜槽/动画共用的一套几何参数
  const returnBalls = [];               // 回球动画用的小球池
  const returnAnims = [];
  const potSeen = [];                   // 每颗球是否已经触发过回球动画
  const lastOn = [];                    // 每颗球最后一次在台上的位置

  // ---------- 轨道相机状态 ----------
  // 球坐标：az 绕 Y 轴方位角、pol 极角（0 = 正上方）、dist 距离。
  // cur 是**实际**值、tgt 是**目标**值，每帧按帧率无关的阻尼逼近（见 render）。
  const ORB_LIMIT = { polMin: 0.10, polMax: 1.35, distMin: 900, distMax: 3400 };
  // 默认轨道机位偏"坐在吧台边看球桌"：极角大一点（相机压低），
  // 画面里才带得到墙面、吊灯和吧台；原来的 0.62 几乎只能俯看台面。
  const ORB_DEFAULTS = { az: -1.18, pol: 1.22, dist: 2350, tx: 0, ty: 0, tz: 0 };
  const orb = {
    cur: Object.assign({}, ORB_DEFAULTS),
    tgt: Object.assign({}, ORB_DEFAULTS),
  };
  let lastFrame = 0;                    // 上一帧的时刻，用来算与帧率无关的 dt

  // ---------- 击球者第一视角（偶尔插入，平滑混合） ----------
  // 从当前透视机平滑飞到白球后方、约 170px 高、贴着球杆看出去；
  // 球动起来后镜头跟着球，结束后再平滑退回原来的轨道机位。
  let camShot = null, camBlend = null;
  let lastViewState = '';
  const shotCam = {
    active: false, w: 0, target: 0,
    startedAt: 0, stopAt: 0, stopping: false, lastAt: -1e9,
    followIdx: -1, switched: false,
    dirX: 1, dirZ: 0,
    pos: new THREE.Vector3(),
    look: new THREE.Vector3(),
  };

  // 与帧率无关的帧间隔。掉帧时 dt 变大，阻尼 k 自动变大 —— 手感不随 FPS 变。
  function frameDt() {
    const now = perfNow();
    let dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (!(dt > 0)) dt = 1 / 60;
    return Math.min(dt, 0.1);
  }

  // ---------- 可复用对象 ----------
  const ballMesh = [];         // 按索引复用，球数变化时重建
  const matCache = {};
  // 球滚动：把物理层 wx/wy/wz 转成世界空间四元数增量
  const ballSpinQ = new THREE.Quaternion();
  const ballSpinAxis = new THREE.Vector3();
  let cueGroup = null, cueTilt = null, cueMesh = null, cueTip = null, cueRest = null;
  let ghostMesh = null, cuePulse = null, spinDot = null;
  const ringPool = [];         // "当前目标球"底下的光环

  // 轨迹条带（每次内容变化才重建几何体）
  const aimSlot = { mesh: null }, targetSlot = { mesh: null };
  const guideSlots = [];                 // 辅助线模式 3：其余会动的球（按球数复用）
  let aimKey = '', targetKey = '';
  const trailRibbons = [];
  let trailKey = '';

  // ================================================================
  //  小工具
  // ================================================================
  function meshMat(color, rough, metal) {
    const key = color + '|' + rough + '|' + (metal || 0);
    if (!matCache[key]) {
      matCache[key] = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: rough === undefined ? 0.5 : rough,
        metalness: metal || 0,
      });
    }
    return matCache[key];
  }

  // 8-ball 球面贴图：白底/彩底 + 花色带 + 号码
  const poolMatCache = {};
  function poolBallMat(label) {
    if (poolMatCache[label]) return poolMatCache[label];
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 256;
    const g = cv.getContext('2d');
    const color = C.COL[label] || '#cccccc';
    const stripe = C.isStriped ? C.isStriped(label) : (label.charAt(0) === 't');
    g.fillStyle = stripe ? '#f2f2f2' : color;
    g.fillRect(0, 0, 512, 256);
    if (stripe) {
      g.fillStyle = color;
      g.fillRect(0, 74, 512, 108);
    }
    // 号码白圈（画在两面，球旋转时更容易看到）
    for (const cx of [128, 384]) {
      g.fillStyle = '#f7f7f2';
      g.beginPath(); g.arc(cx, 128, 48, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#141414';
      g.font = 'bold 46px sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(C.COL_CN[label] || ''), cx, 130);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    poolMatCache[label] = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.16, metalness: 0.04,
    });
    return poolMatCache[label];
  }

  // 台呢织纹：一张小噪声贴图重复铺开，近看有颗粒感
  function clothTexture() {
    const s = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, s, s);
    const img = g.getImageData(0, 0, s, s);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = 235 + Math.random() * 20;
      img.data[i] = n; img.data[i + 1] = n; img.data[i + 2] = n;
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(60, 32);
    // 画布里的像素是 sRGB 色值；不声明的话会被当成线性值二次提亮。
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  // 木框纹理
  // 木纹贴图。repX/repY 是 repeat 倍数 —— **两种几何要两套值**：
  //   BoxGeometry / LatheGeometry 的 UV 是归一化的 0~1，用默认的 (4,2) 刚好；
  //   ExtrudeGeometry（圆角台身、圆角木框圈）的默认 UV 是**世界坐标原值**
  //   （顶底盖用形状的 x,y，侧面用 x,z），范围 ±708 —— 再乘 4 就等于每个像素
  //   换一次纹理，糊成纯色。所以那两处传 (1/300, 1/300)，一档 300px。
  function woodTexture(repX, repY) {
    const s = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.fillStyle = '#a87548';      // 木纹底色。它和材质 color 是**相乘**关系，
                                  // 底色压太暗（原来 #6b4428）再乘一次深棕就糊成黑块
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 70; i++) {
      g.strokeStyle = 'rgba(0,0,0,' + (0.03 + Math.random() * 0.06) + ')';
      g.lineWidth = 1 + Math.random() * 2.5;
      g.beginPath();
      const yy = Math.random() * s;
      g.moveTo(0, yy);
      for (let x = 0; x <= s; x += 16) g.lineTo(x, yy + Math.sin((x + i * 31) * 0.02) * 4);
      g.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repX === undefined ? 4 : repX, repY === undefined ? 2 : repY);
    tex.encoding = THREE.sRGBEncoding;   // 同上：木纹是 sRGB 色值，不是线性数据
    return tex;
  }

  // ----------------------------------------------------------------
  //  圆角台身 / 圆角木框圈
  //
  //  2D 那张台面（render.js 的 drawTable）画满整个画布，画布自己有 CSS 圆角，
  //  所以桌角看起来是圆的；3D 里台子是房间里的一个盒子，四个直角全部露在外面 ——
  //  这就是"2D 有圆角、3D 没有"的来源。修法不是在 CSS 上做文章，是把**几何**倒圆。
  // ----------------------------------------------------------------
  // 桌角圆角半径。**和 render.js 的 2D 桌角共用 C.CORNER_R**，
  // 两边画布缓冲与显示尺寸都一样，所以屏幕上就是同一个圆角。
  const TBL_R = C.CORNER_R;

  // 圆角矩形（以原点为中心）。用二次曲线倒角，8 个控制点，够圆了。
  function roundedRect(w, h, r) {
    const x = -w / 2, y = -h / 2;
    const s = new THREE.Shape();
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r);
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h);
    s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }

  // 把形状沿 +Z 挤出 depth，再转成"沿 +Y 挤出"（绕 X 转 -90° → +Z 变成 +Y，
  // 形状的 y 变成世界的 -z，两者都是对称的所以不影响）。
  // UV 不动：ExtrudeGeometry 默认给的就是世界坐标，配 woodTexture(1/300,1/300)。
  function extrudeFlat(shape, depth) {
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: depth, bevelEnabled: false, curveSegments: 8,
    });
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  // ================================================================
  //  台面搭建
  // ================================================================
  function buildTable() {
    // 库边带的分配（从台面线往外量 C.CUSHION = 28px）：
    //   内 16px = 库边橡胶，外 12px = 木框。
    //   台面线就是 C.L / C.T / C.R / C.B，所以往外 = 坐标变小/变大。
    const BAND = C.CUSHION;
    const CUSH_W = BAND - RAIL_W;      // 16
    const CUSH_H = CUSHION_H;          // 14：库边鼻高（≈37mm）
    const RAIL_H = CUSHION_H + 3;      // 17：木框略高于库边（≈40mm）
    const L = C.L, R = C.R, T = C.T, B = C.B;
    const cx = C.CX_TABLE;
    // 桌子外形（可打区 + 两侧库边带）。池球桌比画布小、居中。
    const OUT_W = C.TABLE_W + C.CUSHION * 2;
    const OUT_H = C.TABLE_H + C.CUSHION * 2;

    // ---- 台身：顶面压在台呢下面（-1），只提供厚度和外侧木纹 ----
    // 圆角：BoxGeometry 是四个直角，换成圆角矩形挤出。厚度 40（跨 -41 ~ -1）。
    // 台身也挖出六个袋口通孔：回球斜槽从袋口往下穿过去时，
    // 才不会切进 40px 厚的实心台身。
    const slabShape = roundedRect(OUT_W, OUT_H, TBL_R);
    for (const p of C.pockets) {
      const hole = new THREE.Path();
      hole.absarc(X(p.x), H / 2 - p.y, p.r + 2.5, 0, Math.PI * 2, true);
      slabShape.holes.push(hole);
    }
    const slab = new THREE.Mesh(
      extrudeFlat(slabShape, 40),
      new THREE.MeshStandardMaterial({ map: woodTexture(1 / 300, 1 / 300), color: 0x59331c, roughness: 0.62 })
    );
    slab.position.y = -41;             // extrudeFlat 转完之后底部在 y=0，往上抬到台身底
    slab.castShadow = true; slab.receiveShadow = true;
    scene.add(slab);

    // ---- 台呢（圆角矩形 + 六个袋口洞，库边与木框压在上面）----
    // 旧版是 PlaneGeometry(W,H)：方角，四角的绿布会从圆角木框下面戳出来。
    // 现在用和台身同一套 roundedRect，再把六个袋口挖成真洞。
    const clothShape = roundedRect(OUT_W, OUT_H, TBL_R);
    for (const p of C.pockets) {
      const hole = new THREE.Path();
      // 形状坐标：x 与台面同向，y 是 -z（Z() 的镜像）。圆对称所以圆心照搬即可。
      hole.absarc(X(p.x), H / 2 - p.y, p.r, 0, Math.PI * 2, true);
      clothShape.holes.push(hole);
    }
    const clothGeo = new THREE.ShapeGeometry(clothShape, 12);
    clothGeo.rotateX(-Math.PI / 2);
    // ShapeGeometry 的 UV 是**形状原始坐标**（±708），texture.repeat(60,32) 会密到糊成
    // 纯色。逐顶点改写成 0~1，密度就与旧 PlaneGeometry 完全一致。
    {
      const pos = clothGeo.attributes.position;
      const uv = clothGeo.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        uv.setXY(i, (pos.getX(i) + OUT_W / 2) / OUT_W, (-pos.getZ(i) + OUT_H / 2) / OUT_H);
      }
      uv.needsUpdate = true;
    }
    const cloth = new THREE.Mesh(
      clothGeo,
      new THREE.MeshStandardMaterial({
        // ★ 台呢的固有色。它和 clothTexture() 是**相乘**关系：贴图接近纯白（235~255），
        //   所以这个色值基本就是台呢最终的颜色本身。
        //   演进：0x1a7a3c（太亮）→ 0x0d5a30 → 0x0a4523（还偏草绿）→ 现在 0x08401f。
        //   ⚠ 但它**不是唯一旋钮**了：同一块台呢上还叠着环境光/半球光/主光/补光/
        //   吊灯/窗外光，光总量一动，观感就跟着动。所以现在更好的做法是换
        //   **氛围预设**（Match / Day / Evening / Night，见 AMBIENCE），
        //   色值只管"这块呢子本身有多深"。
        map: clothTexture(), color: 0x08401f, roughness: 0.96, metalness: 0,
      })
    );
    cloth.position.y = 0.02;          // 几何已 rotateX 平放，这里只抬高度
    cloth.receiveShadow = true;
    scene.add(cloth);

    // ---- 木框：一整圈，四条边 + 四个圆角一次成型（真台子的木框本来就是整圈的）----
    // 以前是四条通长 BoxGeometry 拼的 —— 缝可以靠尺寸重叠盖掉，但**四个角是直角**。
    // 现在做成"圆角矩形挖掉一个同心圆角矩形"的环，外沿 W×H、内沿缩进 RAIL_W。
    //   外半径 TBL_R；内半径 TBL_R - RAIL_W —— 同心才不会一头粗一头细。
    const railShape = roundedRect(OUT_W, OUT_H, TBL_R);
    railShape.holes.push(roundedRect(OUT_W - RAIL_W * 2, OUT_H - RAIL_W * 2, TBL_R - RAIL_W));
    const railMat = new THREE.MeshStandardMaterial({
      map: woodTexture(1 / 300, 1 / 300), color: 0x6b3d22, roughness: 0.55,
    });
    const rail = new THREE.Mesh(extrudeFlat(railShape, RAIL_H), railMat);
    rail.position.y = 0;               // 木框坐在台呢平面上，往上挤 RAIL_H
    rail.castShadow = true; rail.receiveShadow = true;
    scene.add(rail);

    // ---- 库边橡胶：只占靠台面线的 16px，被 6 个袋口切成 6 段 ----
    // 袋口端不再是直切的方块：每段两端按袋口圆心切成凹圆弧（半径 = 袋口半径 + 2.5），
    // 这样中袋/角袋的圆形洞口和直库边之间是连续的弧面，不会出现生硬直角。
    const cushMat = new THREE.MeshStandardMaterial({
      color: 0x094c26, roughness: 0.88, side: THREE.DoubleSide,
    });
    const jawGap = 2.5;

    function pocketAt(px, py) {
      let best = null, bd = Infinity;
      for (const p of C.pockets) {
        const d = Math.hypot(p.x - px, p.y - py);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    }

    function arcTo(shape, cx, cy, r, from, to) {
      const a0 = Math.atan2(from.y - cy, from.x - cx);
      const a1 = Math.atan2(to.y - cy, to.x - cx);
      let d = a1 - a0;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      shape.absarc(cx, cy, r, a0, a0 + d, d < 0);
    }

    // 一段库边：isHoriz = 沿 X 方向；line = 内沿坐标；ua/ub = 沿边起止；
    // pa/pb = 两端袋口中心（用于切弧）。
    function buildCushion(isHoriz, line, ua, ub, pa, pb) {
      const out = (line === T || line === L) ? -1 : 1;
      const v0 = CUSH_W;
      const ra = pa.r + jawGap, rb = pb.r + jawGap;

      // 沿边 u / 外法向 v → Shape 坐标（x = world X，y = -world Z）
      function map(u, v) {
        if (isHoriz) {
          const yy = line + out * v;
          return { x: X(u), y: -Z(yy) };
        }
        const xx = line + out * v;
        return { x: X(xx), y: -Z(u) };
      }

      const sa = Math.sqrt(Math.max(1, ra * ra - v0 * v0));
      const sb = Math.sqrt(Math.max(1, rb * rb - v0 * v0));
      const uaInner = ua + ra, uaOuter = ua + sa;
      const ubInner = ub - rb, ubOuter = ub - sb;

      const p1 = map(uaInner, 0);
      const p2 = map(ubInner, 0);
      const o2 = map(ubOuter, v0);
      const o1 = map(uaOuter, v0);
      const ca = map(ua, 0);
      const cb = map(ub, 0);

      const shape = new THREE.Shape();
      shape.moveTo(p1.x, p1.y);
      shape.lineTo(p2.x, p2.y);
      arcTo(shape, cb.x, cb.y, rb, p2, o2);
      shape.lineTo(o1.x, o1.y);
      arcTo(shape, ca.x, ca.y, ra, o1, p1);
      shape.closePath();

      const cush = new THREE.Mesh(extrudeFlat(shape, CUSH_H), cushMat);
      cush.castShadow = true; cush.receiveShadow = true;
      scene.add(cush);
    }

    const cTL = pocketAt(L, T), cTR = pocketAt(R, T), cBL = pocketAt(L, B), cBR = pocketAt(R, B);
    const cMT = pocketAt(cx, T), cMB = pocketAt(cx, B);
    buildCushion(true, T, L, cx, cTL, cMT);       // 上库左段
    buildCushion(true, T, cx, R, cMT, cTR);       // 上库右段
    buildCushion(true, B, L, cx, cBL, cMB);       // 下库左段
    buildCushion(true, B, cx, R, cMB, cBR);       // 下库右段
    buildCushion(false, L, T, B, cTL, cBL);       // 左库
    buildCushion(false, R, T, B, cTR, cBR);       // 右库

    // ---- 袋口：皮革圈 + 向下收口的黑兜 ----
    // 旧版是一根和台面同高的黑圆柱，俯视只看到一个圆盘，不像袋口。
    // 现在台呢上有真洞，袋口用：平放的皮革环（略高于台呢）+ 上宽下窄的开口锥兜。
    // 不做布尔运算 —— 洞是台呢形状上的 hole，锥兜只是塞在洞下面。
    for (let i = 0; i < C.pockets.length; i++) {
      const p = C.pockets[i];
      const px = X(p.x), pz = Z(p.y);

      // 皮革圈（深棕近黑，边缘略微外扩盖住布料切口）
      const leather = new THREE.Mesh(
        new THREE.RingGeometry(p.r * 0.92, p.r + 3, 28),
        new THREE.MeshStandardMaterial({ color: 0x1c1310, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide })
      );
      leather.rotation.x = -Math.PI / 2;
      leather.position.set(px, 0.35, pz);
      leather.receiveShadow = true;
      scene.add(leather);

      // 锥形兜：顶圆 = 袋口半径，往下收到 55%，高 34，顶面贴着台呢下沿
      const pocketDepth = 34;
      const cup = new THREE.Mesh(
        new THREE.CylinderGeometry(p.r, p.r * 0.55, pocketDepth, 24, 1, true),
        new THREE.MeshStandardMaterial({ color: 0x0b0908, roughness: 0.95, side: THREE.DoubleSide })
      );
      cup.position.set(px, 0.3 - pocketDepth / 2, pz);
      scene.add(cup);

      // 兜底：深黑圆片，俯视时不会透过洞看到台身内部
      const bottom = new THREE.Mesh(
        new THREE.CircleGeometry(p.r * 0.56, 24),
        new THREE.MeshBasicMaterial({ color: 0x020304 })
      );
      bottom.rotation.x = -Math.PI / 2;
      bottom.position.set(px, 0.3 - pocketDepth + 0.2, pz);
      scene.add(bottom);
    }

    // ---- 六个点位标记 ----
    const spotMat = new THREE.MeshBasicMaterial({ color: 0xcfd8cf });
    const snookerSpots = (C.TABLE_MODE !== 'eightball' && C.TABLE_MODE !== 'nineball');
    for (const label of C.COL_ORDER) {
      if (!snookerSpots) break;
      const pos = C.getColorPos(label);
      if (!pos) continue;
      const dot = new THREE.Mesh(new THREE.CircleGeometry(1.2, 12), spotMat);
      dot.rotation.x = -Math.PI / 2;
      dot.position.set(X(pos.x), 0.05, Z(pos.y));
      scene.add(dot);
    }

    // 开球摆白球时高亮 D 区（半圆，朝开球线左侧开口）
    if (snookerSpots) {
      const dShape = new THREE.Shape();
      const dcx = X(C.BAULK_X), dcy = -Z(C.CY2);
      dShape.moveTo(dcx, dcy);
      dShape.absarc(dcx, dcy, C.DR, Math.PI / 2, Math.PI * 1.5, false);
      dShape.lineTo(dcx, dcy);
      const dGeo = new THREE.ShapeGeometry(dShape, 28);
      dGeo.rotateX(-Math.PI / 2);
      dZone = new THREE.Mesh(
        dGeo,
        new THREE.MeshBasicMaterial({
          color: 0x6ed2ff, transparent: true, opacity: 0.12,
          depthWrite: false, side: THREE.DoubleSide,
        })
      );
      dZone.position.y = 0.14;
      dZone.visible = false;
      scene.add(dZone);
    }

    // ================================================================
    //  包金细节：一圈金色嵌线 + 库边菱形刻度 + 袋口铜圈 + 铜牌
    //  全部是基本几何，不增加纹理/外部模型。
    // ================================================================
    const goldMat = new THREE.MeshStandardMaterial({
      color: 0xc9a24a, roughness: 0.26, metalness: 0.88,
    });
    // 外圈金色嵌线（圆角矩形环，平铺在木框顶面）
    const trimShape = roundedRect(OUT_W - 10, OUT_H - 10, TBL_R - 4);
    trimShape.holes.push(roundedRect(OUT_W - 18, OUT_H - 18, TBL_R - 8));
    const trim = new THREE.Mesh(new THREE.ShapeGeometry(trimShape, 18), goldMat);
    trim.rotation.x = -Math.PI / 2;
    trim.position.y = RAIL_H + 0.25;
    scene.add(trim);

    // 库边菱形铜标：长边各 4 个，短边各 2 个
    const sightGeo = new THREE.BoxGeometry(4.2, 1.2, 4.2);
    function sight(x, z) {
      const m = new THREE.Mesh(sightGeo, goldMat);
      m.rotation.y = Math.PI / 4;     // 俯视呈菱形
      m.position.set(x, RAIL_H + 0.9, z);
      scene.add(m);
    }
    const sxL = X(L), sxR = X(R), szT = Z(T), szB = Z(B);
    const railMid = C.CUSHION * 0.5;
    const xs = [0.22, 0.4, 0.6, 0.78].map(t => sxL + (sxR - sxL) * t);
    for (const x of xs) {
      sight(x, szT - railMid);
      sight(x, szB + railMid);
    }
    sight(sxL - railMid, szT + (szB - szT) * 0.5);
    sight(sxR + railMid, szT + (szB - szT) * 0.5);

    // 袋口铜圈：只保留靠库边/台面内的那一段，不画完整圆环。
    // 中间袋朝台面内 (+Z / -Z)，角袋朝对角；约 200° 的铜箍。
    for (const p of C.pockets) {
      const isMiddle = Math.abs(p.x - cx) < 2;
      let centre;
      if (isMiddle) {
        centre = p.y < C.T + 1 ? Math.PI / 2 : -Math.PI / 2;
      } else {
        const sx = p.x < cx ? 1 : -1;          // 朝台内
        const sy = p.y < C.T + 1 ? 1 : -1;
        centre = Math.atan2(sy, sx);
      }
      const arc = Math.PI * 1.12;              // 约 202°
      const geo = new THREE.TorusGeometry(p.r + 2.2, 1.15, 6, 26, arc);
      // 金属箍要压在**靠库边的一侧**，不是台面内侧：
      // 把弧段中心翻 180°，和上一版完全相反。
      geo.rotateZ(centre + Math.PI - arc / 2);
      const ring = new THREE.Mesh(geo, goldMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(X(p.x), RAIL_H + 0.5, Z(p.y));
      scene.add(ring);
    }

    // 长边铜牌：深色底 + 金色字（canvas 纹理，不引外部图片）
    function namePlate(z, flip) {
      const cv = document.createElement('canvas');
      cv.width = 512; cv.height = 96;
      const g = cv.getContext('2d');
      g.fillStyle = '#1a120b';
      g.fillRect(0, 0, 512, 96);
      g.strokeStyle = '#c9a24a';
      g.lineWidth = 6;
      g.strokeRect(4, 4, 504, 88);
      g.fillStyle = '#e8c878';
      g.font = 'bold 44px Georgia, serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('SNOOKER · 147', 256, 50);
      const tex = new THREE.CanvasTexture(cv);
      tex.encoding = THREE.sRGBEncoding;
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(120, 22),
        new THREE.MeshBasicMaterial({ map: tex })
      );
      m.position.set(0, 9, z);
      if (flip) m.rotation.y = Math.PI;
      scene.add(m);
    }
    namePlate(Z(B + C.CUSHION) + 0.8, false);
    namePlate(Z(T - C.CUSHION) - 0.8, true);

    buildReturnSystem();
  }

  // ================================================================
  //  回球轨道：台面下两条半开放铜轨，球从袋口落下来后滚向一端球箱。
  //  动画小球只是视觉，不改物理；俯视正交时整组隐藏。
  // ================================================================
  function buildReturnSystem() {
    returnRoot = new THREE.Group();
    ceilingVis.push(returnRoot);
    scene.add(returnRoot);

    // 整套回球机构放到台身下方：轨道顶 -62，球心 -52.5。
    // 球顶约 -43，低于台身底面 -41，不会再穿过桌面。
    // z 方向适当内收：轨道在 z≈±323，避开桌腿（±272）。
    const laneY = -64;
    const ballY = -52.5;
    const pocketY = -34;
    const laneZTop = Z(C.T) + 16;
    const laneZBot = Z(C.B) - 16;
    const x0 = X(C.L);
    const x1 = X(C.R);
    const trayX = x1 - 80;                // 台身端部下方，箱体不伸出桌外/不碰短轨
    const laneEndX = trayX - 90;
    const trayY = -96;
    returnTrayX = trayX;
    returnGeom = {
      laneY: laneY, ballY: ballY, pocketY: pocketY,
      laneZTop: laneZTop, laneZBot: laneZBot,
      x0: x0, x1: x1, laneEndX: laneEndX,
      trayX: trayX, trayY: trayY, trayEndY: -84,
    };

    const wood = new THREE.MeshStandardMaterial({
      color: 0x5a351c, roughness: 0.62, emissive: 0x140a03, emissiveIntensity: 0.5,
    });
    const brass = new THREE.MeshStandardMaterial({
      color: 0xd0a84c, roughness: 0.30, metalness: 0.45,
      emissive: 0x3a2808, emissiveIntensity: 0.55,
    });

    function channel(z) {
      const len = x1 - x0;
      const base = new THREE.Mesh(new THREE.BoxGeometry(len, 4, 22), wood);
      base.position.set((x0 + x1) / 2, laneY, z);
      base.castShadow = true;
      returnRoot.add(base);
      for (const dz of [-10, 10]) {
        const lip = new THREE.Mesh(new THREE.BoxGeometry(len, 3, 2.2), brass);
        lip.position.set((x0 + x1) / 2, laneY + 3, z + dz);
        returnRoot.add(lip);
      }
      // 从台身底面 -41 吊到轨道顶 -62，完全在桌下
      for (let x = x0 + 120; x < x1 - 80; x += 380) {
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 23, 8), brass);
        rod.position.set(x, -52.5, z);
        returnRoot.add(rod);
      }
    }
    channel(laneZTop);
    channel(laneZBot);

    // 短边横向轨道：把两条长轨连成一个矩形回球框。
    // 位置放在 x≈±668，避开桌腿（x≈±612, z≈±272）。
    function crossChannel(x) {
      const len = Math.abs(laneZBot - laneZTop);
      const base = new THREE.Mesh(new THREE.BoxGeometry(22, 4, len), wood);
      base.position.set(x, laneY, (laneZTop + laneZBot) / 2);
      base.castShadow = true;
      returnRoot.add(base);
      for (const dx of [-10, 10]) {
        const lip = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3, len), brass);
        lip.position.set(x + dx, laneY + 3, (laneZTop + laneZBot) / 2);
        returnRoot.add(lip);
      }
      for (let z = laneZTop + 130; z < laneZBot - 80; z += 380) {
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 23, 8), brass);
        rod.position.set(x, -52.5, z);
        returnRoot.add(rod);
      }
    }
    crossChannel(x0 + 12);
    crossChannel(x1 - 12);

    // 每个袋口到轨道的斜槽（穿过台身上挖出的袋口通孔）
    function chute(fromX, fromY, fromZ, toX, toY, toZ, r0, r1) {
      const dx = toX - fromX, dy = toY - fromY, dz = toZ - fromZ;
      const len = Math.hypot(dx, dy, dz);
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(r1 || 9, r0 || 9, len, 14, 1, true), wood
      );
      m.position.set((fromX + toX) / 2, (fromY + toY) / 2, (fromZ + toZ) / 2);
      m.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(dx, dy, dz).normalize()
      );
      returnRoot.add(m);
    }
    for (const p of C.pockets) {
      const zLane = p.y < C.H / 2 ? laneZTop : laneZBot;
      chute(X(p.x), pocketY, Z(p.y), X(p.x), ballY, zLane, 9, 8);
    }

    // 端部球箱：塞在台身下方，和两条轨道真正接上，不再悬在桌外。
    const tray = new THREE.Group();
    tray.position.set(trayX, trayY, 0);
    returnRoot.add(tray);
    const box = new THREE.Mesh(new THREE.BoxGeometry(96, 58, 160), wood);
    box.castShadow = true;
    tray.add(box);
    // 两根吊架把球箱接到台身底面
    for (const dz of [-40, 40]) {
      const hang = new THREE.Mesh(new THREE.BoxGeometry(10, 26, 6), brass);
      hang.position.set(-10, 42, dz);
      tray.add(hang);
    }
    const liner = new THREE.Mesh(
      new THREE.BoxGeometry(82, 48, 146),
      new THREE.MeshStandardMaterial({ color: 0x090807, roughness: 1 })
    );
    liner.position.y = 8;
    tray.add(liner);
    for (const dz of [-74, 74]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(100, 5, 4), brass);
      rail.position.set(0, 30, dz);
      tray.add(rail);
    }
    for (const dx of [-48, 48]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(4, 5, 160), brass);
      rail.position.set(dx, 30, 0);
      tray.add(rail);
    }
    // 轨道到球箱的短连接段
    for (const z of [laneZTop, laneZBot]) {
      chute(laneEndX, ballY, z, trayX, trayY + 26, z * 0.55, 8, 7);
    }
  }

  // 回球动画：球从袋口落到铜轨，再滚到端部球箱。
  const returnMatCache = {};
  function returnBallMesh(slot) {
    if (returnBalls[slot]) return returnBalls[slot];
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R * 0.92, 16, 12),
      meshMat('#ffffff', 0.25, 0.05)
    );
    m.visible = false;
    m.castShadow = true;
    scene.add(m);
    returnBalls[slot] = m;
    return m;
  }

  function spawnReturn(label, fromX, fromY) {
    if (!returnRoot || !returnRoot.visible) return;
    // 找最近的袋口
    let best = null, bd = Infinity;
    for (let i = 0; i < C.pockets.length; i++) {
      const p = C.pockets[i];
      const d = Math.hypot(p.x - fromX, p.y - fromY);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    let slot = -1;
    for (let i = 0; i < 8; i++) {
      if (!returnBalls[i] || !returnBalls[i].visible) { slot = i; break; }
    }
    if (slot < 0) slot = (Math.random() * 8) | 0;
    const m = returnBallMesh(slot);
    if (!returnMatCache[label]) {
      returnMatCache[label] = new THREE.MeshStandardMaterial({
        color: new THREE.Color(C.COL[label] || '#dddddd'),
        roughness: 0.22, metalness: 0.04,
      });
    }
    m.material = returnMatCache[label];
    m.visible = true;
    m.scale.setScalar(1);

    const g = returnGeom;
    if (!g) return;
    const laneZ = best.y < C.H / 2 ? g.laneZTop : g.laneZBot;
    // 用直线段，不用 Catmull-Rom：球必须严格沿轨道中心线走，
    // 任何样条弯曲都会让球和轨道看起来"不在同一个地方"。
    const start = new THREE.Vector3(X(best.x), g.pocketY, Z(best.y));
    const drop = new THREE.Vector3(X(best.x), g.ballY, laneZ);
    const laneEnd = new THREE.Vector3(g.laneEndX, g.ballY, laneZ);
    const trayEntry = new THREE.Vector3(g.trayX, g.trayY + 26, laneZ * 0.55);
    const trayEnd = new THREE.Vector3(g.trayX, g.trayEndY, 0);
    const curve = new THREE.CurvePath();
    curve.add(new THREE.LineCurve3(start, drop));
    curve.add(new THREE.LineCurve3(drop, laneEnd));
    curve.add(new THREE.LineCurve3(laneEnd, trayEntry));
    curve.add(new THREE.LineCurve3(trayEntry, trayEnd));
    returnAnims.push({
      m: m, curve: curve, len: Math.max(1, curve.getLength()),
      t: 0, speed: 430,
    });
  }

  function updateReturnBalls(dt, balls) {
    if (!returnRoot) return;
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.isOnTable()) {
        lastOn[i] = { x: b.x, y: b.y };
        potSeen[i] = false;
      } else if (!potSeen[i] && lastOn[i]) {
        potSeen[i] = true;
        // 白球马上会被放回 D 区/自由球，不做回球动画
        if (b.label !== 'white') spawnReturn(b.label, lastOn[i].x, lastOn[i].y);
      }
    }

    for (let i = returnAnims.length - 1; i >= 0; i--) {
      const a = returnAnims[i];
      a.t += a.speed * dt / a.len;
      if (a.t >= 1) {
        a.m.visible = false;
        returnAnims.splice(i, 1);
        continue;
      }
      const pos = a.curve.getPointAt(a.t);
      a.m.position.copy(pos);
      const tan = a.curve.getTangentAt(a.t);
      const axis = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0));
      if (axis.lengthSq() > 1e-8) {
        axis.normalize();
        a.m.rotateOnWorldAxis(axis, -(a.speed * dt) / BALL_R);
      }
    }
  }

  // 台面坐标 → three 坐标
  function X(x) { return x - W / 2; }
  function Z(y) { return y - H / 2; }

  // ================================================================
  //  房间：地板 / 地毯 / 桌腿 / 墙 / 三盏吊灯
  //
  //  台呢仍在 y = 0，**上面那些几何/阴影/坐标换算一行都没动** ——
  //  房间只是往 y < 0 的方向长出来的。
  //  比例：C.SCALE ≈ 0.381 px/mm，真实台高 850mm → 324px，
  //  台身底边在 -41，所以地面放在 FLOOR_Y。
  // ================================================================
  const FLOOR_Y = -365;
  const WALL_H = 1750;
  const CEIL_Y = FLOOR_Y + WALL_H;
  const WALL_HX = 3100;                 // 房间半宽（X 方向）。窗砌在 -X 那面墙上。

  // 透视机"俯视机位"：观战从正交俯视切到透视巡游时，起飞点就摆在这儿 ——
  // pol 压到夹紧下限、距离取 900，算下来垂直视野 2·900·tan22.5° ≈ 745 ≈ H，
  // 和正交机的取景几乎重合，所以切换的那一下看不出跳变。
  const ORB_TOP = { pol: 0.10, dist: 900, tx: 0, ty: 0, tz: 0 };

  // ================================================================
  //  光照氛围预设 + 窗
  //
  //  用户原话是"3D 视图下颜色感觉很奇怪"。只调度台呢那一个色值解决不了：
  //  同一块台呢上叠着环境光 + 半球光 + 主光 + 补光 + 三盏吊灯 + 窗外光，
  //  改一个数字，另五个会把它淹掉。所以这一版把**整套光照**做成可选预设，
  //  并且真的砌了一扇窗：主光从窗口斜射进来，窗玻璃的亮度、进来的光色、
  //  房间底色（CSS 变量）一起换 —— 这才是"氛围"，不是"深浅"。
  //
  //  主光 sun 仍然是全场**唯一投影光源**（阴影开销不变），三个预设只改它的
  //  位置/颜色/强度。位置一改投影距离就变，所以 shadow far 按 |sunPos| 现算。
  // ================================================================
  const AMBIENCE = {
    // 转播级：色温中性、四角都有光，最接近电视里那张台
    match: {
      label: 'Match',
      ambient: [0xffffff, 0.30], hemi: [0x3d4a63, 0x141010, 0.26],
      sun: [0xffffff, 0.55], sunPos: [1500, 2000, -800],
      fill: [0xcfd8ff, 0.18], lamp: [0xfff2d8, 0.50], room: 0.26,
      pane: [0xdfe8ff, 0.75], glow: [0xdfe8ff, 0.22], fog: 0x0b1016,
      sky: ['#123020', '#0a1a10', '#050c07'], page: ['#1a1a2e', '#16213e'],
    },
    // 白天：窗光最亮、偏冷，房间整体抬亮
    day: {
      label: 'Day',
      ambient: [0xdfe9ff, 0.32], hemi: [0x9fb8d8, 0x2a2018, 0.30],
      sun: [0xfff6e8, 0.70], sunPos: [-3300, 1500, -700],
      fill: [0xcfd8ff, 0.14], lamp: [0xfff2d8, 0.16], room: 0.34,
      pane: [0xf2f7ff, 1.00], glow: [0xe8f0ff, 0.34], fog: 0x232a30,
      sky: ['#20402c', '#132618', '#08120c'], page: ['#26303f', '#1b2430'],
    },
    // 傍晚：太阳压到窗口低处、橙红，房间暗下来，吊灯开始接手
    evening: {
      label: 'Evening',
      ambient: [0xffd9b0, 0.20], hemi: [0x5a4030, 0x140c08, 0.20],
      sun: [0xff9c4a, 0.66], sunPos: [-3400, 380, -500],
      fill: [0xffb070, 0.10], lamp: [0xffd9a0, 0.58], room: 0.28,
      pane: [0xffa860, 1.00], glow: [0xff9840, 0.30], fog: 0x1a0f0c,
      sky: ['#2a1a12', '#180e0a', '#0a0504'], page: ['#2c1d22', '#1c1218'],
    },
    // 夜晚：窗外只剩一点冷色月光，吊灯是主照明
    night: {
      label: 'Night',
      ambient: [0x8fa8d8, 0.10], hemi: [0x1a2438, 0x0a0806, 0.12],
      sun: [0x9fc0ff, 0.16], sunPos: [-3000, 900, -900],
      fill: [0x6f88b8, 0.08], lamp: [0xffd9a0, 0.75], room: 0.14,
      pane: [0x2a3c66, 0.90], glow: [0x5f7fc0, 0.14], fog: 0x05080d,
      sky: ['#0a1420', '#050a12', '#020407'], page: ['#12141f', '#0c0e16'],
    },
  };
  const AMB_KEYS = ['auto', 'match', 'day', 'evening', 'night'];
  let ambName = 'match';
  let autoApplied = null;
  let lastAutoCheck = 0;

  function autoPreset() {
    const h = new Date().getHours();
    if (h >= 7 && h < 16) return 'day';
    if (h >= 16 && h < 20) return 'evening';
    return 'night';
  }
  // 让 applyAmbience 能改到光：init() 里把这几盏灯存下来
  const ambRefs = { amb: null, hemi: null, sun: null, fill: null, glow: null, room: null, pane: null };
  const lampLights = [];                // 三盏吊灯的 SpotLight
  const ambListeners = [];

  // 上次选的氛围（file:// 下某些浏览器禁用 localStorage → 包 try/catch）
  try {
    const v = window.localStorage.getItem('snk.ambience');
    if (v && (v === 'auto' || AMBIENCE[v])) ambName = v;
  } catch (e) { /* 读不到就用默认 match */ }

  // 应用一个氛围预设：改光照 + 窗玻璃 + 页面底色（CSS 变量）+ 吊灯。
  // 主光一挪位置，投影距离就变，所以 shadow far 按 |sunPos| 现算 —— 这是本函数
  // 唯一一处"不能写死"的地方（见 init 里那段注释）。
  function applyAmbience(name, save) {
    if (name === 'auto') {
      ambName = 'auto';
    } else {
      if (!AMBIENCE[name]) name = 'match';
      ambName = name;
    }
    const eff = name === 'auto' ? autoPreset() : name;
    autoApplied = eff;
    const a = AMBIENCE[eff];

    const R = ambRefs;
    if (R.amb) {
      R.amb.color.setHex(a.ambient[0]); R.amb.intensity = a.ambient[1];
      R.hemi.color.setHex(a.hemi[0]); R.hemi.groundColor.setHex(a.hemi[1]); R.hemi.intensity = a.hemi[2];
      R.sun.color.setHex(a.sun[0]); R.sun.intensity = a.sun[1];
      const sp = a.sunPos;
      R.sun.position.set(sp[0], sp[1], sp[2]);
      R.sun.shadow.camera.far = Math.hypot(sp[0], sp[1], sp[2]) + 2600;
      R.sun.shadow.camera.updateProjectionMatrix();
      R.fill.color.setHex(a.fill[0]); R.fill.intensity = a.fill[1];
      R.glow.color.setHex(a.glow[0]); R.glow.intensity = a.glow[1];
      if (R.room) R.room.intensity = a.room;
      if (R.pane) { R.pane.material.color.setHex(a.pane[0]); R.pane.material.opacity = a.pane[1]; }
      for (let i = 0; i < lampLights.length; i++) {
        lampLights[i].color.setHex(a.lamp[0]);
        lampLights[i].intensity = a.lamp[1];
        lampBase[i] = a.lamp[1];           // 动态微闪的基准值
      }
      // 霓虹在暗环境里更显眼，白天几乎关掉
      neonBase = eff === 'night' ? 0.34 : (eff === 'evening' ? 0.28 : (eff === 'day' ? 0.08 : 0.22));
      if (neonLight) neonLight.intensity = neonBase;
      if (scene && scene.fog) scene.fog.color.setHex(a.fog);
    }

    // 页面/画布底色。3D 画布是 alpha 透明的（露出来的是 CSS 渐变），
    // 所以"氛围"有一半其实是在 CSS 上 —— 光调暗了底色不变，会显得屋里亮着却发蓝。
    try {
      const st = document.documentElement.style;
      st.setProperty('--sky0', a.sky[0]);
      st.setProperty('--sky1', a.sky[1]);
      st.setProperty('--sky2', a.sky[2]);
      st.setProperty('--page0', a.page[0]);
      st.setProperty('--page1', a.page[1]);
      document.body.setAttribute('data-amb', eff);
    } catch (e) { /* 没有 document 就算了 */ }

    if (save) {
      try { window.localStorage.setItem('snk.ambience', ambName); } catch (e) { /* 同上 */ }
    }
    for (let i = 0; i < ambListeners.length; i++) {
      try { ambListeners[i](ambName); } catch (e) { /* 回调出错不能拖垮渲染 */ }
    }
  }

  // 地毯贴图：暗红底 + 内嵌双层边框，程序化生成（无外部资源）
  function rugTexture() {
    const s = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.fillStyle = '#4a1418'; g.fillRect(0, 0, s, s);
    // 一点暗纹，别是一块死红
    for (let i = 0; i < 2200; i++) {
      g.fillStyle = 'rgba(0,0,0,' + (Math.random() * 0.10) + ')';
      g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    g.strokeStyle = '#c2a05a'; g.lineWidth = 5;
    g.strokeRect(14, 14, s - 28, s - 28);
    g.strokeStyle = 'rgba(194,160,90,0.55)'; g.lineWidth = 2;
    g.strokeRect(26, 26, s - 52, s - 52);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.encoding = THREE.sRGBEncoding;   // 地毯贴图同样是 sRGB 色值
    return tex;
  }

  function buildRoom() {
    // ---- 地板 ----
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(6400, 5400),
      new THREE.MeshStandardMaterial({ color: 0x2a2019, roughness: 0.92, metalness: 0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y + 1;      // 抬 1px，别和房间盒子的底面打架
    floor.receiveShadow = true;
    scene.add(floor);

    // ---- 地毯（球桌下面那块）----
    // 地毯也做成圆角：俯视 3D 时即使画布裁剪出问题，桌角外也不会出现
    // 一块直角地毯。圆角半径比台面大，视觉上像一块真实的地毯。
    const rugW = W + 900, rugH = H + 900;
    const rugShape = roundedRect(rugW, rugH, C.CORNER_R + 110);
    const rugGeo = new THREE.ShapeGeometry(rugShape, 18);
    rugGeo.rotateX(-Math.PI / 2);
    {
      const pos = rugGeo.attributes.position;
      const uv = rugGeo.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        uv.setXY(i, (pos.getX(i) + rugW / 2) / rugW, (-pos.getZ(i) + rugH / 2) / rugH);
      }
      uv.needsUpdate = true;
    }
    const rug = new THREE.Mesh(
      rugGeo,
      new THREE.MeshStandardMaterial({ map: rugTexture(), roughness: 0.95, metalness: 0 })
    );
    rug.position.y = FLOOR_Y + 2;
    rug.receiveShadow = true;
    scene.add(rug);
    // 俯视正交下隐藏红地毯：桌子是圆角，红毯的矩形边界露在桌角旁会
    // 被看成"圆角桌旁边一个直角"。轨道视角仍保留地毯。
    ceilingVis.push(rug);

    // ---- 桌腿：四条**车木圆柱**，压在台身四角内侧 ----
    // 原来是 92×92 的方块，像个水泥墩。真台子的腿是车床车出来的回转体：
    // 底盘外撇 → 收腰 → 两道箍 → 细杆 → 到顶部再往外张（国际象棋小兵那一路）。
    // LatheGeometry 正好是"给一条剖面绕着轴旋一圈"，剖面里的鼓-收-鼓就是那些起伏。
    const legMat = new THREE.MeshStandardMaterial({
      map: woodTexture(6, 1), color: 0x4a2a15, roughness: 0.6,
    });
    const legTop = -30;                       // 插进台身里一点，避免看到接缝
    const legH = legTop - FLOOR_Y;            // 335
    const legGeo = new THREE.LatheGeometry(legProfile(legH, 46), 28);
    const outW = C.TABLE_W + C.CUSHION * 2, outH = C.TABLE_H + C.CUSHION * 2;
    const legX = outW / 2 - 96, legZ = outH / 2 - 96;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.set(sx * legX, FLOOR_Y, sz * legZ);   // 剖面从 y=0 起算 → 放在地面上
        leg.castShadow = true; leg.receiveShadow = true;
        scene.add(leg);
      }
    }

    // ---- 台子旁边的家具：小圆桌 + 椅子 + 花瓶 ----
    buildSideFurniture();

    // ---- 房间外壳：一个反面盒子，同时当四面墙和天花板 ----
    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(6200, WALL_H, 5200),
      new THREE.MeshStandardMaterial({ color: 0x191720, roughness: 0.95, side: THREE.BackSide })
    );
    shell.position.y = FLOOR_Y + WALL_H / 2;
    shell.receiveShadow = true;
    scene.add(shell);

    // ---- 真正看得见的墙：下半截深色护墙板 + 上半截灰绿灰泥 ----
    // 原来只有一层 0x191720 的反面盒子，四面墙像一个纯色隧道。
    // 现在用房间内侧的独立面片重做，窗洞在 -X 墙上留出来。
    buildWalls();

    // ---- 窗（氛围的入口，见 buildWindow）----
    buildWindow();

    // ---- 三盏吊灯：沿长轴均布 ----
    for (const k of [-1, 0, 1]) {
      buildLamp(k * W / 3, k * 40);
    }

    // ---- 空气灰尘：台球厅射灯下的浮尘 ----
    buildDust();
  }

  // ================================================================
  //  房间内墙：护墙板 + 灰泥上墙 + 线脚 + 挂画 + 挂钟 + 霓虹 + 球杆架
  //
  //  旧版四面墙就是外壳盒子的同一种颜色，透视机一转过去像一条隧道。
  //  这里把"墙"当成装修来做：下 440px 深色木护墙板（带竖向分格），
  //  上面灰绿色灰泥，腰线/踢脚/顶角线收边；窗洞在 -X 墙上留空。
  //  所有尺寸都按房间的真实坐标算，和窗、吧台、吊灯同一套比例。
  // ================================================================
  function buildWalls() {
    const wallHX = WALL_HX - 5;          // 3100 的外壳内表面，再往里 5px
    const wallHZ = 2600 - 5;
    const floorY = FLOOR_Y + 1;
    const lowH = 440;                    // 护墙板高（≈1.15m）
    const topY = CEIL_Y - 34;            // 灰泥上墙的顶
    const upY0 = floorY + lowH;
    const upH = topY - upY0;

    const upperMat = new THREE.MeshStandardMaterial({
      map: wallTexture(), color: 0x76806a, roughness: 0.96, metalness: 0,
    });
    const wainMat = new THREE.MeshStandardMaterial({
      map: woodTexture(6, 1), color: 0x5c3a20, roughness: 0.62, metalness: 0,
    });
    const stileMat = new THREE.MeshStandardMaterial({
      map: woodTexture(2, 1), color: 0x6d4828, roughness: 0.56,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x352113, roughness: 0.5,
    });
    const ceilMat = new THREE.MeshStandardMaterial({
      color: 0x24211c, roughness: 0.98,
    });
    const beamMat = new THREE.MeshStandardMaterial({
      map: woodTexture(5, 1), color: 0x3a2517, roughness: 0.72,
    });

    function box(w, h, d, x, y, z, mat, shadow) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = !!shadow;
      m.receiveShadow = true;
      scene.add(m);
      return m;
    }

    // 重复的线脚/壁柱用 InstancedMesh：同样一屏几十根，只算 1 次 draw call。
    // 这是 three.js 官方推荐的静态重复物体做法，比合并 BufferGeometry 简单，
    // 也不需要 BufferGeometryUtils 那个 addon（vendor 里只有核心库）。
    function instanced(w, h, d, mat, list, shadow) {
      const geo = new THREE.BoxGeometry(w, h, d);
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      const dummy = new THREE.Object3D();
      for (let i = 0; i < list.length; i++) {
        dummy.position.set(list[i][0], list[i][1], list[i][2]);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        m.setMatrixAt(i, dummy.matrix);
      }
      m.instanceMatrix.needsUpdate = true;
      m.castShadow = !!shadow;
      m.receiveShadow = true;
      scene.add(m);
      return m;
    }

    // ---- 天花板 ----
    // 用单面朝下的平面，不用盒子：轨道机的默认高度在屋顶之上（dist 2150、
    // 极角 0.62 → 相机 y≈1670 > 1385）。盒子会从上面把整个房间盖死，
    // 单面平面在屋顶上方被背面剔除，仍是"剖开屋顶看进去"的效果。
    const ceilPlane = new THREE.Mesh(new THREE.PlaneGeometry(6200, 5200), ceilMat);
    ceilPlane.rotation.x = Math.PI / 2;
    ceilPlane.position.set(0, CEIL_Y - 4, 0);
    ceilPlane.receiveShadow = true;
    scene.add(ceilPlane);
    // 天花横梁：透视机下把屋顶"压"下来，空间有进深
    {
      const beams = [-1800, -600, 600, 1800].map(bx => [bx, CEIL_Y - 62, 0]);
      ceilingVis.push(instanced(96, 64, 5200, beamMat, beams, true));
    }

    // ---- +Z / -Z 两面长墙 ----
    for (const sz of [-1, 1]) {
      const z = sz * wallHZ;
      box(6200, upH, 14, 0, upY0 + upH / 2, z, upperMat);
      box(6200, lowH, 14, 0, floorY + lowH / 2, z, wainMat);
      box(6200, 30, 26, 0, upY0, z, trimMat);
      box(6200, 76, 22, 0, floorY + 38, z, trimMat);
      box(6200, 30, 24, 0, topY + 12, z, trimMat);
    }

    // ---- +X 长墙（整面） ----
    box(14, upH, 5200, wallHX, upY0 + upH / 2, 0, upperMat);
    box(14, lowH, 5200, wallHX, floorY + lowH / 2, 0, wainMat);
    box(26, 30, 5200, wallHX, upY0, 0, trimMat);
    box(22, 76, 5200, wallHX, floorY + 38, 0, trimMat);
    box(24, 30, 5200, wallHX, topY + 12, 0, trimMat);

    // ---- -X 长墙：中间是窗洞，四块面片围出来 ----
    // 窗框几何见 buildWindow：洞的 Z 半宽 ≈796，Y 从 409 到 1281（世界坐标）。
    const holeZ = 796, holeY0 = 409, holeY1 = 1281;
    const sideW = 2600 - holeZ;
    for (const sz of [-1, 1]) {
      const zc = sz * (holeZ + sideW / 2);
      box(14, upH, sideW, -wallHX, upY0 + upH / 2, zc, upperMat);
      box(14, lowH, sideW, -wallHX, floorY + lowH / 2, zc, wainMat);
    }
    // 窗下 / 窗上
    box(14, holeY0 - upY0, holeZ * 2, -wallHX, (upY0 + holeY0) / 2, 0, upperMat);
    box(14, topY - holeY1, holeZ * 2, -wallHX, (holeY1 + topY) / 2, 0, upperMat);
    // 下墙整条 + 线脚
    box(14, lowH, holeZ * 2, -wallHX, floorY + lowH / 2, 0, wainMat);
    box(26, 30, 5200, -wallHX, upY0, 0, trimMat);
    box(22, 76, 5200, -wallHX, floorY + 38, 0, trimMat);
    box(24, 30, 5200, -wallHX, topY + 12, 0, trimMat);

    // ---- 护墙板竖向分格 ----
    const stileH = lowH - 108;
    const stileY = floorY + 54 + stileH / 2;
    const stilesZ = [];
    for (let x = -2800; x <= 2800; x += 400) {
      stilesZ.push([x, stileY, wallHZ - 7], [x, stileY, -wallHZ + 7]);
    }
    instanced(18, stileH, 10, stileMat, stilesZ, false);
    const stilesX = [];
    for (let z = -2400; z <= 2400; z += 400) {
      stilesX.push([wallHX - 7, stileY, z], [-wallHX + 7, stileY, z]);
    }
    instanced(10, stileH, 18, stileMat, stilesX, false);

    // ---- 上半墙的竖向壁柱：把大块灰泥分成几段 ----
    const pilMat = new THREE.MeshStandardMaterial({ color: 0x687260, roughness: 0.92 });
    const pilZ = [], pilX = [];
    for (const px of [-2400, -800, 800, 2400]) {
      pilZ.push([px, upY0 + upH / 2, wallHZ - 8], [px, upY0 + upH / 2, -wallHZ + 8]);
    }
    for (const pz of [-2000, 2000]) {
      pilX.push([wallHX - 8, upY0 + upH / 2, pz], [-wallHX + 8, upY0 + upH / 2, pz]);
    }
    instanced(30, upH, 12, pilMat, pilZ, false);
    instanced(12, upH, 30, pilMat, pilX, false);

    // ---- 墙面装饰 ----
    buildWallArt(wallHX, wallHZ, floorY);
    buildCueRack(wallHX, floorY);
    buildSconces(wallHZ, floorY);
    buildNeon(floorY);
  }

  // 灰泥墙的细纹：纯色大平面在透视里像一块塑料板，加一点竖向壁纸纹理
  function wallTexture() {
    const s = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, s, s);
    // 细竖条 + 轻微噪点，远看是墙纸，近看有织理
    for (let x = 0; x < s; x += 12) {
      g.fillStyle = 'rgba(0,0,0,0.045)';
      g.fillRect(x, 0, 2, s);
    }
    const img = g.getImageData(0, 0, s, s);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 10;
      img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
      img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
      img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(8, 4);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  // 程序化海报：不做外部图片，画几张台球厅会挂的东西
  function posterTexture(kind) {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 640;
    const g = cv.getContext('2d');
    if (kind === 0) {
      g.fillStyle = '#101a13'; g.fillRect(0, 0, 512, 640);
      g.fillStyle = '#d8b25a'; g.font = 'bold 120px serif';
      g.textAlign = 'center'; g.fillText('147', 256, 170);
      g.font = '28px serif'; g.fillStyle = '#cfd8cf';
      g.fillText('A PERFECT BREAK', 256, 230);
      g.strokeStyle = '#6f8f6f'; g.lineWidth = 6;
      g.beginPath(); g.arc(256, 420, 120, 0, Math.PI * 2); g.stroke();
      const cols = ['#d33', '#e8b', '#39c', '#db3', '#3a3', '#742'];
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2;
        g.fillStyle = cols[i];
        g.beginPath(); g.arc(256 + Math.cos(a) * 72, 420 + Math.sin(a) * 72, 26, 0, Math.PI * 2); g.fill();
      }
    } else if (kind === 1) {
      g.fillStyle = '#241a14'; g.fillRect(0, 0, 512, 640);
      g.fillStyle = '#c8a45a';
      for (let i = 0; i < 9; i++) {
        g.globalAlpha = 0.16 + (i % 3) * 0.08;
        g.beginPath(); g.arc(90 + i * 44, 160 + (i % 4) * 70, 54, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
      g.fillStyle = '#eee3c8'; g.font = 'bold 54px sans-serif'; g.textAlign = 'center';
      g.fillText('LATE', 256, 470); g.fillText('SESSION', 256, 535);
      g.font = '22px sans-serif'; g.fillStyle = '#c8a45a';
      g.fillText('EVERY FRIDAY · 9 PM', 256, 590);
    } else {
      g.fillStyle = '#162019'; g.fillRect(0, 0, 512, 640);
      g.strokeStyle = '#8aa07a'; g.lineWidth = 4;
      g.strokeRect(34, 34, 444, 572);
      g.fillStyle = '#e8e2cf'; g.textAlign = 'center';
      g.font = 'bold 40px serif';
      g.fillText('TABLE', 256, 180);
      g.fillText('RULES', 256, 230);
      g.font = '22px serif'; g.fillStyle = '#b8c4ad';
      const lines = ['Red first', 'Then colour', 'Call the pocket', 'Chalk is free'];
      for (let i = 0; i < lines.length; i++) g.fillText(lines[i], 256, 320 + i * 54);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  function buildWallArt(wallHX, wallHZ, floorY) {
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a1b10, roughness: 0.55 });
    const frameMat2 = new THREE.MeshStandardMaterial({ color: 0x8a6a32, roughness: 0.38, metalness: 0.4 });

    function art(x, y, z, ry, w, h, kind, brass) {
      const g = new THREE.Group();
      const frame = new THREE.Mesh(
        new THREE.BoxGeometry(w + 34, h + 34, 16),
        brass ? frameMat2 : frameMat
      );
      frame.castShadow = true;
      g.add(frame);
      const pic = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshStandardMaterial({ map: posterTexture(kind), roughness: 0.82 })
      );
      pic.position.z = 9;
      g.add(pic);
      g.position.set(x, y, z);
      g.rotation.y = ry;
      scene.add(g);
    }

    // +X 墙（默认轨道机位的左侧）
    art(wallHX - 12, floorY + 980, -900, -Math.PI / 2, 320, 400, 0, true);
    art(wallHX - 12, floorY + 1020, 900, -Math.PI / 2, 380, 300, 1, false);
    // -Z 墙（正对默认机位的那面）
    art(-1400, floorY + 1010, -wallHZ + 12, 0, 300, 380, 2, false);
    art(1400, floorY + 990, -wallHZ + 12, 0, 360, 280, 1, true);
    // -X 墙窗左侧
    art(-wallHX + 12, floorY + 1010, -1750, Math.PI / 2, 280, 350, 0, false);
    // +Z 墙后吧台两侧：原来是一整块空白灰泥，挂两幅大画压住
    art(-1900, floorY + 1020, wallHZ - 12, Math.PI, 380, 300, 1, false);
    art(1900, floorY + 1020, wallHZ - 12, Math.PI, 320, 400, 0, true);
    // 两侧墙靠吧台的一端：默认轨道机位里正好是两块大空白
    art(wallHX - 12, floorY + 980, 1350, -Math.PI / 2, 340, 260, 2, false);
    art(-wallHX + 12, floorY + 980, 1350, Math.PI / 2, 300, 380, 1, true);

    // 挂钟：+X 墙靠后
    makeClock(wallHX - 12, floorY + 1120, -1980, -Math.PI / 2);
    // 飞镖盘：台球厅的常见墙面装饰，也打破一整片灰泥
    makeDartboard(wallHX - 12, floorY + 1120, 1700, -Math.PI / 2);
  }

  function makeDartboard(x, y, z, ry) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const g = cv.getContext('2d');
    const cx = 128, cy = 128;
    const rings = [
      [122, '#2b2118'], [112, '#c9b98e'], [92, '#1d1d1d'],
      [78, '#b23a2e'], [64, '#1f6b3a'], [44, '#1d1d1d'],
      [34, '#b23a2e'], [22, '#1f6b3a'], [12, '#c9b98e'],
    ];
    for (const [r, col] of rings) {
      g.fillStyle = col;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    }
    // 20 个扇区线
    g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = 1.4;
    for (let i = 0; i < 20; i++) {
      const a = i / 20 * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * 22, cy + Math.sin(a) * 22);
      g.lineTo(cx + Math.cos(a) * 112, cy + Math.sin(a) * 112);
      g.stroke();
    }
    g.fillStyle = '#1d1d1d';
    g.beginPath(); g.arc(cx, cy, 7, 0, Math.PI * 2); g.fill();
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;

    const group = new THREE.Group();
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(124, 9, 8, 32),
      new THREE.MeshStandardMaterial({ color: 0x2a1b10, roughness: 0.6 })
    );
    group.add(rim);
    const face = new THREE.Mesh(
      new THREE.CircleGeometry(122, 36),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 })
    );
    face.position.z = 4;
    group.add(face);

    // 两支插在靶上的飞镖：金属杆 + 红/黑尾翼
    function makeDart(dx, dy, rz, flightColor) {
      const g = new THREE.Group();
      const steel = new THREE.MeshStandardMaterial({ color: 0xc8c8c0, roughness: 0.25, metalness: 0.85 });
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 30, 8), steel);
      shaft.rotation.x = Math.PI / 2;
      shaft.position.z = 20;
      g.add(shaft);
      const point = new THREE.Mesh(new THREE.ConeGeometry(1.2, 8, 8), steel);
      point.rotation.x = -Math.PI / 2;
      point.position.z = 4;
      g.add(point);
      const flightMat = new THREE.MeshStandardMaterial({ color: flightColor, roughness: 0.7, side: THREE.DoubleSide });
      const f1 = new THREE.Mesh(new THREE.PlaneGeometry(14, 9), flightMat);
      f1.position.z = 35; f1.rotation.y = Math.PI / 2;
      g.add(f1);
      const f2 = new THREE.Mesh(new THREE.PlaneGeometry(9, 14), flightMat);
      f2.position.z = 35;
      g.add(f2);
      g.position.set(dx, dy, 2);
      g.rotation.z = rz;
      group.add(g);
    }
    makeDart(38, -22, 0.35, 0xd23a2e);
    makeDart(-52, 31, -0.55, 0x2a7a4a);

    group.position.set(x, y, z);
    group.rotation.y = ry;
    scene.add(group);
  }

  function drawClockFace(g, date) {
    g.clearRect(0, 0, 256, 256);
    g.fillStyle = '#e9e1cc'; g.beginPath(); g.arc(128, 128, 124, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2a2118'; g.font = 'bold 22px serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      g.fillText(String(i === 0 ? 12 : i), 128 + Math.cos(a) * 94, 128 + Math.sin(a) * 94);
    }
    const h = date.getHours() % 12, m = date.getMinutes(), s = date.getSeconds();
    const ah = (h + m / 60) / 12 * Math.PI * 2 - Math.PI / 2;
    const am = (m + s / 60) / 60 * Math.PI * 2 - Math.PI / 2;
    const as = s / 60 * Math.PI * 2 - Math.PI / 2;
    g.lineCap = 'round';
    g.strokeStyle = '#2a2118';
    g.lineWidth = 9;
    g.beginPath(); g.moveTo(128, 128); g.lineTo(128 + Math.cos(ah) * 58, 128 + Math.sin(ah) * 58); g.stroke();
    g.lineWidth = 5;
    g.beginPath(); g.moveTo(128, 128); g.lineTo(128 + Math.cos(am) * 88, 128 + Math.sin(am) * 88); g.stroke();
    g.strokeStyle = '#b23a2e'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(128, 128); g.lineTo(128 + Math.cos(as) * 96, 128 + Math.sin(as) * 96); g.stroke();
    g.fillStyle = '#8a6a32'; g.beginPath(); g.arc(128, 128, 8, 0, Math.PI * 2); g.fill();
  }

  function makeClock(x, y, z, ry) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const g = cv.getContext('2d');
    drawClockFace(g, new Date());
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    clockFace = { cv: cv, ctx: g, tex: tex, sec: new Date().getSeconds() };

    const ggroup = new THREE.Group();
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(128, 12, 10, 40),
      new THREE.MeshStandardMaterial({ color: 0x8a6a32, roughness: 0.35, metalness: 0.55 })
    );
    ggroup.add(rim);
    const face = new THREE.Mesh(
      new THREE.CircleGeometry(124, 40),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 })
    );
    face.position.z = 3;
    ggroup.add(face);
    ggroup.position.set(x, y, z);
    ggroup.rotation.y = ry;
    scene.add(ggroup);
  }

  // 墙上的球杆架：三根竖放的杆 + 黄铜托
  function buildCueRack(wallHX, floorY) {
    const x = wallHX - 14, z = -1500;
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(16, 1120, 380),
      new THREE.MeshStandardMaterial({ map: woodTexture(3, 1), color: 0x412816, roughness: 0.6 })
    );
    board.position.set(x, floorY + 690, z);
    scene.add(board);

    const brass = new THREE.MeshStandardMaterial({ color: 0x9a7a3a, roughness: 0.4, metalness: 0.5 });
    for (const dz of [-120, 0, 120]) {
      const cue = new THREE.Mesh(
        new THREE.CylinderGeometry(3.2, 5.2, 1060, 10),
        new THREE.MeshStandardMaterial({ color: 0xb98a4e, roughness: 0.4 })
      );
      cue.position.set(x - 18, floorY + 700, z + dz);
      cue.rotation.z = 0.012 * (dz / 120);
      cue.castShadow = true;
      scene.add(cue);

      const tip = new THREE.Mesh(
        new THREE.CylinderGeometry(3.2, 3.2, 12, 10),
        new THREE.MeshStandardMaterial({ color: 0x2b5a78, roughness: 0.75 })
      );
      tip.position.set(x - 18 - Math.sin(0.012 * (dz / 120)) * 530, floorY + 1236, z + dz);
      scene.add(tip);

      for (const yy of [floorY + 340, floorY + 1040]) {
        const clip = new THREE.Mesh(new THREE.TorusGeometry(11, 3.5, 8, 14), brass);
        clip.rotation.x = Math.PI / 2;
        clip.position.set(x - 18, yy, z + dz);
        scene.add(clip);
      }
    }
  }

  // 壁灯：两盏，暖色小光池；灯罩自发光，PointLight 只照附近
  function buildSconces(wallHZ, floorY) {
    const brass = new THREE.MeshStandardMaterial({ color: 0x9a7a3a, roughness: 0.4, metalness: 0.55 });
    const shadeMat = new THREE.MeshStandardMaterial({
      color: 0x3a2a1a, roughness: 0.55, side: THREE.DoubleSide,
      emissive: 0xffa850, emissiveIntensity: 0.55,
    });
    // 避开墙上的海报（海报中心在 x=±1400），挪到两侧靠边位置
    for (const sx of [-2200, 2200]) {
      const g = new THREE.Group();
      const plate = new THREE.Mesh(new THREE.BoxGeometry(110, 150, 14), brass);
      plate.position.z = 8;
      g.add(plate);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 150, 10), brass);
      arm.rotation.x = Math.PI / 2;
      arm.position.set(0, 20, 90);
      g.add(arm);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(46, 86, 72, 18, 1, true), shadeMat);
      shade.position.set(0, 30, 170);
      g.add(shade);
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(15, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0xffd9a0 })
      );
      bulb.position.set(0, 24, 170);
      g.add(bulb);

      // 不再加真实光源：MeshStandardMaterial 每多一盏灯，所有材质都要多算一轮。
      // 灯罩和灯泡本身是自发光，远处看已经够"亮"了。
      g.position.set(sx, floorY + 900, -wallHZ + 6);
      scene.add(g);
    }
  }

  // 后吧台上方的霓虹 "147"：自发光面片 + 一盏很弱的红色点光
  function buildNeon(floorY) {
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 320;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, 1024, 320);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = '#ff5a3a'; g.shadowBlur = 34;
    g.strokeStyle = '#ff7a52'; g.lineWidth = 10;
    g.strokeRect(190, 36, 644, 248);
    g.fillStyle = '#ffd0a0'; g.font = 'bold 190px serif';
    g.fillText('147', 512, 168);
    g.shadowBlur = 10;
    g.fillStyle = '#ff9a6a'; g.font = 'bold 42px sans-serif';
    g.fillText('S N O O K E R', 512, 292);
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;

    neonSign = new THREE.Mesh(
      new THREE.PlaneGeometry(1250, 320),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.92, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      })
    );
    // 不挂在后墙上（会被酒架和瓶子挡住），改成**悬挂在后吧台前方**的霓虹灯牌。
    // 两根细吊绳接到天花板，牌子正对室内，轨道机位一眼能看到。
    const signY = floorY + 1000;
    neonSign.position.set(0, signY, 1900);
    neonSign.rotation.y = Math.PI;
    scene.add(neonSign);

    const cordMat = new THREE.MeshStandardMaterial({ color: 0x14121a, roughness: 0.8 });
    for (const cx of [-520, 520]) {
      const cord = new THREE.Mesh(
        new THREE.CylinderGeometry(1.6, 1.6, CEIL_Y - (signY + 160), 6),
        cordMat
      );
      cord.position.set(cx, (CEIL_Y + signY + 160) / 2, 1900);
      scene.add(cord);
    }

    neonLight = new THREE.PointLight(0xff6a3a, neonBase, 1300, 2);
    neonLight.position.set(0, signY - 40, 1850);
    scene.add(neonLight);
  }

  // 浮尘：Points 一次 draw call，只在透视机里明显，俯视时几乎看不见
  function buildDust() {
    const n = 260;
    const pos = new Float32Array(n * 3);
    dustData = new Float32Array(n * 6);          // [baseX, baseZ, baseY, speed, phase, drift]
    for (let i = 0; i < n; i++) {
      const bx = (Math.random() - 0.5) * 5200;
      const bz = (Math.random() - 0.5) * 4400;
      const by = FLOOR_Y + 100 + Math.random() * (WALL_H - 200);
      pos[i * 3] = bx;
      pos[i * 3 + 1] = by;
      pos[i * 3 + 2] = bz;
      dustData[i * 6] = bx;
      dustData[i * 6 + 1] = bz;
      dustData[i * 6 + 2] = by;
      dustData[i * 6 + 3] = 5 + Math.random() * 16;
      dustData[i * 6 + 4] = Math.random() * Math.PI * 2;
      dustData[i * 6 + 5] = 4 + Math.random() * 14;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffe6c0, size: 2.4, transparent: true, opacity: 0.28,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    dust = new THREE.Points(geo, mat);
    dust.frustumCulled = false;
    scene.add(dust);
  }

  // ================================================================
  //  休闲区家具（第八轮起，第十轮扩充）：吧台 + 吧凳 + 咖啡桌 + 椅子 + 酒杯
  //
  //  全部用 three.js 自带图元拼（Box / Cylinder / Torus / Lathe），零外部模型：
  //  椅子是盒子拼的，桌腿是圆柱，酒杯与酒瓶是 LatheGeometry 车削 ——
  //  剖面用 Vector2 绕 Y 轴旋一圈，这是 three.js 官方文档里酒杯/酒瓶的
  //  标准做法（LatheGeometry 的典型用例就是花瓶、酒杯、瓶子）。
  //  远处家具不做真实投影：主光的 shadow camera 只罩住台面附近，
  //  所以统一铺一层半透明圆片/矩形当假接触阴影，避免“浮空”。
  //
  //  位置全部在正交俯视视野（W×H）之外，手打瞄准时看不到，也不会挡台；
  //  默认的 3D Orbit 机位从 -Z 方向看过来，+Z 侧的吧台正好当背景。
  //  比例尺：C.SCALE ≈ 0.381 px/mm，即 1000px ≈ 2.6m。
  // ================================================================
  function buildSideFurniture() {
    const floorY = FLOOR_Y + 1;

    // ---------- 材质（全屋共用，别为每个物件新建） ----------
    const woodMat = new THREE.MeshStandardMaterial({
      map: woodTexture(2, 1), color: 0x5a3420, roughness: 0.62,
    });
    const darkWood = new THREE.MeshStandardMaterial({
      map: woodTexture(2, 1), color: 0x3d2314, roughness: 0.66,
    });
    const counterWood = new THREE.MeshStandardMaterial({
      map: woodTexture(3, 1), color: 0x6b3d22, roughness: 0.55,
    });
    const backMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 0.88 });
    const fabricMat = new THREE.MeshStandardMaterial({ color: 0x5c2026, roughness: 0.92 });
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xb08a45, roughness: 0.32, metalness: 0.75 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xdfeee8, roughness: 0.06, metalness: 0.05,
      transparent: true, opacity: 0.30, side: THREE.DoubleSide, depthWrite: false,
    });
    const wineMat = new THREE.MeshStandardMaterial({
      color: 0x7d1224, roughness: 0.25, transparent: true, opacity: 0.88,
    });
    const candleMat = new THREE.MeshStandardMaterial({
      color: 0xffcf8a, emissive: 0xffa040, emissiveIntensity: 0.9, roughness: 0.5,
    });
    // 酒瓶颜色：绿/琥珀/深紫/香槟金，再加两支透明感和一支蓝色利口酒。
    // 颜色多了，三层酒架才不像同一批货复制出来的。
    const bottleMats = [
      new THREE.MeshStandardMaterial({ color: 0x1d4a2a, roughness: 0.22, metalness: 0.08 }),
      new THREE.MeshStandardMaterial({ color: 0x6a3a10, roughness: 0.25, metalness: 0.08 }),
      new THREE.MeshStandardMaterial({ color: 0x2b2338, roughness: 0.20, metalness: 0.12 }),
      new THREE.MeshStandardMaterial({ color: 0x8a6a1a, roughness: 0.28, metalness: 0.10 }),
      new THREE.MeshStandardMaterial({ color: 0x9a8a5a, roughness: 0.18, metalness: 0.06, transparent: true, opacity: 0.78 }),
      new THREE.MeshStandardMaterial({ color: 0x1b4b6a, roughness: 0.22, metalness: 0.10 }),
      new THREE.MeshStandardMaterial({ color: 0x5a1418, roughness: 0.26, metalness: 0.08 }),
      new THREE.MeshStandardMaterial({ color: 0x3a4a2a, roughness: 0.20, metalness: 0.08 }),
    ];
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.26, depthWrite: false,
    });

    // 假接触阴影：圆片给椅子/凳子/小桌，矩形给吧台。
    function contact(x, z, r, op) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(r, 24), shadowMat.clone());
      m.material.opacity = op == null ? 0.26 : op;
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, floorY + 1.6, z);
      m.renderOrder = 1;
      scene.add(m);
    }
    function contactRect(x, z, w, d, op) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), shadowMat.clone());
      m.material.opacity = op == null ? 0.22 : op;
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, floorY + 1.6, z);
      m.renderOrder = 1;
      scene.add(m);
    }

    function add(mesh, x, y, z, ry, noShadow) {
      mesh.position.set(x, y, z);
      if (ry) mesh.rotation.y = ry;
      mesh.castShadow = !noShadow;
      mesh.receiveShadow = !noShadow;
      scene.add(mesh);
      return mesh;
    }

    // ---------- 椅子：座面 + 四条腿 + 靠背（朝本地 -X） ----------
    // 上一版座面高 430px≈1.1m、靠背再高 520px，整把椅子 2.5m —— 太高太细。
    // 现在按真实比例：座面 190px≈0.5m，靠背顶 375px≈0.98m，腿 22px≈6cm。
    //
    // 性能：每把椅子 11 个网格 × 6 把 = 66 次 draw call。改成**按部件分批
    // InstancedMesh**（座面/坐垫/椅腿/靠背柱/横档各 1 次），总共约 7 次。
    const chairSpecs = [];
    function makeChair(x, z, ry) {
      chairSpecs.push({ x: x, z: z, ry: ry });
      contact(x, z, 130, 0.20);
    }

    function buildChairs() {
      const seatH = 190, seatW = 200, seatD = 210, legT = 22;
      const specs = chairSpecs;
      if (!specs.length) return;
      const base = specs.map(s => new THREE.Matrix4()
        .makeTranslation(s.x, floorY, s.z)
        .multiply(new THREE.Matrix4().makeRotationY(s.ry)));

      function parts(geo, mat, locals, cast) {
        const m = new THREE.InstancedMesh(geo, mat, specs.length * locals.length);
        let k = 0;
        for (let i = 0; i < specs.length; i++) {
          for (let j = 0; j < locals.length; j++) {
            const local = new THREE.Matrix4().makeTranslation(locals[j][0], locals[j][1], locals[j][2]);
            m.setMatrixAt(k++, base[i].clone().multiply(local));
          }
        }
        m.instanceMatrix.needsUpdate = true;
        m.castShadow = !!cast;
        m.receiveShadow = true;
        scene.add(m);
      }

      parts(new THREE.BoxGeometry(seatD, 22, seatW), woodMat, [[0, seatH, 0]], true);
      parts(new THREE.BoxGeometry(seatD - 16, 12, seatW - 16), fabricMat, [[0, seatH + 17, 0]], true);
      const legs = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        legs.push([sx * (seatD / 2 - 16), seatH / 2, sz * (seatW / 2 - 16)]);
      }
      parts(new THREE.BoxGeometry(legT, seatH, legT), darkWood, legs, true);
      // 靠背在本地 +X，坐在椅子上的人面朝 -X（由 ry 转到面向桌子）
      parts(new THREE.BoxGeometry(22, 180, 22), darkWood, [
        [seatD / 2 - 14, seatH + 90, -(seatW / 2 - 14)],
        [seatD / 2 - 14, seatH + 90, (seatW / 2 - 14)],
      ], true);
      parts(new THREE.BoxGeometry(18, 44, seatW - 12), woodMat, [[seatD / 2 - 14, seatH + 168, 0]], true);
      parts(new THREE.BoxGeometry(14, 22, seatW - 60), darkWood, [[seatD / 2 - 14, seatH + 96, 0]], true);
    }

    // 椅子摆到桌子周围：a 是椅子相对桌心的极角
    function chairAtTable(cx, cz, tableR, a) {
      const x = cx + Math.cos(a) * tableR;
      const z = cz + Math.sin(a) * tableR;
      const dx = cx - x, dz = cz - z;
      // 本地 -X 经 rotY 后 → (-cosθ, 0, sinθ)，令它朝向桌心
      makeChair(x, z, Math.atan2(dz, -dx));
    }

    // ---------- 酒杯 / 酒瓶：LatheGeometry 车削 ----------
    const glassGeo = new THREE.LatheGeometry(
      [
        [0, 0], [30, 0], [32, 3], [9, 8], [5.5, 18], [5.5, 50],
        [8, 56], [24, 63], [30, 76], [27, 88], [23, 94],
      ].map(p => new THREE.Vector2(p[0], p[1])), 20
    );
    const wineGeo = new THREE.LatheGeometry(
      [[0, 50], [17, 50], [23, 61], [20, 68], [0, 68]]
        .map(p => new THREE.Vector2(p[0], p[1])), 18
    );
    function makeGlass(x, y, z, s) {
      const g = new THREE.Mesh(glassGeo, glassMat);
      g.position.set(x, y, z);
      g.scale.setScalar(s || 1);
      g.renderOrder = 3;
      scene.add(g);
      const w = new THREE.Mesh(wineGeo, wineMat);
      w.position.copy(g.position);
      w.scale.copy(g.scale);
      w.renderOrder = 2;
      scene.add(w);
    }

    // 三种瓶型：葡萄酒瓶（高肩）、烈酒瓶（方肩短颈）、啤酒瓶（细长）
    const bottleGeos = [
      new THREE.LatheGeometry(
        [
          [0, 0], [16, 0], [18, 5], [18, 58], [16, 70], [10, 78],
          [7, 88], [7, 104], [9, 108], [7, 112], [0, 112],
        ].map(p => new THREE.Vector2(p[0], p[1])), 16
      ),
      new THREE.LatheGeometry(
        [
          [0, 0], [19, 0], [21, 5], [21, 64], [19, 72], [9, 82],
          [7, 92], [10, 98], [7, 102], [0, 102],
        ].map(p => new THREE.Vector2(p[0], p[1])), 14
      ),
      new THREE.LatheGeometry(
        [
          [0, 0], [12, 0], [14, 4], [14, 78], [12, 88], [7, 96],
          [6, 116], [8, 120], [6, 124], [0, 124],
        ].map(p => new THREE.Vector2(p[0], p[1])), 12
      ),
    ];
    function makeBottle(x, y, z, s, mi, ry, tilt, geoIdx) {
      const b = new THREE.Mesh(
        bottleGeos[geoIdx === undefined ? (mi % bottleGeos.length) : geoIdx],
        bottleMats[mi % bottleMats.length]
      );
      b.position.set(x, y, z);
      b.scale.setScalar(s || 1);
      b.rotation.y = ry || 0;
      if (tilt) b.rotation.z = tilt;
      b.castShadow = true;
      scene.add(b);
      return b;
    }

    // 架子上的小酒杯：非对称摆放，别像阅兵
    function shelfGlass(x, y, z, s) {
      const g = new THREE.Mesh(glassGeo, glassMat);
      g.position.set(x, y, z);
      g.scale.setScalar(s || 1);
      g.renderOrder = 3;
      scene.add(g);
    }

    // ---------- 咖啡小圆桌（桌面 310px≈0.8m，椅子 0.5m 正好） ----------
    function makeCafeTable(cx, cz, a0, noCandle) {
      const topY = floorY + 310;
      contact(cx, cz, 155, 0.20);

      add(new THREE.Mesh(new THREE.CylinderGeometry(130, 130, 18, 28), counterWood), cx, topY, cz);
      add(new THREE.Mesh(new THREE.CylinderGeometry(116, 116, 22, 24), darkWood), cx, topY - 20, cz);
      add(new THREE.Mesh(new THREE.CylinderGeometry(14, 18, 270, 14), darkWood), cx, floorY + 135, cz);
      add(new THREE.Mesh(new THREE.CylinderGeometry(64, 72, 14, 20), darkWood), cx, floorY + 7, cz);

      // 杯垫 + 两支酒杯 + 小烛台
      const matY = topY + 9;
      for (const off of [-70, 70]) {
        add(new THREE.Mesh(new THREE.CylinderGeometry(34, 34, 3, 16), darkWood),
            cx + off, matY + 1, cz + 28, 0, true);
        makeGlass(cx + off, matY + 3, cz + 28, 0.82);
      }
      if (!noCandle) {
        add(new THREE.Mesh(new THREE.CylinderGeometry(9, 11, 22, 12), brassMat), cx, matY + 11, cz - 38);
        const flame = add(new THREE.Mesh(new THREE.SphereGeometry(8, 10, 8), candleMat),
            cx, matY + 30, cz - 38, 0, true);
        // 火苗单独记下来做轻微伸缩；材质是共享的，所以只动 transform
        candleFlames.push({ m: flame, baseX: cx, baseY: matY + 30, phase: Math.random() * Math.PI * 2 });
      }

      chairAtTable(cx, cz, 250, a0);
      chairAtTable(cx, cz, 250, a0 + 2.9);
    }

    // ---------- 靠窗那张：圆桌 + 花瓶 + 两把椅子 ----------
    const tx = W / 2 + 330, tz = -H / 2 - 240;   // ≈ 1038, -608
    makeCafeTable(tx, tz, 1.05, true);          // 这张桌放花瓶，不放烛台，避免重叠

    const topY = floorY + 310;
    const vaseProfile = [
      [0, 0], [30, 0], [38, 10], [46, 44], [42, 82], [27, 112],
      [19, 128], [22, 140], [19, 152],
    ].map(p => new THREE.Vector2(p[0], p[1]));
    const vaseMat = new THREE.MeshStandardMaterial({
      color: 0x6f9a86, roughness: 0.35, metalness: 0.15,
    });
    add(new THREE.Mesh(new THREE.LatheGeometry(vaseProfile, 28), vaseMat), tx, topY + 9, tz);

    // 花：几根细茎 + 小花头
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x3a6b3a, roughness: 0.8 });
    const petalCols = [0xd98a8a, 0xe8d17a, 0xc9a7d8, 0xf0efe4];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      const lean = 10 + (i % 3) * 5;
      const h = 58 + (i % 2) * 18;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.6, h, 6), stemMat);
      stem.position.set(tx + Math.cos(a) * lean * 0.5, topY + 159 + h / 2 - 10, tz + Math.sin(a) * lean * 0.5);
      stem.rotation.z = Math.cos(a) * 0.12;
      stem.rotation.x = -Math.sin(a) * 0.12;
      scene.add(stem);

      const head = new THREE.Mesh(
        new THREE.SphereGeometry(6.5, 10, 8),
        new THREE.MeshStandardMaterial({ color: petalCols[i % petalCols.length], roughness: 0.55 })
      );
      head.position.set(
        tx + Math.cos(a) * lean,
        topY + 159 + h - 6,
        tz + Math.sin(a) * lean
      );
      head.castShadow = true;
      scene.add(head);
    }

    // ---------- 另外两桌（都在正交视野外） ----------
    makeCafeTable(-1180, -650, 0.55);
    makeCafeTable(-1200, 700, 1.65);

    // ---------- 生活细节：盆栽、蜡烛青烟、偶尔的苍蝇 ----------
    // 参考 three.js 社区常见的 "wind sway + particle smoke + bezier fly" 做法，
    // 但这里只用基本图元，不引外部模型/贴图。
    function buildPlant(px, pz) {
      const potMat = new THREE.MeshStandardMaterial({ color: 0x5b3b2a, roughness: 0.82 });
      const soilMat = new THREE.MeshStandardMaterial({ color: 0x24170f, roughness: 1 });
      const leafMat = new THREE.MeshStandardMaterial({
        color: 0x3d6b3a, roughness: 0.78, side: THREE.DoubleSide,
      });
      const root = new THREE.Group();
      root.position.set(px, floorY, pz);
      ceilingVis.push(root);            // 俯视时藏掉，避免挡台面
      scene.add(root);

      const pot = new THREE.Mesh(new THREE.CylinderGeometry(46, 34, 74, 18), potMat);
      pot.position.y = 37;
      pot.castShadow = true; pot.receiveShadow = true;
      root.add(pot);
      const soil = new THREE.Mesh(new THREE.CylinderGeometry(40, 40, 5, 18), soilMat);
      soil.position.y = 75;
      root.add(soil);

      // 单片草叶：底部收窄、顶部尖，绕基点摆动
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.quadraticCurveTo(8, 42, 2, 126);
      shape.quadraticCurveTo(-1, 70, -7, 0);
      shape.lineTo(0, 0);
      const bladeGeo = new THREE.ShapeGeometry(shape, 6);
      for (let i = 0; i < 26; i++) {
        const m = new THREE.Mesh(bladeGeo, leafMat);
        const a = Math.random() * Math.PI * 2;
        const rr = Math.random() * 24;
        m.position.set(Math.cos(a) * rr, 76, Math.sin(a) * rr);
        m.rotation.y = Math.random() * Math.PI * 2;
        const lean = (Math.random() - 0.5) * 0.5;
        m.rotation.z = lean;
        m.castShadow = false;
        root.add(m);
        plantBlades.push({
          m: m, lean: lean, phase: Math.random() * Math.PI * 2,
          amp: 0.018 + Math.random() * 0.022,
        });
      }
    }

    // 青烟贴图：中心亮、边缘透明的软圆
    function smokeTexture() {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const g = cv.getContext('2d');
      const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
      grad.addColorStop(0, 'rgba(220,220,215,0.55)');
      grad.addColorStop(0.45, 'rgba(190,190,185,0.18)');
      grad.addColorStop(1, 'rgba(180,180,175,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      const tex = new THREE.CanvasTexture(cv);
      tex.encoding = THREE.sRGBEncoding;
      return tex;
    }

    function buildCandleSmoke() {
      const tex = smokeTexture();
      const root = new THREE.Group();
      ceilingVis.push(root);
      scene.add(root);
      for (let i = 0; i < candleFlames.length; i++) {
        const f = candleFlames[i];
        for (let k = 0; k < 7; k++) {
          const mat = new THREE.SpriteMaterial({
            map: tex, color: 0xcccccc, transparent: true, opacity: 0,
            depthWrite: false,
          });
          const s = new THREE.Sprite(mat);
          s.scale.set(5, 5, 1);
          s.position.set(f.m.position.x, f.m.position.y + 10, f.m.position.z);
          root.add(s);
          smokePuffs.push({
            s: s, baseX: f.m.position.x, baseY: f.m.position.y + 8,
            baseZ: f.m.position.z,
            phase: Math.random() * 1.6, dur: 2.8 + Math.random() * 1.8,
            drift: 4 + Math.random() * 7,
          });
        }
      }
    }

    function buildFly() {
      flyRoot = new THREE.Group();
      ceilingVis.push(flyRoot);
      scene.add(flyRoot);
      flyGroup = new THREE.Group();
      flyGroup.visible = false;
      flyRoot.add(flyGroup);

      const body = new THREE.Mesh(
        new THREE.SphereGeometry(2.8, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0x17140f, roughness: 0.55 })
      );
      body.scale.set(0.85, 0.7, 1.45);
      flyGroup.add(body);

      const wingMat = new THREE.MeshBasicMaterial({
        color: 0x9aa09a, transparent: true, opacity: 0.38,
        side: THREE.DoubleSide, depthWrite: false,
      });
      for (const sx of [-1, 1]) {
        const w = new THREE.Mesh(new THREE.PlaneGeometry(7, 3.4), wingMat);
        w.position.set(sx * 3.2, 1.4, 0);
        w.rotation.y = sx * 0.35;
        flyGroup.add(w);
        flyWings.push({ m: w, side: sx });
      }
      flyGroup.userData = {
        target: new THREE.Vector3(0, 420, 0),
        speed: 95, next: 0,
        showUntil: 0, hideUntil: 6 + Math.random() * 10,
      };
    }

    buildPlant(-2380, 1260);
    buildCandleSmoke();
    buildFly();

    buildChairs();          // 所有椅子登记完，一次性提交 InstancedMesh

    // ================================================================
    //  吧台：+Z 侧，默认 3D Orbit 机位正对它
    //  比例：吧台高 440px≈1.15m、深 360px≈0.94m、长 2500px≈6.5m
    // ================================================================
    const barLen = 2500, barDepth = 360, barH = 440, barZ = 1650;
    const barTopY = floorY + barH;
    const backZ = 2300;                      // 后吧台，和主吧台之间留 ~1.1m 过道

    contactRect(0, barZ, barLen + 160, barDepth + 260, 0.22);

    // 台面 / 前板 / 两侧板
    add(new THREE.Mesh(new THREE.BoxGeometry(barLen + 80, 36, barDepth + 40), counterWood),
        0, barTopY, barZ);
    add(new THREE.Mesh(new THREE.BoxGeometry(barLen, barH - 40, 34), darkWood),
        0, floorY + (barH - 40) / 2, barZ - barDepth / 2 + 20);
    for (const sx of [-1, 1]) {
      add(new THREE.Mesh(new THREE.BoxGeometry(34, barH - 40, barDepth - 40), darkWood),
          sx * (barLen / 2), floorY + (barH - 40) / 2, barZ);
    }

    // 前脸竖条：一整块板太死，竖条有节奏
    const slatGeo = new THREE.BoxGeometry(26, barH - 90, 14);
    for (let i = -9; i <= 9; i++) {
      add(new THREE.Mesh(slatGeo, woodMat), i * 125, floorY + (barH - 40) / 2, barZ - barDepth / 2 + 2);
    }

    // 黄铜脚踏杆 + 两个支撑
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, barLen - 120, 12), brassMat);
    rail.rotation.z = Math.PI / 2;
    add(rail, 0, floorY + 130, barZ - barDepth / 2 - 44);
    for (const sx of [-1, 1]) {
      add(new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 74, 10), brassMat),
          sx * (barLen / 2 - 140), floorY + 95, barZ - barDepth / 2 - 44);
    }

    // ---- 后吧台：底柜 + 背板 + 三层酒架 ----
    add(new THREE.Mesh(new THREE.BoxGeometry(2400, 760, 260), darkWood),
        0, floorY + 380, backZ);
    add(new THREE.Mesh(new THREE.BoxGeometry(2460, 30, 300), counterWood),
        0, floorY + 775, backZ);
    add(new THREE.Mesh(new THREE.BoxGeometry(2500, 1250, 24), backMat),
        0, floorY + 625, backZ + 138);

    const shelfGeo = new THREE.BoxGeometry(2320, 18, 210);
    const glowGeo = new THREE.BoxGeometry(2240, 7, 8);
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffb066 });
    const shelfHeights = [880, 1040, 1190];
    for (let s = 0; s < shelfHeights.length; s++) {
      const sy = floorY + shelfHeights[s];
      add(new THREE.Mesh(shelfGeo, counterWood), 0, sy, backZ + 20);
      // 架下的暖色灯带：假发光，不增加真实光源
      add(new THREE.Mesh(glowGeo, glowMat), 0, sy - 10, backZ + 118, 0, true);
      // 酒瓶背后再垫一条暖色反光板：瓶子有了剪影，不会糊进后墙
      add(new THREE.Mesh(new THREE.BoxGeometry(2320, 96, 4),
        new THREE.MeshBasicMaterial({ color: 0x3a2210 })), 0, sy + 58, backZ + 112, 0, true);
      // 酒瓶：三层、疏密不一。位置/朝向/瓶型都带确定性抖动 ——
      // 用"看起来随机"而不是真随机，重开局时吧台不会整排跳位置。
      const n = 9 + (s % 3);
      const rnd = (k) => {
        const v = Math.sin((k + 1) * 12.9898 + s * 78.233) * 43758.5453;
        return v - Math.floor(v);
      };
      const used = [];
      for (let i = 0; i < n; i++) {
        let x = -980 + i * (1960 / (n - 1)) + (rnd(i * 3) - 0.5) * 44;
        // 避开已经放下的瓶子，至少留 34px 间距
        let guard = 0;
        while (used.some(u => Math.abs(u - x) < 34) && guard++ < 12) x += (x > 0 ? 22 : -22);
        used.push(x);
        const sc = 1.0 + rnd(i * 11 + s) * 0.5;
        const ry = rnd(i * 13 + s) * Math.PI * 2;
        const tilt = (rnd(i * 17 + s) - 0.5) * (i % 5 === 0 ? 0.10 : 0.035);
        const zoff = (rnd(i * 19 + s) - 0.5) * 40;
        makeBottle(x, sy + 9, backZ + 72 + zoff, sc, i + s * 2, ry, tilt);
      }
      // 每层夹一两支倒扣小杯，酒架才有使用痕迹
      shelfGlass(-860 + rnd(s * 7) * 40, sy + 9, backZ + 84, 0.9);
      shelfGlass(860 - rnd(s * 11) * 60, sy + 9, backZ + 78, 0.9);
    }

    // ---- 酒架暖光：两盏只照后吧台的点光 ----
    // 距离限制在 1700，到台面中心 >2500，所以只把酒瓶和后墙提亮，
    // 不会把台呢一起打亮。灯泡本身用很小的自发光球表示。
    for (const lx of [-620, 620]) {
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(8, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffd9a0 })
      );
      bulb.position.set(lx, floorY + 1215, backZ + 70);
      scene.add(bulb);
    }
    // 视觉上两盏灯，实际只放一盏 PointLight：MeshStandardMaterial 的每个像素
    // 都要遍历灯光列表，能省一盏是一盏；中间一盏 + 两盏自发光灯泡，观感一样。
    const shelfLight = new THREE.PointLight(0xffb070, 1.15, 1900, 2);
    shelfLight.position.set(0, floorY + 1150, backZ + 150);
    scene.add(shelfLight);
    flickerLights.push({ light: shelfLight, base: 1.15, phase: Math.random() * 6.28, amp: 0.05 });

    // ---- 吧台台面上的东西：酒杯、酒瓶、黄铜酒头 ----
    add(new THREE.Mesh(new THREE.CylinderGeometry(300, 300, 6, 24), darkWood),
        0, barTopY + 21, barZ + 20, 0, true);          // 一块深色服务垫
    for (const x of [-250, -110, 30]) {
      add(new THREE.Mesh(new THREE.CylinderGeometry(34, 34, 3, 16), darkWood),
          x, barTopY + 26, barZ + 20, 0, true);        // 杯垫
      makeGlass(x, barTopY + 27, barZ + 20, 1.0);
    }
    makeBottle(420, barTopY + 18, barZ + 10, 1.15, 1, 0.2);
    makeBottle(500, barTopY + 18, barZ + 60, 1.05, 0, 1.1);

    // 酒头：底座 + 立柱 + 手柄，纯装饰
    add(new THREE.Mesh(new THREE.CylinderGeometry(46, 52, 26, 14), brassMat),
        780, barTopY + 31, barZ + 10);
    add(new THREE.Mesh(new THREE.CylinderGeometry(16, 18, 120, 12), brassMat),
        780, barTopY + 94, barZ + 10);
    const tapHandle = new THREE.Mesh(new THREE.CylinderGeometry(7, 9, 78, 10), darkWood);
    tapHandle.rotation.z = 0.5;
    add(tapHandle, 800, barTopY + 178, barZ + 10);

    // ---- 吧台小物：水果碗 / 调酒壶 / 抹布 ----
    const bowl = new THREE.Mesh(
      new THREE.LatheGeometry(
        [[0, 0], [90, 0], [108, 18], [104, 42], [78, 64], [70, 66], [0, 66]]
          .map(p => new THREE.Vector2(p[0], p[1])), 24
      ),
      new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.42, metalness: 0.25 })
    );
    add(bowl, -620, barTopY + 24, barZ + 20);
    const fruitMat = new THREE.MeshStandardMaterial({ color: 0xd9822a, roughness: 0.72 });
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2;
      const f = new THREE.Mesh(new THREE.SphereGeometry(24, 12, 10), fruitMat);
      f.position.set(-620 + Math.cos(a) * 38, barTopY + 78 + (i % 2) * 22, barZ + 20 + Math.sin(a) * 38);
      scene.add(f);
    }
    const shaker = new THREE.Mesh(
      new THREE.CylinderGeometry(30, 36, 130, 16),
      new THREE.MeshStandardMaterial({ color: 0xb8b8b0, roughness: 0.25, metalness: 0.8 })
    );
    add(shaker, -430, barTopY + 90, barZ + 8);
    const towel = new THREE.Mesh(new THREE.BoxGeometry(120, 8, 180), fabricMat);
    add(towel, 200, barTopY + 24, barZ + 40, 0.18);

    // 一支倒下的空酒瓶：吧台不是样板间，留一点使用痕迹
    const tipped = makeBottle(980, barTopY + 34, barZ + 24, 1.1, 5, 0.4);
    tipped.rotation.z = Math.PI / 2;
    tipped.rotation.x = 0.08;

    // ---- 吧台上方的倒挂酒杯架：两排杯口朝下 ----
    for (const rx of [-500, -100, 300]) {
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 620, 8), brassMat);
      rod.rotation.z = Math.PI / 2;
      add(rod, rx, floorY + 1060, barZ + 40, 0, true);
    }
    for (let i = 0; i < 7; i++) {
      const g = new THREE.Mesh(glassGeo, glassMat);
      g.scale.setScalar(0.78);
      g.rotation.z = Math.PI;              // 杯口朝下
      g.position.set(-500 + i * 105, floorY + 1060, barZ + 40);
      g.renderOrder = 3;
      scene.add(g);
    }

    // ---- 吧凳：座面 300px≈0.78m，略低于吧台 ----
    function makeStool(x, z) {
      // ★ 腿高必须用**座面离地高度**（seatH），不能用世界坐标 seatY ——
      //   seatY 已经含 FLOOR_Y（负值），拿它算腿长会得到负高度，圆柱翻到座面上面去。
      const seatH = 300, seatY = floorY + seatH;
      const legH = seatH - 18;
      contact(x, z, 105, 0.20);
      add(new THREE.Mesh(new THREE.CylinderGeometry(70, 74, 16, 20), fabricMat), x, seatY, z);
      add(new THREE.Mesh(new THREE.CylinderGeometry(74, 70, 10, 20), darkWood), x, seatY - 13, z);
      const legGeo = new THREE.CylinderGeometry(8, 10, legH, 8);
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + Math.PI / 4;
        const leg = new THREE.Mesh(legGeo, darkWood);
        leg.position.set(x + Math.cos(a) * 46, floorY + legH / 2, z + Math.sin(a) * 46);
        leg.castShadow = true;
        scene.add(leg);
      }
      const ring = new THREE.Mesh(new THREE.TorusGeometry(56, 4.5, 8, 20), brassMat);
      ring.rotation.x = Math.PI / 2;
      add(ring, x, floorY + 100, z);
    }
    // 四张凳子不要排成一条线：有的推进去、有的歪一点、有的离远一点
    for (let i = 0; i < 4; i++) {
      const x = -780 + i * 520 + (i % 2 ? 26 : -16);
      const z = barZ - 300 + (i === 1 ? 34 : (i === 3 ? -22 : 0));
      makeStool(x, z);
    }

    // ---- 吧台上方两盏小吊灯：灯罩自发光 + 低强度点光（距离限制在吧台区） ----
    const shadeMat = new THREE.MeshStandardMaterial({
      color: 0x3a2a1a, roughness: 0.5, side: THREE.DoubleSide,
      emissive: 0xffa850, emissiveIntensity: 0.55,
    });
    const shadeGeo = new THREE.CylinderGeometry(64, 118, 96, 20, 1, true);
    for (const x of [-680, 680]) {
      add(new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 520, 6), brassMat),
          x, floorY + 1490, barZ, 0, true);                    // 吊绳
      add(new THREE.Mesh(shadeGeo, shadeMat), x, floorY + 1190, barZ, 0, true);
      add(new THREE.Mesh(new THREE.SphereGeometry(20, 12, 10), candleMat),
          x, floorY + 1160, barZ, 0, true);                    // 灯泡
      // distance 1000 < 灯到台面的水平距离（≈1600），不会改台面观感
      const pl = new THREE.PointLight(0xffb070, 0.42, 1000, 2);
      pl.position.set(x, floorY + 1120, barZ);
      scene.add(pl);
      flickerLights.push({ light: pl, base: 0.42, phase: Math.random() * 6.28, amp: 0.05 });
    }

    // ---- 吧台前的地毯（一条长条，和主地毯分开） ----
    const runner = new THREE.Mesh(
      new THREE.PlaneGeometry(2400, 520),
      new THREE.MeshStandardMaterial({ color: 0x3b1a1c, roughness: 0.95 })
    );
    runner.rotation.x = -Math.PI / 2;
    runner.position.set(0, floorY + 2.4, barZ - 470);
    runner.receiveShadow = true;
    scene.add(runner);
  }

  // 桌腿剖面：一条 [半径, 高度] 的折线，绕 Y 轴旋一圈就是车木腿。
  // 基准剖面按"高 296、最大半径 45"设计，调用时按实际腿高/粗细微缩放，
  // 所以改台子高度不用重调这条曲线。
  //   0~16   底盘：落地外撇（r 34 → 44）
  //   16~72  收腰 + 第一道箍（38→29→27→36→28）
  //   72~176 细杆
  //   176~234 第二、三道箍
  //   234~296 中段收细后再往外张，顶到台身（r 45，和底部同宽）
  function legProfile(h, rMax) {
    const P = [
      [0, 0], [34, 0], [42, 6], [45, 16], [38, 24], [29, 34],
      [27, 46], [37, 56], [37, 64], [28, 72], [26, 96], [26, 124],
      [38, 134], [38, 144], [28, 152], [24, 176], [24, 206],
      [34, 216], [34, 226], [26, 234], [25, 258], [30, 274],
      [42, 288], [45, 296],
    ];
    const ky = h / 296, kx = rMax / 45;
    const out = [];
    for (let i = 0; i < P.length; i++) {
      out.push(new THREE.Vector2(P[i][0] * kx, P[i][1] * ky));
    }
    return out;
  }

  // 窗：砌在 -X 那面墙上。默认巡游机位在 +X/-Z，看过去正好是正面，一眼就是"台球厅有窗"。
  // 结构 = 上下左右框 + 十字中梃 + 一块发光玻璃 + 窗台。
  // 玻璃是 MeshBasicMaterial（不吃光照，永远自己亮着），颜色/亮度由氛围预设改。
  // 主光的方向也照这个窗口来 —— 光是**从窗户进来的**，不是凭空打在台面上。
  function buildWindow() {
    const wx = -WALL_HX;                 // 墙面内表面
    const ww = 1500, wh = 780;           // 窗洞：沿 Z 宽 1500、竖直高 780
    const sillY = FLOOR_Y + 820;
    const cy = sillY + wh / 2;
    const T = 46;                        // 框料厚度

    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2e2318, roughness: 0.72 });
    const frame = (dy, dz, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(90, dy, dz), frameMat);
      m.position.set(wx + 45, y, z);
      // 窗框不投影：主光是从窗外斜射进来的，一扇 1.5m 宽的窗框会在
      // 台呢上投下一大块矩形阴影，俯视时像"台面脏了一块"。阴影只保留
      // 球、球杆、台身这些与玩法相关的物体。
      m.castShadow = false; m.receiveShadow = true;
      scene.add(m);
    };
    frame(T, ww + T * 2, sillY - T / 2, 0);              // 下框
    frame(T, ww + T * 2, sillY + wh + T / 2, 0);         // 上框
    frame(wh, T, cy, -(ww / 2 + T / 2));                 // 左框
    frame(wh, T, cy, (ww / 2 + T / 2));                  // 右框
    frame(26, ww, cy, 0);                                // 横中梃
    frame(wh, 26, cy, 0);                                // 竖中梃

    const sill = new THREE.Mesh(new THREE.BoxGeometry(170, 30, ww + T * 2 + 40), frameMat);
    sill.position.set(wx + 85, sillY - T - 15, 0);
    sill.castShadow = false; sill.receiveShadow = true;
    scene.add(sill);

    // 玻璃：法线朝 +X（房间内侧）
    const pane = new THREE.Mesh(
      new THREE.PlaneGeometry(ww, wh),
      new THREE.MeshBasicMaterial({ color: 0xdfe8ff, transparent: true, opacity: 0.75 })
    );
    pane.rotation.y = Math.PI / 2;
    pane.position.set(wx + 8, cy, 0);
    scene.add(pane);
    ambRefs.pane = pane;
  }

  // 一盏吊灯 = 吊绳 + 锥形灯罩 + 朝下的发光面片 + 一盏不投影的 SpotLight。
  //
  // ⚠ 结构上必须分成**两层 Group**，不能把五个东西平铺在一个 g 里：
  //   俯视图（正交相机）下三盏灯正好投影在台面上，把台呢糊出三个大圆 —— 必须能藏起来。
  //   但 three.js r149 的 WebGLRenderer.projectObject 遍历时就带 `if (!object.visible) return`
  //   且这一支**同时管光照**：藏了父 Group，里面的 SpotLight 会被一起摘掉，场景立刻变暗。
  //   所以：能藏的网格放内层 vis，灯（和它的 target）留在外层 g 上，永不可见性无关。
  //   藏 vis 同时消掉 shade.castShadow 投出的那道影子 —— 阴影贴图那一趟走的是同一个
  //   projectObject，visible === false 的物体连阴影都不参与。
  function buildLamp(cx, cz) {
    const shadeY = 620;                    // 灯罩离台呢的高度（≈1630mm）
    const g = new THREE.Group();
    g.position.set(cx, 0, cz);             // cx/cz 已经是 three 世界的坐标

    // 内层：所有看得见的部分，俯视图下整组隐藏
    const vis = new THREE.Group();
    g.add(vis);
    lampVis.push(vis);

    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 1.6, CEIL_Y - shadeY, 8),
      new THREE.MeshStandardMaterial({ color: 0x14121a, roughness: 0.8 })
    );
    cord.position.y = (CEIL_Y + shadeY) / 2;
    vis.add(cord);

    const shadeMat = new THREE.MeshStandardMaterial({
      color: 0x1c3b2c, roughness: 0.55, metalness: 0.25, side: THREE.DoubleSide,
    });
    const shade = new THREE.Mesh(
      new THREE.CylinderGeometry(26, 78, 66, 24, 1, true), shadeMat
    );
    shade.position.y = shadeY;
    shade.castShadow = true;
    vis.add(shade);

    // 朝下的发光面片：灯看着是亮的
    const bulb = new THREE.Mesh(
      new THREE.CircleGeometry(72, 24),
      new THREE.MeshBasicMaterial({ color: 0xfff0cc, transparent: true, opacity: 0.85 })
    );
    bulb.rotation.x = Math.PI / 2;         // 法线朝下
    bulb.position.y = shadeY - 32;
    vis.add(bulb);

    // 灯光本体：**不投影**（阴影只留主光一盏），纯氛围。
    // 挂在 g（外层）而不是 vis —— 见上面的注释，它必须活得比可见性长。
    // 强度/色温**由氛围预设写**（applyAmbience 里的 lamp 那一项）：
    // 白天吊灯几乎关掉（0.16），夜里它才是主照明（0.75）。这里给的 0.42 只是
    // 建灯时的初值，init() 末尾那次 applyAmbience 会立刻覆盖掉。
    // 压低过（0.55 → 0.42）是因为三盏灯正下方各有一块光斑，加起来把台呢中路顶亮，
    // 俯视图下看就是"中间发白、四角深"，很不均匀。
    const lamp = new THREE.SpotLight(0xffe6bc, 0.42, 2400, 0.62, 0.55, 1);
    lampLights.push(lamp);
    lampBase.push(0.42);
    lampSway.push({ g: g, phase: Math.random() * Math.PI * 2 });
    lamp.position.set(0, shadeY - 30, 0);
    lamp.target.position.set(0, -shadeY, 0);
    g.add(lamp);
    g.add(lamp.target);

    scene.add(g);
  }

  // ================================================================
  //  球 / 球杆 / 幽灵球
  // ================================================================
  function ensureBall(i) {
    if (ballMesh[i]) return ballMesh[i];
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 24, 16),
      meshMat('#ffffff', 0.14, 0.05)
    );
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
    ballMesh[i] = m;
    return m;
  }

  function buildCue() {
    cueGroup = new THREE.Group();
    // 三层结构（第八轮）：
    //   cueGroup —— 放在白球上，只改 yaw
    //   cueTilt  —— 绕 Z 轴俯仰，原点就在白球中心，所以**杆头不动、杆尾抬起**
    //   杆身/皮头 —— 沿局部 -X 向后延伸
    cueTilt = new THREE.Group();
    cueGroup.add(cueTilt);

    // 球杆拆成 5 段：先角/前节/后节/握把/尾帽。
    // 圆柱默认沿 Y 轴，绕 Z 转 90° 后：+Y → -X（杆尾），-Y → +X（杆头）。
    // 所以 CylinderGeometry 的第一个半径是杆尾、第二个是杆头 ——
    // 旧代码写成了 (1.5, 3.2)，实际上"杆头比杆尾粗"，像一根牙签。
    cueMesh = new THREE.Group();

    function cuePart(rTop, rBottom, len, x, mat) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, len, 18), mat);
      m.rotation.z = Math.PI / 2;
      m.position.x = x;
      m.castShadow = true;
      cueMesh.add(m);
      return m;
    }

    const shaftMat = new THREE.MeshStandardMaterial({ color: 0xc99b62, roughness: 0.34, metalness: 0.04 });
    const buttMat = new THREE.MeshStandardMaterial({ color: 0x3a2113, roughness: 0.46, metalness: 0.08 });
    const wrapMat = new THREE.MeshStandardMaterial({ color: 0x141018, roughness: 0.82 });
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xb08a45, roughness: 0.32, metalness: 0.7 });

    // 杆头 → 杆尾：先角 → 前节 → 后节 → 握把 → 尾帽
    cuePart(1.35, 1.35, 12, -12, new THREE.MeshStandardMaterial({ color: 0xe8dfc8, roughness: 0.35 }));
    cuePart(2.15, 1.35, 430, -7 - 215, shaftMat);
    cuePart(3.1, 2.15, 120, -437 - 60, buttMat);
    cuePart(3.5, 3.1, 64, -557 - 32, wrapMat);
    cuePart(3.9, 3.5, 24, -621 - 12, brassMat);
    cueMesh.castShadow = true;
    cueTilt.add(cueMesh);

    cueTip = new THREE.Mesh(
      new THREE.CylinderGeometry(1.35, 1.35, 7, 14),
      new THREE.MeshStandardMaterial({ color: 0x27506e, roughness: 0.72 })
    );
    cueTip.rotation.z = Math.PI / 2;
    cueTilt.add(cueTip);

    cueGroup.visible = false;
    scene.add(cueGroup);

    // 架杆：白球离身后库边太远时，在球杆下面支一个小桥。
    // 纯视觉，不参与物理；位置和朝向每帧由 render() 更新。
    cueRest = new THREE.Group();
    const restWood = new THREE.MeshStandardMaterial({ color: 0x6b4428, roughness: 0.55 });
    const restBrass = new THREE.MeshStandardMaterial({ color: 0x9a7a3a, roughness: 0.38, metalness: 0.6 });
    const restLeg = new THREE.Mesh(new THREE.CylinderGeometry(3, 4, 7, 10), restWood);
    restLeg.position.y = 3.5;
    cueRest.add(restLeg);
    const restBar = new THREE.Mesh(new THREE.BoxGeometry(14, 5, 34), restWood);
    restBar.position.y = 7;
    restBar.castShadow = true;
    cueRest.add(restBar);
    for (const rz of [-11, 11]) {
      const prong = new THREE.Mesh(new THREE.BoxGeometry(5, 13, 5), restBrass);
      prong.position.set(0, 16, rz);
      prong.castShadow = true;
      cueRest.add(prong);
    }
    // 架杆自己的长杆：从桥头往后伸，略微偏一个角度，看起来像另一根杆
    const restShaft = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.8, 360, 10), restWood);
    restShaft.rotation.z = Math.PI / 2;
    restShaft.rotation.y = 0.10;
    restShaft.position.set(-190, 6, 19);
    restShaft.castShadow = true;
    cueRest.add(restShaft);
    const restButt = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 2.8, 28, 10), restBrass);
    restButt.rotation.z = Math.PI / 2;
    restButt.rotation.y = 0.10;
    restButt.position.set(-373, 6, 37);
    cueRest.add(restButt);
    cueRest.visible = false;
    scene.add(cueRest);
  }

  function buildHelpers() {
    ghostMesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16 })
    );
    ghostMesh.visible = false;
    scene.add(ghostMesh);

    cuePulse = new THREE.Mesh(
      new THREE.RingGeometry(BALL_R * 1.3, BALL_R * 2.4, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, side: THREE.DoubleSide })
    );
    cuePulse.rotation.x = -Math.PI / 2;
    cuePulse.visible = false;
    scene.add(cuePulse);

    // 击点标记：球杆真正接触的那一点，贴在**朝向球杆**的球面上。
    // 用小圆球而不是圆片：俯视正交机下，接触点在球的侧面，圆片会侧着看不见；
    // 小圆球从任何机位都能读成一个点。
    spinDot = new THREE.Mesh(
      new THREE.SphereGeometry(2.2, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xff4848 })
    );
    spinDot.visible = false;
    scene.add(spinDot);
  }

  // 目标球光环（按需扩容）
  function ensureRing(i) {
    if (ringPool[i]) return ringPool[i];
    const r = new THREE.Mesh(
      new THREE.RingGeometry(BALL_R * 1.15, BALL_R * 1.75, 28),
      new THREE.MeshBasicMaterial({ color: 0xffd93d, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
    );
    r.rotation.x = -Math.PI / 2;
    r.position.y = 0.5;
    scene.add(r);
    ringPool[i] = r;
    return r;
  }

  // ================================================================
  //  条带几何体（把一串点变成有宽度的带子——three 的 Line 线宽无效）
  // ================================================================
  function ribbonGeometry(points, width, y) {
    const n = points.length;
    if (n < 2) return null;
    const pos = new Float32Array((n - 1) * 6 * 3);
    const hw = width / 2;
    let k = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = points[i], b = points[i + 1];
      let dx = b.x - a.x, dz = b.y - a.y;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      const px = -dz * hw, pz = dx * hw;
      const ax = X(a.x), az = Z(a.y), bx = X(b.x), bz = Z(b.y);
      // 两个三角形
      pos[k++] = ax - px; pos[k++] = y; pos[k++] = az - pz;
      pos[k++] = ax + px; pos[k++] = y; pos[k++] = az + pz;
      pos[k++] = bx + px; pos[k++] = y; pos[k++] = bz + pz;

      pos[k++] = ax - px; pos[k++] = y; pos[k++] = az - pz;
      pos[k++] = bx + px; pos[k++] = y; pos[k++] = bz + pz;
      pos[k++] = bx - px; pos[k++] = y; pos[k++] = bz - pz;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return geo;
  }

  // 复用一个带子对象，内容变了就换几何体、旧的销毁
  function updateRibbon(slot, points, width, y, color, opacity) {
    if (!slot.mesh) {
      slot.mesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({
          color: color, transparent: true, opacity: opacity, side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      slot.mesh.renderOrder = 5;
      scene.add(slot.mesh);
    }
    const geo = ribbonGeometry(points, width, y);
    if (!geo) { slot.mesh.visible = false; slot.mesh.geometry.dispose(); slot.mesh.geometry = new THREE.BufferGeometry(); return; }
    slot.mesh.geometry.dispose();
    slot.mesh.geometry = geo;
    slot.mesh.material.color.set(color);
    slot.mesh.material.opacity = opacity;
    slot.mesh.visible = true;
  }

  // 辅助线末端的进洞白点（第十轮）。和 2D 的 drawPotDot 完全同源：
  // 看 sim 结果里的 finalBalls[i].potted，不另做几何判断。
  // 池化：每个被画的球占一个槽，条带宽度略放大一点当点半径。
  const potDots = [];
  let potDotGeo = null, potDotMat = null;
  function placePotDot(slot, pv, i, width) {
    if (!potDots[slot]) {
      if (!potDotGeo) {
        potDotGeo = new THREE.CircleGeometry(1, 14);
        potDotMat = new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0.95,
          side: THREE.DoubleSide, depthWrite: false,
        });
      }
      const d = new THREE.Mesh(potDotGeo, potDotMat);
      d.rotation.x = -Math.PI / 2;
      d.renderOrder = 6;
      d.visible = false;
      scene.add(d);
      potDots[slot] = d;
    }
    const dot = potDots[slot];
    const fb = pv.finalBalls && pv.finalBalls[i];
    const pts = pv.paths && pv.paths[i];
    if (!fb || !fb.potted || !pts || pts.length < 2) {
      dot.visible = false;
      return false;
    }
    const p = pts[pts.length - 1];
    dot.position.set(X(p.x), 0.62, Z(p.y));
    dot.scale.setScalar(width * 0.75 + 1);
    dot.visible = true;
    return true;
  }

  // ================================================================
  //  透视机下的屏幕坐标 → 台面坐标（第十轮：3D Orbit 里也能瞄准）
  //
  //  正交俯视时屏幕 == 台面，直接用 cpos()；透视机不行，必须从相机打一条射线
  //  与台呢平面 y=0 求交。返回值是**台面坐标**（x: 0..W，y: 0..H），
  //  和 cpos() 同一个坐标系，main.js 拿到就能直接喂 aimAt()。
  //  交点落在台面外也照常返回（瞄准时自然指到库外/墙上），由调用方决定怎么用。
  // ================================================================
  const pickRay = new THREE.Raycaster();
  const pickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pickNdc = new THREE.Vector2();
  const pickHit = new THREE.Vector3();

  function pickTable(clientX, clientY) {
    if (!renderer || !camPersp) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pickNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pickNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    // 第一视角混合期间实际渲染的是 camBlend；射线必须跟同一台相机，
    // 否则混合的约 1 秒内鼠标瞄准会偏。
    const cam = (perspCam && shotCam.w > 0.001 && camBlend) ? camBlend : camPersp;
    pickRay.setFromCamera(pickNdc, cam);
    const hit = pickRay.ray.intersectPlane(pickPlane, pickHit);
    if (!hit) return null;                     // 射线与台面平行（理论上不会）
    return { x: hit.x + W / 2, y: hit.z + H / 2 };
  }

  // ================================================================
  //  初始化
  // ================================================================
  function init(canvas) {
    if (ready) return;                 // 同一个 canvas 不能建两次 WebGL 上下文
    renderer = new THREE.WebGLRenderer({
      canvas: canvas, antialias: true, alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H, false);
    if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    // 远处墙/家具略略退进暗处，透视机下空间有纵深；俯视正交机距离约 1400，
    // 落在雾起点以内，台面完全不受影响。
    scene.fog = new THREE.Fog(0x0a0d11, 2600, 7600);

    camOrtho = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, 1, 3000);
    camOrtho.position.set(0, 1400, 0);
    camOrtho.up.set(0, 0, -1);        // 让 +Z 在屏幕上朝下，和 canvas 坐标一致
    camOrtho.lookAt(0, 0, 0);

    // 观战用的透视相机。缓冲固定 1416×736（setSize(W,H,false)），
    // 画布靠 CSS 等比缩放，宽高比恒定 → 不需要 resize 监听。
    camPersp = new THREE.PerspectiveCamera(45, W / H, 10, 14000);
    camPersp.up.set(0, 1, 0);
    // 第一视角相机 + 混合相机：两者都是透视，混合只做位置/四元数/FOV 插值。
    camShot = new THREE.PerspectiveCamera(62, W / H, 8, 14000);
    camShot.up.set(0, 1, 0);
    camBlend = new THREE.PerspectiveCamera(45, W / H, 8, 14000);
    camBlend.up.set(0, 1, 0);
    lastFrame = perfNow();

    // ---- 灯光 ----
    // 房间进来以后总光量要重排：环境光压低（房间本身要暗，才有台球厅的暗调），
    // 补一盏半球光当"墙和地板的反光"，主光（**唯一投影光源**）保持不变的开销。
    //
    // ★ 台呢发白是"总光量"的问题，不只是色值：台面是水平朝上的，
    //   ambient + hemi + sun + fill + 三盏吊灯 SpotLight 会全部叠在同一块台呢上。
    //   原来合计约 1.2（相对白纸），深绿被抬成草绿。现在合计约 1.0。
    //   改深/改浅优先动上面的台呢色值；真想动光，这三行是主要旋钮。
    const amb = new THREE.AmbientLight(0xffffff, 0.20);
    scene.add(amb);
    const hemi = new THREE.HemisphereLight(0x2a3a55, 0x140d08, 0.20);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff4e0, 0.48);
    sun.position.set(360, 900, -420);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    // 主光是斜的，投影到光源平面上会比台面大一圈，视锥要放宽，
    // 否则台面边缘的球影会被裁掉。
    // ★ far 必须够大：地板上 FLOOR_Y = -365，主光斜照下来投影一直延伸到地板 ——
    //   far 太小地板就收不到阴影，桌腿看着像**悬空**。这是整块改动的头号翻车点。
    //   主光的位置**由氛围预设决定**，所以 far 不写死，applyAmbience() 里按
    //   |sunPos| 现算（晚上太阳压到窗口低处，距离会明显变）。
    const sc = sun.shadow.camera;
    sc.left = -W / 2 - 480; sc.right = W / 2 + 480;
    sc.top = H / 2 + 480; sc.bottom = -H / 2 - 480;
    sc.near = 100; sc.far = 3600;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.6;
    scene.add(sun);
    scene.add(sun.target);

    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.10);
    fill.position.set(-500, 600, 500);
    scene.add(fill);

    // 窗外光：一盏**不投影**的方向光，从窗口外面斜射进来。
    // 它不负责阴影（阴影只有主光那一盏），只负责"这屋里有一扇亮着的窗"这层氛围。
    const glow = new THREE.DirectionalLight(0xdfe8ff, 0.22);
    glow.position.set(-4200, 900, -500);
    glow.target.position.set(0, 0, 0);
    scene.add(glow);
    scene.add(glow.target);

    // 房间补光：几乎水平地从 -Z 打向 +Z，主要照亮竖向墙面和吧台正面。
    // 台面法线朝上，N·L 很小，所以它不会把台呢一起提亮 —— 这是"只给房间
    // 加亮度、不破坏台面配色"的关键。不投影。
    const room = new THREE.DirectionalLight(0xffdfc0, 0.26);
    room.position.set(0, 360, -3600);
    room.target.position.set(0, 900, 1800);
    scene.add(room);
    scene.add(room.target);

    ambRefs.amb = amb;
    ambRefs.hemi = hemi;
    ambRefs.sun = sun;
    ambRefs.fill = fill;
    ambRefs.glow = glow;
    ambRefs.room = room;

    buildRoom();       // ← 房间先建（地板/桌腿要在地底下），台面再压上去
    buildTable();
    buildCue();
    buildHelpers();

    ready = true;
    applyAmbience(ambName, true);
  }

  // ================================================================
  //  观战轨道控制（手写：vendor 里的 three r149 不含 OrbitControls，
  //  项目要求离线零依赖，所以不引 addon）
  // ================================================================
  function clampOrb(o) {
    o.pol = Math.min(ORB_LIMIT.polMax, Math.max(ORB_LIMIT.polMin, o.pol));
    o.dist = Math.min(ORB_LIMIT.distMax, Math.max(ORB_LIMIT.distMin, o.dist));
    return o;
  }

  // 进入/退出观战。**进入时给的是俯视位（正交机）**，不是斜视：
  //   用户的原话是"进入对战默认是俯视图，而非侧视图"。
  //   斜视（透视巡游）是"没人管这局的时候"才自动飞过去的，见 updateCamera。
  function setSpectate(on) {
    on = !!on;
    if (on === spectating) return;
    spectating = on;
    manualOrbit = false;          // 两套镜头状态互斥
    resetView();
  }

  // 人类主动进入/退出轨道视角（3D Orbit 按钮 / O 键）。
  // 跟观战的区别：不自动巡游、不跟球，镜头完全听用户的；
  // 进入时从俯视位平滑飞到默认斜视位，退出时立刻回正交俯视。
  function setOrbit(on) {
    on = !!on;
    if (spectating) return;       // 观战有自己的镜头，按钮此时隐藏
    if (on === manualOrbit) return;
    manualOrbit = on;
    cineOn = false;
    if (on) {
      orbDamp = 0.20;             // 约 1~2 秒飞到位，之后恢复跟手
      const d = ORB_DEFAULTS;
      orb.cur = { az: d.az, pol: ORB_TOP.pol, dist: ORB_TOP.dist, tx: 0, ty: 0, tz: 0 };
      orb.tgt = { az: d.az, pol: d.pol, dist: d.dist, tx: d.tx, ty: d.ty, tz: d.tz };
      perspCam = true;
    } else {
      perspCam = false;
      resetView();
    }
  }

  function orbitActive() {
    return spectating ? perspCam : manualOrbit;
  }

  // 回到本局的起始机位：正交俯视 + 重置巡游计时。
  // 每开一局都会调（main.js 的 resetGame 里）—— 所以"进入对战 = 俯视图"是硬保证。
  function resetView() {
    perspCam = false;
    cineOn = false;
    orbDamp = 0.0015;
    idleSince = perfNow();
    // 顺手把透视机也摆到俯视位：用户接下来一拖动，就是从俯视平滑接管的
    const d = ORB_DEFAULTS;
    orb.cur = { az: d.az, pol: ORB_TOP.pol, dist: ORB_TOP.dist, tx: 0, ty: 0, tz: 0 };
    orb.tgt = { az: d.az, pol: d.pol, dist: d.dist, tx: d.tx, ty: d.ty, tz: d.tz };
  }

  // 用户接管镜头：停掉自动巡游，切到透视机（从俯视位起飞）。
  // 返回 false = 现在不该有镜头操作（非观战），调用方直接 return。
  function userControl() {
    if (!spectating) {
      if (!manualOrbit) return false;
      orbDamp = 0.0015;
      perspCam = true;
      return true;
    }
    idleSince = perfNow();
    cineOn = false;
    orbDamp = 0.0015;
    if (!perspCam) {
      perspCam = true;
      const d = ORB_DEFAULTS;
      orb.cur = { az: d.az, pol: ORB_TOP.pol, dist: ORB_TOP.dist, tx: 0, ty: 0, tz: 0 };
      orb.tgt = { az: d.az, pol: ORB_TOP.pol, dist: ORB_TOP.dist, tx: 0, ty: 0, tz: 0 };
    }
    return true;
  }

  // 只是"有人动了"（鼠标划过、滚了一下）—— 重置闲置计时，但**不改机位**。
  // 观战时鼠标划过就打断巡游会太敏感，所以只推迟它。
  function notifyActivity() {
    idleSince = perfNow();
    if (cineOn) { cineOn = false; orbDamp = 0.0015; }
  }

  // 闲置够久 → 自动巡游：平滑飞到斜视机位，之后缓慢自转 + 偶尔跟球。
  function startCine() {
    if (!spectating) return;
    cineOn = true;
    orbDamp = 0.30;                      // 阻尼放慢 → 约 3 秒飞到位（到位后自动恢复跟手）
    cineFollow = false;
    cineFollowT = 5 + Math.random() * 4;
    perspCam = true;
    const d = ORB_DEFAULTS;
    orb.cur = { az: d.az, pol: ORB_TOP.pol, dist: ORB_TOP.dist, tx: 0, ty: 0, tz: 0 };
    orb.tgt = { az: d.az, pol: d.pol, dist: d.dist, tx: d.tx, ty: d.ty, tz: d.tz };
  }

  function orbitDrag(dx, dy) {
    if (!userControl()) return;
    orb.tgt.az -= dx * 0.0045;
    orb.tgt.pol -= dy * 0.0035;
    clampOrb(orb.tgt);
  }

  // 平移：沿相机的右/上方向推目标点（在水平面内推，垂直方向锁住）
  function orbitPan(dx, dy) {
    if (!userControl()) return;
    const s = orb.cur.dist * 0.0013;
    const ca = Math.cos(orb.cur.az), sa = Math.sin(orb.cur.az);
    // 相机朝目标的水平方向 = (-ca, -sa)；它的右手方向 = (-sa, ca)
    orb.tgt.tx += (-sa) * dx * s;
    orb.tgt.tz += (ca) * dx * s;
    orb.tgt.ty = Math.min(280, Math.max(-320, orb.tgt.ty + dy * s));
  }

  function orbitZoom(f) {
    if (!userControl()) return;
    orb.tgt.dist *= f;
    clampOrb(orb.tgt);
  }

  // 复位 = **回到俯视位**（也就是每局的起始机位），不是回到斜视默认位。
  // 巡游看腻了按一下 C 就回到能看清全台的俯视，符合"进入对战默认是俯视图"。
  function orbitReset() {
    if (spectating) { resetView(); return; }
    if (!manualOrbit) return;
    // 主动轨道视角：C 回到默认斜视位，仍在 3D 里；要回俯视用按钮/Esc。
    orbDamp = 0.15;
    orb.tgt = {
      az: ORB_DEFAULTS.az, pol: ORB_DEFAULTS.pol, dist: ORB_DEFAULTS.dist,
      tx: ORB_DEFAULTS.tx, ty: ORB_DEFAULTS.ty, tz: ORB_DEFAULTS.tz,
    };
  }

  // 键盘：方向键转向/俯仰，= / - 缩放
  function orbitNudge(daz, dpol, ddist) {
    if (!userControl()) return;
    if (daz) orb.tgt.az += daz;
    if (dpol) orb.tgt.pol += dpol;
    if (ddist) orbitZoom(ddist);
    clampOrb(orb.tgt);
  }

  // 每帧把 cur 逼近 tgt。k = 1 - damp^dt 是**与帧率无关**的阻尼：
  // damp = 0.0015 → 一帧 k ≈ 0.10（跟手）；进入巡游时临时换成 0.30，约 3 秒飞到位，
  // 到位后再自动换回来 —— 否则巡游结束后手动拖拽会一直黏糊糊的。
  function updateOrb(dt) {
    const k = 1 - Math.pow(orbDamp, dt);
    const c = orb.cur, t = orb.tgt;
    c.az += (t.az - c.az) * k;
    c.pol += (t.pol - c.pol) * k;
    c.dist += (t.dist - c.dist) * k;
    c.tx += (t.tx - c.tx) * k;
    c.ty += (t.ty - c.ty) * k;
    c.tz += (t.tz - c.tz) * k;

    if (orbDamp > 0.002) {
      const err = Math.abs(t.pol - c.pol) + Math.abs(t.az - c.az) +
        Math.abs(t.dist - c.dist) / 900 + (Math.abs(t.tx - c.tx) + Math.abs(t.tz - c.tz)) / 400;
      if (err < 0.05) orbDamp = 0.0015;
    }

    const sp = Math.sin(c.pol), cp = Math.cos(c.pol);
    camPersp.position.set(
      c.tx + c.dist * sp * Math.cos(c.az),
      c.ty + c.dist * cp,
      c.tz + c.dist * sp * Math.sin(c.az)
    );
    camPersp.lookAt(c.tx, c.ty, c.tz);
  }

  // 观战镜头每帧的调度：
  //   闲置够久 → 起飞巡游（startCine 一开，updateOrb 的阻尼会把它"飞"过去）
  //   巡游中   → 缓慢自转 + 偶尔把视点挪到白球上（跟球）
  //   都不是   → 正交俯视，什么都不做
  function updateCamera(dt, balls) {
    if (!spectating) {
      // 主动轨道视角：只跑相机阻尼，没有巡游/跟球
      if (!manualOrbit) { perspCam = false; return; }
      perspCam = true;
      updateOrb(dt);
      return;
    }
    if (!cineOn && (perfNow() - idleSince) > CINE_IDLE_MS) startCine();
    if (!perspCam) return;

    if (cineOn) {
      orb.tgt.az += 0.05 * dt;                 // 缓慢自转 ≈ 2.9°/秒

      cineFollowT -= dt;
      if (cineFollowT <= 0) {
        cineFollow = !cineFollow;
        cineFollowT = cineFollow ? 4.5 : (7 + Math.random() * 8);
      }
      let bx = ORB_DEFAULTS.tx, bz = ORB_DEFAULTS.tz, by = ORB_DEFAULTS.ty;
      if (cineFollow && balls) {
        let t = null;
        for (let i = 0; i < balls.length; i++) {
          if (balls[i].label === 'white' && balls[i].isOnTable()) { t = balls[i]; break; }
        }
        if (!t) {
          for (let i = 0; i < balls.length; i++) {
            if (balls[i].isOnTable()) { t = balls[i]; break; }
          }
        }
        if (t) { bx = X(t.x); bz = Z(t.y); by = -25; }
      }
      // 视点自己再走一遍慢阻尼，避免"跟球"时镜头跟得太硬
      const g = Math.min(1, dt * 0.9);
      orb.tgt.tx += (bx - orb.tgt.tx) * g;
      orb.tgt.tz += (bz - orb.tgt.tz) * g;
      orb.tgt.ty += (by - orb.tgt.ty) * g;
    }
    updateOrb(dt);
  }

  // ================================================================
  //  击球者第一视角
  //
  //  只在透视机（3D Orbit / 观战巡游）下触发，避免正交俯视与透视之间
  //  无法平滑插值投影矩阵。触发后：
  //    · 镜头贴到白球后方、约 150~210px 高，沿出杆方向看出去；
  //    · 出杆后跟着白球（白球落袋就跟着最快的球）移动；
  //    · 球停稳后延迟 0.45 秒退出，退回原来的轨道机位。
  //  进入/退出都用 smoothstep 混合位置、四元数和 FOV，不硬切。
  // ================================================================
  const shotTmpA = new THREE.Vector3();
  const shotTmpB = new THREE.Vector3();
  const SHOT_CAM_COOLDOWN = 18000;

  function updateShotCamera(dt, view) {
    const tnow = perfNow();
    const moving = view.state === 'moving';

    if (!perspCam) {
      shotCam.active = false;
      shotCam.stopping = false;
      shotCam.target = 0;
      shotCam.w = 0;
      lastViewState = view.state;
      return;
    }

    // 只在"刚出杆"这一帧掷骰子，且两次第一视角之间至少隔 18 秒
    if (moving && lastViewState !== 'moving' && !shotCam.active &&
        tnow - shotCam.lastAt > SHOT_CAM_COOLDOWN) {
      const chance = spectating ? 0.22 : 0.07;
      if (Math.random() < chance) {
        shotCam.active = true;
        shotCam.stopping = false;
        shotCam.target = 1;
        shotCam.w = 0;
        shotCam.followIdx = -1;
        shotCam.switched = false;
        shotCam.startedAt = tnow;
        shotCam.lastAt = tnow;
        const a = view.aimAngle || 0;
        shotCam.dirX = Math.cos(a);
        shotCam.dirZ = Math.sin(a);
        const cb = view.cueBall;
        if (cb) {
          const bx = X(cb.x), bz = Z(cb.y);
          shotCam.pos.set(bx - shotCam.dirX * 150, BALL_R + 170, bz - shotCam.dirZ * 150);
          shotCam.look.set(bx + shotCam.dirX * 520, 14, bz + shotCam.dirZ * 520);
        }
      }
    }

    if (shotCam.active) {
      if (!moving && !shotCam.stopping) {
        shotCam.stopping = true;
        shotCam.stopAt = tnow + 450;
      }
      if (shotCam.stopping && tnow >= shotCam.stopAt) shotCam.target = 0;
      if (tnow - shotCam.startedAt > 7500) shotCam.target = 0;

      // 跟拍逻辑：白球一直走到第一次碰到目标球；
      // 碰到之后立刻把跟拍目标换成那颗目标球，而不是继续盯白球。
      if (!shotCam.switched && view.firstContact) {
        const idx = view.balls.indexOf(view.firstContact);
        if (idx >= 0) {
          shotCam.followIdx = idx;
          shotCam.switched = true;
        }
      }
      let b = null;
      if (shotCam.followIdx >= 0) b = view.balls[shotCam.followIdx];
      if (!b || !b.isOnTable()) {
        // 目标球落袋/还没接触：退回白球；白球也没了就跟最快的球
        b = (view.cueBall && view.cueBall.isOnTable()) ? view.cueBall : null;
        if (!b) {
          let best = -1, bestSp = 0;
          for (let i = 0; i < view.balls.length; i++) {
            const o = view.balls[i];
            if (!o.isOnTable()) continue;
            const sp = Math.hypot(o.vx || 0, o.vy || 0);
            if (sp > bestSp) { bestSp = sp; best = i; }
          }
          if (best >= 0) b = view.balls[best];
        }
      }
      if (b) {
        const sp = Math.hypot(b.vx || 0, b.vy || 0);
        let wantX = shotCam.dirX, wantZ = shotCam.dirZ;
        if (sp > 0.8) { wantX = b.vx / sp; wantZ = b.vy / sp; }
        // 方向平滑，球撞库反折时镜头不会瞬间甩头
        const kd = 1 - Math.exp(-dt * 4.2);
        shotCam.dirX += (wantX - shotCam.dirX) * kd;
        shotCam.dirZ += (wantZ - shotCam.dirZ) * kd;
        const dl = Math.hypot(shotCam.dirX, shotCam.dirZ) || 1;
        shotCam.dirX /= dl; shotCam.dirZ /= dl;

        const bx = X(b.x), bz = Z(b.y);
        const back = 145 + Math.min(55, sp * 1.4);
        shotTmpA.set(
          bx - shotCam.dirX * back,
          BALL_R + 155 + Math.min(55, sp * 1.1),
          bz - shotCam.dirZ * back
        );
        shotCam.pos.lerp(shotTmpA, 1 - Math.exp(-dt * 5.5));
        shotTmpB.set(bx + shotCam.dirX * 520, 14, bz + shotCam.dirZ * 520);
        shotCam.look.lerp(shotTmpB, 1 - Math.exp(-dt * 7.5));
      }
    }

    const kw = 1 - Math.exp(-dt * 3.4);
    shotCam.w += (shotCam.target - shotCam.w) * kw;
    if (shotCam.target === 0 && shotCam.w < 0.012) {
      shotCam.w = 0;
      shotCam.active = false;
      shotCam.stopping = false;
      shotCam.followIdx = -1;
      shotCam.switched = false;
    }
    lastViewState = view.state;
  }

  // 返回本帧真正要渲染的相机：需要时把 base 透视机与第一视角机混合。
  function shotRenderCamera() {
    if (!perspCam) return camOrtho;
    if (!camShot || !camBlend || shotCam.w <= 0.001) return camPersp;

    camShot.position.copy(shotCam.pos);
    camShot.lookAt(shotCam.look);

    const w = Math.min(1, Math.max(0, shotCam.w));
    const k = w * w * (3 - 2 * w);
    camBlend.position.lerpVectors(camPersp.position, camShot.position, k);
    camBlend.quaternion.copy(camPersp.quaternion).slerp(camShot.quaternion, k);
    camBlend.fov = camPersp.fov + (camShot.fov - camPersp.fov) * k;
    camBlend.updateProjectionMatrix();
    return camBlend;
  }

  // ================================================================
  //  环境动效：吊灯微摆、暖光呼吸、霓虹脉动、空气浮尘
  //  全部用低频小幅值，静止画面里几乎察觉不到；动起来之后房间才"有人"。
  // ================================================================
  function updateAmbient(now) {
    const t = now * 0.001;

    // Auto 氛围：每分钟跟现实时间对一次；白天/傍晚/夜晚自动切换
    if (ambName === 'auto' && now - lastAutoCheck > 60000) {
      lastAutoCheck = now;
      const eff = autoPreset();
      if (eff !== autoApplied) applyAmbience('auto', false);
    }

    // 挂钟跟现实时间走：秒针每秒跳一次，分针/时针跟着动
    if (clockFace) {
      const date = new Date();
      if (date.getSeconds() !== clockFace.sec) {
        clockFace.sec = date.getSeconds();
        drawClockFace(clockFace.ctx, date);
        clockFace.tex.needsUpdate = true;
      }
    }

    for (let i = 0; i < lampSway.length; i++) {
      const s = lampSway[i];
      s.g.rotation.z = Math.sin(t * 0.46 + s.phase) * 0.009;
      s.g.rotation.x = Math.cos(t * 0.37 + s.phase * 1.7) * 0.006;
    }

    for (let i = 0; i < lampLights.length; i++) {
      const base = lampBase[i] || 0;
      lampLights[i].intensity = base * (1 + Math.sin(t * 7.3 + i * 2.1) * 0.018
                                        + Math.sin(t * 17.1 + i) * 0.008);
    }

    for (let i = 0; i < flickerLights.length; i++) {
      const f = flickerLights[i];
      f.light.intensity = f.base * (1 + Math.sin(t * 8.7 + f.phase) * f.amp
                                    + Math.sin(t * 23.3 + f.phase * 1.9) * f.amp * 0.5);
    }

    if (neonSign) {
      const k = 0.90 + Math.sin(t * 2.1) * 0.05 + Math.sin(t * 7.7) * 0.025;
      neonSign.material.opacity = Math.min(1, k);
      if (neonLight) neonLight.intensity = neonBase * (0.85 + Math.sin(t * 2.1 + 0.7) * 0.15);
    }

    // 盆栽：叶尖极小幅摆动（参考 InstancedMesh 草地的"只动上半段"做法，
    // 这里叶片少，直接绕根部旋转即可）
    for (let i = 0; i < plantBlades.length; i++) {
      const b = plantBlades[i];
      b.m.rotation.z = b.lean + Math.sin(t * 1.15 + b.phase) * b.amp;
      b.m.rotation.x = Math.cos(t * 0.83 + b.phase * 1.4) * b.amp * 0.65;
    }

    // 蜡烛火苗：纵向呼吸 + 轻微左右摇
    for (let i = 0; i < candleFlames.length; i++) {
      const f = candleFlames[i];
      const k = 1 + Math.sin(t * 12.7 + f.phase) * 0.07 + Math.sin(t * 31.1 + f.phase) * 0.03;
      f.m.scale.set(1 / k, k, 1 / k);
      f.m.position.y = f.baseY + Math.sin(t * 9.3 + f.phase) * 0.7;
      f.m.position.x = f.baseX + Math.sin(t * 5.1 + f.phase) * 0.5;
    }

    // 青烟：每缕烟按自己的相位循环上升、放大、淡出
    for (let i = 0; i < smokePuffs.length; i++) {
      const p = smokePuffs[i];
      const age = (t + p.phase) % p.dur;
      const k = age / p.dur;
      const s = p.s;
      s.position.y = p.baseY + age * 22;
      s.position.x = p.baseX + Math.sin(age * 1.6 + p.phase * 3) * p.drift * k;
      s.position.z = p.baseZ + Math.cos(age * 1.2 + p.phase * 2) * p.drift * 0.5 * k;
      s.material.opacity = Math.sin(Math.PI * k) * 0.30 * (1 - k * 0.25);
      const sc = 4 + k * 15;
      s.scale.set(sc, sc, 1);
    }

    // 苍蝇：偶尔出现，绕房间飞一段再消失
    if (flyGroup) {
      const ud = flyGroup.userData;
      if (!flyGroup.visible && t > ud.hideUntil) {
        flyGroup.position.set(
          (Math.random() * 2 - 1) * 2300,
          300 + Math.random() * 560,
          (Math.random() * 2 - 1) * 1800
        );
        flyGroup.visible = true;
        ud.showUntil = t + 7 + Math.random() * 11;
        ud.next = 0;
      } else if (flyGroup.visible && t > ud.showUntil) {
        flyGroup.visible = false;
        ud.hideUntil = t + 26 + Math.random() * 38;
      }
      if (flyGroup.visible) {
        if (t > ud.next) {
          ud.target.set(
            (Math.random() * 2 - 1) * 2500,
            260 + Math.random() * 700,
            (Math.random() * 2 - 1) * 2000
          );
          ud.next = t + 0.8 + Math.random() * 1.8;
        }
        const dx = ud.target.x - flyGroup.position.x;
        const dy = ud.target.y - flyGroup.position.y;
        const dz = ud.target.z - flyGroup.position.z;
        const d = Math.hypot(dx, dy, dz) || 1;
        const step = ud.speed / 60;
        flyGroup.position.x += dx / d * step;
        flyGroup.position.y += dy / d * step;
        flyGroup.position.z += dz / d * step;
        flyGroup.rotation.y = Math.atan2(dz, dx) + Math.PI / 2;
        // 翅膀高频扇动
        for (let i = 0; i < flyWings.length; i++) {
          const w = flyWings[i];
          w.m.rotation.z = w.side * (0.15 + Math.abs(Math.sin(t * 55 + i)) * 0.85);
        }
      }
    }

    if (dust && dustData) {
      const arr = dust.geometry.attributes.position.array;
      const n = arr.length / 3;
      for (let i = 0; i < n; i++) {
        const o = i * 6;
        const by = dustData[o + 2];
        const speed = dustData[o + 3];
        const phase = dustData[o + 4];
        const drift = dustData[o + 5];
        let y = arr[i * 3 + 1] + speed * 0.016;
        if (y > CEIL_Y - 60) y = FLOOR_Y + 80;
        arr[i * 3] = dustData[o] + Math.sin(t * 0.23 + phase) * drift;
        arr[i * 3 + 1] = y;
        arr[i * 3 + 2] = dustData[o + 1] + Math.cos(t * 0.19 + phase) * drift;
      }
      dust.geometry.attributes.position.needsUpdate = true;
      dust.material.opacity = 0.20 + Math.sin(t * 0.8) * 0.06;
    }
  }

  // ================================================================
  //  主渲染
  //  view = { balls, cueBall, aimAngle, power, state, preview, trail, onLabel }
  // ================================================================
  function render(view) {
    if (!ready) return;
    const dt = frameDt();
    const balls = view.balls;

    // ---- 球 ----
    for (let i = 0; i < balls.length; i++) {
      const m = ensureBall(i);
      const b = balls[i];
      // 球数变少（抢黑/复位）时多出来的 mesh 要藏掉
      const col = C.COL[b.label] || '#cccccc';
      const mat = (C.isPoolLabel && C.isPoolLabel(b.label))
        ? poolBallMat(b.label)
        : meshMat(col, b.label === 'white' ? 0.12 : 0.14, 0.05);
      if (m.material !== mat) m.material = mat;
      if (!b.isOnTable()) { m.visible = false; continue; }
      m.visible = true;
      m.position.set(X(b.x), BALL_R + 0.05, Z(b.y));

      // ---- 真实滚动 ----
      // 物理层的 wx / wy / wz 是绕台面 x / y / 竖直 z 的角速度。
      // 映射到 three 世界：x → X，台面 y → Z，竖直 → Y。
      // 纯滚动关系 vx=R·wy、vy=−R·wx，所以符号取反。
      // 若角速度缺失（旧存档/静止），用线速度反推一个滚动轴，保证视觉上不是"滑行"。
      let ax = -b.wx, ay = -b.wz, az = -b.wy;
      let av = Math.hypot(ax, ay, az);
      if (av < 1e-5) {
        const sp = Math.hypot(b.vx || 0, b.vy || 0);
        if (sp > 0.01) {
          // 世界轴 = (vz, 0, -vx)，台面 vy → 世界 vz
          ax = b.vy / sp; ay = 0; az = -b.vx / sp;
          av = sp / BALL_R;          // v = ωR
        }
      }
      if (av > 1e-5) {
        ballSpinAxis.set(ax, ay, az).normalize();
        // 物理角速度单位是 rad / 60Hz 帧；换成真实秒
        ballSpinQ.setFromAxisAngle(ballSpinAxis, av * dt * 60);
        m.quaternion.premultiply(ballSpinQ);
      }
    }
    for (let i = balls.length; i < ballMesh.length; i++) {
      if (ballMesh[i]) ballMesh[i].visible = false;
    }

    // 落袋后的小球沿台下铜轨滚向球箱（纯视觉）
    updateReturnBalls(dt, balls);
    if (dZone) dZone.visible = view.state === 'placing';

    // ---- 目标球光环 ----
    let ri = 0;
    if (view.onLabel && view.state !== 'over') {
      for (let i = 0; i < balls.length; i++) {
        if (balls[i].label !== view.onLabel || !balls[i].isOnTable()) continue;
        const ring = ensureRing(ri++);
        ring.visible = true;
        const pulse = 0.32 + Math.sin(Date.now() * 0.005) * 0.16;
        ring.material.opacity = pulse;
        ring.position.set(X(balls[i].x), 0.5, Z(balls[i].y));
      }
    }
    for (let i = ri; i < ringPool.length; i++) ringPool[i].visible = false;

    // ---- 白球脉冲 ----
    const cb = view.cueBall;
    const live = cb && cb.isOnTable() &&
      (view.state === 'aim' || view.state === 'powering' || view.state === 'placing' || view.state === 'dragging');
    if (live) {
      cuePulse.visible = true;
      cuePulse.position.set(X(cb.x), 0.4, Z(cb.y));
      cuePulse.material.opacity = 0.12 + Math.sin(Date.now() * 0.004) * 0.08;
    } else {
      cuePulse.visible = false;
    }

    // ---- 击点标记（球杆接触点，贴在朝向球杆的球面上）----
    // 与 2D drawSpinMark 同一套球面投影：
    //   -d 方向是球杆一侧，sx 沿 ẑ×d 横移，sy 沿 +Y 抬高。
    const sxk = view.spinX || 0, syk = view.spinY || 0;
    if (live && (Math.abs(sxk) > 0.02 || Math.abs(syk) > 0.02)) {
      spinDot.visible = true;
      const a = view.aimAngle || 0;
      const dx = Math.cos(a), dy = Math.sin(a);
      const sideX = -dy, sideY = dx;
      // 和 physics.strike / 2D drawSpinMark 同源：俯仰把击点抬高
      const tip = C.effectiveTip
        ? C.effectiveTip(sxk, syk, (view.pitchDeg || 0) * Math.PI / 180)
        : { sx: sxk, sy: syk };
      const sx = tip.sx / C.SPIN_MAX;
      const sy = tip.sy / C.SPIN_MAX;
      const hs = Math.sqrt(Math.max(0, 1 - sx * sx - sy * sy));
      spinDot.position.set(
        X(cb.x) + (-dx * hs + sideX * sx) * BALL_R,
        BALL_R + 0.05 + sy * BALL_R,
        Z(cb.y) + (-dy * hs + sideY * sx) * BALL_R
      );
    } else {
      spinDot.visible = false;
    }

    // ---- 瞄准预览 ----
    // mode 0 全无 / 1 只有母球 / 2 母球+第一颗被撞球 / 3 所有会动的球
    const pv = view.preview;
    const gmode = (view.guideMode === undefined || view.guideMode === null) ? 2 : view.guideMode;
    let guideUsed = 0;
    let dotUsed = 0;
    if (pv && gmode > 0 && pv.cuePath && pv.cuePath.length > 1) {
      const key = pv.cuePath.length + ':' +
        pv.cuePath[pv.cuePath.length - 1].x.toFixed(1) + ',' +
        pv.cuePath[pv.cuePath.length - 1].y.toFixed(1);
      if (key !== aimKey) {
        aimKey = key;
        updateRibbon(aimSlot, pv.cuePath, 2.2, 0.55, '#ffee66', 0.85);
      } else if (aimSlot.mesh) {
        aimSlot.mesh.visible = true;
      }
      if (placePotDot(dotUsed, pv, pv.cueIdx, 2.2)) dotUsed++;
      const fc = pv.firstContact;
      if (gmode >= 2 && fc && pv.paths && pv.paths[fc.__i] && pv.paths[fc.__i].length > 1) {
        const tp = pv.paths[fc.__i];
        const tkey = tp.length + ':' + tp[tp.length - 1].x.toFixed(1);
        if (tkey !== targetKey) {
          targetKey = tkey;
          updateRibbon(targetSlot, tp, 2.0, 0.55, '#f9a825', 0.8);
        } else if (targetSlot.mesh) {
          targetSlot.mesh.visible = true;
        }
        if (placePotDot(dotUsed, pv, fc.__i, 2.0)) dotUsed++;
        const last = pv.cuePath[pv.cuePath.length - 1];
        ghostMesh.visible = true;
        ghostMesh.position.set(X(last.x), BALL_R + 0.05, Z(last.y));
      } else {
        if (targetSlot.mesh) targetSlot.mesh.visible = false;
        ghostMesh.visible = false;
      }

      if (gmode >= 3 && pv.paths) {
        const skip = (fc && fc.__i >= 0) ? fc.__i : -1;
        for (let i = 0; i < pv.paths.length; i++) {
          if (i === pv.cueIdx || i === skip) continue;
          const path = pv.paths[i];
          if (!path || path.length < 2) continue;
          // 跑都没跑起来的球不画线
          const a0 = path[0], aN = path[path.length - 1];
          if (Math.abs(aN.x - a0.x) + Math.abs(aN.y - a0.y) < 0.6) continue;
          if (!guideSlots[guideUsed]) guideSlots[guideUsed] = { mesh: null, key: '' };
          const slot = guideSlots[guideUsed];
          const gkey = path.length + ':' + aN.x.toFixed(1) + ',' + aN.y.toFixed(1);
          if (slot.key !== gkey) {
            slot.key = gkey;
            updateRibbon(slot, path, 1.6, 0.55, '#96ffbe', 0.45);
          } else if (slot.mesh) {
            slot.mesh.visible = true;
          }
          if (placePotDot(dotUsed, pv, i, 1.6)) dotUsed++;
          guideUsed++;
        }
      }
    } else {
      if (aimSlot.mesh) aimSlot.mesh.visible = false;
      if (targetSlot.mesh) targetSlot.mesh.visible = false;
      ghostMesh.visible = false;
    }
    for (let j = guideUsed; j < guideSlots.length; j++) {
      if (guideSlots[j].mesh) guideSlots[j].mesh.visible = false;
      guideSlots[j].key = '';
    }
    for (let j = dotUsed; j < potDots.length; j++) {
      if (potDots[j]) potDots[j].visible = false;
    }

    // ---- 上一杆轨迹 ----
    const trail = view.trail;
    if (trail && trail.length && view.state !== 'moving') {
      const age = (performance.now() - view.trailTime) / 1000;
      const alpha = age < 1.6 ? 0.55 * (1 - age / 1.6) : 0;
      // key 里**不含** alpha：淡出时 alpha 每帧都在变，带上它就会每帧重建
      // 22 条条带的几何体。几何体只在杆数/点数变化时重建。
      let tk = '';
      for (let i = 0; i < trail.length; i++) tk += (trail[i].pts ? trail[i].pts.length : 0) + ',';
      if (tk !== trailKey) {
        trailKey = tk;
        for (let i = 0; i < trail.length; i++) {
          const t = trail[i];
          if (!trailRibbons[i]) {
            trailRibbons[i] = { mesh: null };
            trailRibbons[i].mesh = new THREE.Mesh(
              new THREE.BufferGeometry(),
              new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false })
            );
            trailRibbons[i].mesh.renderOrder = 4;
            scene.add(trailRibbons[i].mesh);
          }
          const pts = t.pts || [];
          const geo = ribbonGeometry(pts, 2.6, 0.4);
          trailRibbons[i].mesh.geometry.dispose();
          trailRibbons[i].mesh.geometry = geo || new THREE.BufferGeometry();
          const rgba = /rgba?\((\d+),(\d+),(\d+)/.exec(t.color || '');
          const col = rgba ? new THREE.Color(+rgba[1] / 255, +rgba[2] / 255, +rgba[3] / 255) : new THREE.Color(0xaaaaaa);
          trailRibbons[i].mesh.material.color.copy(col);
          trailRibbons[i].mesh.material.opacity = alpha;
          trailRibbons[i].mesh.visible = !!geo && alpha > 0.01;
        }
        // 上一杆球多、这一杆球少（抢黑复位）时，多出来的条带要藏掉
        for (let i = trail.length; i < trailRibbons.length; i++) {
          if (trailRibbons[i]) trailRibbons[i].mesh.visible = false;
        }
      } else {
        for (let i = 0; i < trailRibbons.length; i++) {
          if (trailRibbons[i]) trailRibbons[i].mesh.material.opacity = alpha;
        }
      }
    } else if (trailRibbons.length) {
      for (let i = 0; i < trailRibbons.length; i++) {
        if (trailRibbons[i]) trailRibbons[i].mesh.visible = false;
      }
      trailKey = '';
    }

    // ---- 球杆 ----
    const showCue = cb && cb.isOnTable() &&
      (view.state === 'aim' || view.state === 'powering' ||
       view.state === 'dragging' || view.state === 'stroking');
    if (showCue) {
      cueGroup.visible = true;
      cueGroup.position.set(X(cb.x), BALL_R, Z(cb.y));
      cueGroup.rotation.y = -(view.aimAngle || 0);
      const strokePull = view.strokePull || 0;
      const pull = 16 + (view.power / C.MAX_POWER) * 90 + strokePull * 90;
      // cueMesh 的原点在杆头，所有分段沿 -X 展开
      cueMesh.position.x = -pull;
      cueTip.position.x = -(pull + 3.5);

      // ---- 球杆俯仰最低角：避免杆身穿过库边 ----
      // 球杆从球心往后延伸约 620px。库边木框顶面高 17px，而杆头基准高度
      // 只有 15px，所以平杆时杆身必然穿过库边。这里按"身后库边有多远"
      // 反算最低仰角，让杆身越过库边鼻线时已经高于木框顶。
      // 只改视觉俯仰，不改变玩家设置的实际击球俯仰/旋转。
      const a = view.aimAngle || 0;
      const bdx = -Math.cos(a), bdy = -Math.sin(a);
      let backDist = Infinity;
      if (bdx < -1e-6) backDist = Math.min(backDist, (C.L + BALL_R - cb.x) / bdx);
      else if (bdx > 1e-6) backDist = Math.min(backDist, (C.R - BALL_R - cb.x) / bdx);
      if (bdy < -1e-6) backDist = Math.min(backDist, (C.T + BALL_R - cb.y) / bdy);
      else if (bdy > 1e-6) backDist = Math.min(backDist, (C.B - BALL_R - cb.y) / bdy);

      let minPitch = 4 * Math.PI / 180;
      if (isFinite(backDist)) {
        const need = 5;                    // 木框顶 - 杆头基准 + 杆半径余量
        minPitch = Math.max(minPitch, Math.atan2(need, Math.max(12, backDist)));
        // 贴库时平杆怎么都不够，强制把杆尾抬到约 30°
        if (backDist < 26) minPitch = Math.max(minPitch, 0.52);
      }
      // 后斯诺克：背后有球/库边挡杆时，杆必须从它上面跨过去。
      // 这个角度由 cueclear.js 算，和盘面可击球面是同一套几何。
      if (view.cueBlockPitchDeg > 0) {
        minPitch = Math.max(minPitch, view.cueBlockPitchDeg * Math.PI / 180);
      }
      minPitch = Math.min(minPitch, C.PITCH_MAX_DEG * Math.PI / 180);
      const visPitch = Math.max((view.pitchDeg || 0) * Math.PI / 180, minPitch);
      // 俯仰：绕原点（球心）转，杆尾抬起、杆头仍贴着球
      if (cueTilt) cueTilt.rotation.z = -visPitch;
      // 球杆稍微抬起一点，俯视时能看到高光和阴影，不是一根线
      cueGroup.position.y = BALL_R + 5;

      // 架杆：白球离"身后那条库"太远 → 在球杆中段支一个桥。
      if (cueRest) {
        const restDist = Math.min(backDist - 24, 170);
        // 只有白球确实离身后库边很远时才需要架杆；开局白球在 D 区，
        // 离库边只有 200 多像素，不应该一直顶着个木架子。
        if (backDist > 470 && restDist > 80) {
          cueRest.visible = true;
          cueRest.position.set(
            X(cb.x + bdx * restDist), 0.03, Z(cb.y + bdy * restDist)
          );
          cueRest.rotation.y = -a;
        } else {
          cueRest.visible = false;
        }
      }
    } else {
      cueGroup.visible = false;
      if (cueRest) cueRest.visible = false;
    }

    // 观战镜头的状态机（闲置→巡游、跟球、起飞阻尼）都在这里推进。
    updateCamera(dt, balls);
    // 偶尔插入的击球者第一视角；混合权重在这里推进。
    updateShotCamera(dt, view);

    // 吊灯只在**透视机**下露出来。俯视图下它们是压在台面上的三个大圆 ——
    // 正上方看过去，620px 高的灯罩就投影在台呢正中。藏的是外层 g 里的内层 vis，
    // 所以灯（SpotLight）照旧亮着，只是"看不见"了；连带灯罩的投影也一起消失。
    // ⚠ 判据是 perspCam 而不是 spectating：观战的头几秒还是俯视（正交），
    //   那几秒里灯同样必须藏着，否则一进观战台呢上就糊三个圆。
    if (lampVisOn !== perspCam) {
      lampVisOn = perspCam;
      for (let i = 0; i < lampVis.length; i++) lampVis[i].visible = lampVisOn;
      // 横梁和浮尘同理：正交俯视时它们会像脏东西一样压在台呢上。
      for (let i = 0; i < ceilingVis.length; i++) ceilingVis[i].visible = lampVisOn;
      if (dust) dust.visible = lampVisOn;
    }

    updateAmbient(perfNow());

    // 每帧只渲染一台相机：巡游/接管时是透视轨道机，其余永远是那台标定好的正交机
    renderer.render(scene, shotRenderCamera());
  }

  SNK.render3d = {
    available: function () { return typeof THREE !== 'undefined'; },
    on: false,
    init: init,
    render: render,
    // ---- 观战镜头（主循环只在观战时调用）----
    setSpectate: setSpectate,
    spectating: function () { return spectating; },
    setOrbit: setOrbit,
    orbitActive: orbitActive,
    pickTable: pickTable,
    resetView: resetView,
    notifyActivity: notifyActivity,
    orbitDrag: orbitDrag,
    orbitPan: orbitPan,
    orbitZoom: orbitZoom,
    orbitReset: orbitReset,
    orbitNudge: orbitNudge,
    // ---- 光照氛围 ----
    ambience: function () { return ambName; },
    ambienceKeys: function () { return AMB_KEYS.slice(); },
    setAmbience: function (name) { applyAmbience(name, true); },
    onAmbience: function (fn) { if (typeof fn === 'function') ambListeners.push(fn); },
    // 调试用：只读拿到场景/相机，方便在控制台核对物体位置/数量
    _scene: function () { return scene; },
    _camera: function () {
      if (perspCam && shotCam.w > 0.001 && camBlend) return camBlend;
      return perspCam ? camPersp : camOrtho;
    },
    _shotCam: function () {
      return {
        active: shotCam.active, w: shotCam.w, target: shotCam.target,
        stopping: shotCam.stopping, lastState: lastViewState,
        followIdx: shotCam.followIdx, switched: shotCam.switched,
        pos: { x: shotCam.pos.x, y: shotCam.pos.y, z: shotCam.pos.z },
      };
    },
    _info: function () { return renderer ? renderer.info.render : null; },
  };
})(window.SNK = window.SNK || {});
