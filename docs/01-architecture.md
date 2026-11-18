# 01 项目概览与架构

## 1. 设计目标

项目从一开始就按“离线可玩的单页游戏”设计，约束非常明确：

1. 双击 `index.html` 就能玩，不能要求用户开本地服务器。
2. 不使用构建工具，不引入 npm 依赖，不把源码编译成 bundle。
3. 不依赖后端，存档只进 `localStorage`。
4. 声音不能使用外部音频文件，必须运行时合成。
5. AI 不能“作弊”：它说能进的球，必须用玩家出杆同一套物理跑得出来。

这些约束决定了很多实现方式。比如：

- 所有模块用 IIFE 挂到全局 `window.SNK` 上，避免 ES Module 在 `file://`
  下的跨文件限制。
- three.js 直接放在 `vendor/`，不经过打包器。
- AI 搜索和玩家预览共用 `js/sim.js`，而不是两套近似公式。
- 背景音乐和音效使用 Web Audio 的振荡器、噪声和滤波器实时生成。

## 2. 文件分层

```text
index.html              页面骨架、HUD、控制条、弹窗
css/
  style.css             布局、主题、状态行、动画
  fonts.css             内嵌字体（base64，file:// 可用）
js/
  constants.js          台面尺寸、球色、物理常数、袋口、球杆几何
  cueclear.js           后斯诺克：球杆被挡时的可击球面与最小仰角
  physics.js            球体运动、碰撞、库边、落袋、复位
  rules.js              斯诺克/8球/9球裁判
  sim.js                单杆模拟器：克隆球局 → 击球 → 跑完 → 返回结果
  planner.js            三点规划的反向搜索
  ai-style.js           AI 选球加权：特征提取、球局开放度、球员权重
  ai.js                 AI 候选枚举、搜索、防守、开球、决策
  ai-pool.js            AI 搜索的 Web Worker 线程池
  render.js             2D 俯视渲染
  render3d.js           three.js 场景与 3D 渲染
  bgm.js                Web Audio 音乐、音效、环境声、胜利欢呼
  celebration.js        胜利彩纸 Canvas 效果
  save.js               存档序列化与 localStorage
  i18n.js               中英文界面与球名
  chatter.js            球员性格对话
  tutorial.js           教学课程数据、摆球、演示、判定
  main.js               游戏状态、输入、主循环、UI 编排
  selftest.js           浏览器自检
vendor/
  three.min.js          three.js r149
docs/                   本套开发文档
```

## 3. 脚本加载顺序

`index.html` 底部的顺序是刻意排的：

```text
constants → cueclear → physics → rules → sim → planner
→ ai-style → ai → ai-pool → render → three.js → render3d
→ bgm → celebration → save → i18n → chatter → tutorial → main → selftest
```

原因：

- `constants.js` 定义 `SNK` 命名空间和所有基础常量。
- `cueclear.js` 被 `physics.js` 的 `strike()` 调用。
- `physics.js` 被 `sim.js`、`main.js` 和 AI 共用。
- `rules.js` 只依赖常量和球对象，必须在 `sim.js` 之前。
- `ai-style.js` 被 `ai.js` 的画像初始化使用，必须在 `ai.js` 之前。
- `ai-pool.js` 要用 `SNK.ai` 的 `searchSlice`。
- `render3d.js` 依赖 `vendor/three.min.js`。
- `main.js` 最后启动主循环，`selftest.js` 再挂自检入口。

Worker 的加载顺序在 `ai-pool.js` 里单独维护：

```text
constants, cueclear, physics, rules, sim, ai-style, ai
```

这段列表容易漏。新增 AI 依赖的脚本时，必须同时改 `index.html` 和
`ai-pool.js`，否则主线程能跑、Worker 里会报 `SNK.aiStyle is undefined`。

## 4. 全局状态 G

`main.js` 里有一个大对象 `G`，保存一局游戏的全部可变状态。重要的字段：

| 字段 | 作用 |
|---|---|
| `balls` | 球对象数组，白球是 `label === 'white'` |
| `cueBall` | 白球快捷引用 |
| `gameMode` | `classic` / `eightball` / `nineball` / `clearance` / `respottedBlack` |
| `state` | `aim` / `shooting` / `over` / `placing` 等 |
| `currentPlayer` | 0 或 1 |
| `scores` | 双方比分 |
| `needRed`、`pottedRedThisTurn` | 当前该打红球还是彩球 |
| `aimAngle`、`power`、`spinX`、`spinY`、`pitchDeg` | 当前出杆参数 |
| `aiThinking` | AI 是否正在思考 |
| `opening` | 本局第一杆，交给开球搜索 |
| `noPotStreak` | 每位球员连续没进球的杆数 |
| `negativeStreak` | 连续消极/贴球杆数 |
| `preShot`、`preShotSnookered` | 犯规后重解用的出杆前快照 |
| `tutorial` | 当前教学状态 |
| `plan` | 三点规划状态 |
| `chalks` | 库边粉块位置 |
| `shotCount`、`chalkAt` | 粉块出现节奏 |

`G` 是单局状态，不做不可变更新。AI 搜索时会克隆球局，不直接改 `G.balls`；
真正应用结果时走 `simulateShot` 和 `advanceWorld`。

## 5. 主循环

主循环在 `main.js` 底部，大致分四步：

1. `requestAnimationFrame` 驱动。
2. 如果球在运动，调用 `stepWorld(G.balls, events)` 推进一步，并处理碰撞音效。
3. 渲染 2D 或 3D。
4. 球全部停稳后进入 `onSettled()`：裁判、计分、换人、AI 调度、教学/规划检查。

物理步进和渲染帧率解耦得比较粗：每次 `rAF` 调一次 `stepWorld`。这样在
普通刷新率下稳定，低帧率时物理会变慢，但不会出现“球瞬移”。项目没有做
固定时间步累加器，原因是单页游戏的球速和台面尺寸已经按帧调好，加入累加器
会改变所有手感，收益不大。

## 6. 2D 与 3D 的关系

2D 和 3D 不是两套游戏，只是两个渲染器：

- `render.js` 用 Canvas 2D 画俯视图，负责辅助线、轨迹、HUD 叠加。
- `render3d.js` 用 three.js 画场景、球、球杆、灯、袋口、粉块。
- 两者都读同一份 `G.balls` 和 `G.view` 状态。
- 3D 有“俯视正交”和“透视轨道”两种相机；2D 始终是正交俯视。

切换视图不会重置球局或瞄准参数。3D 轨道下，鼠标拖动旋转相机；2D 下鼠标
直接控制瞄准方向。

## 7. 固定逻辑画布

游戏的逻辑画布固定为 `1416 × 736`，CSS 再按窗口等比缩放。这样做的好处：

- 台面坐标、袋口位置、球半径在所有屏幕上一致。
- 鼠标坐标只需要从 CSS 像素换算回逻辑像素。
- 3D 相机的正交视锥也可以跟逻辑画布对齐。
- UI 行高变化不会挤压台面。

早期版本曾把教学/规划 HUD 做成控制条里的一行，结果一显示就把球台挤小；
后来把这两个面板收进固定 22px 的状态行，台面尺寸不再随 UI 变化。

## 8. 模块之间的“单一事实来源”

项目里最重要的三个“单一事实来源”：

1. **物理**：`stepWorld()`。玩家出杆、AI 模拟、规划搜索、自检复现都用它。
2. **规则**：`rules.judge()`。实机结算和 AI 模拟判罚都用它。
3. **出杆几何**：`cueclear.fitContact()`。玩家、AI、预览共用同一套抬杆和
   击点夹紧逻辑。

只要这三处保持单一实现，AI 就不会出现“它以为能进、实机却不进”的系统性
偏差。自检脚本的核心就是验证这一点。

## 9. 离线与存档

`file://` 下没有网络请求，所有资源都在本地：

- 字体用 base64 内嵌。
- three.js 放 `vendor/`。
- 音频运行时合成。
- 存档用 `localStorage`，键名由 `save.js` 管理。

存档保存球位、比分、当前玩家、模式、连续不进球计数、教学进度等。读档后
不会重新摆球，也不会把 AI 思考状态带回来；`main.js` 会恢复到“等待出杆”。

## 10. 为什么不用框架

这个项目的核心复杂度在物理、AI 和 3D，不在组件树。引入 React/Vue 会带来：

- 构建步骤，破坏“双击即玩”。
- 状态同步层，和 `requestAnimationFrame` 的逐帧更新容易打架。
- 包体积和 `file://` 路径问题。

原生 DOM 足够：HUD 用 `textContent` 更新，弹窗用 `hidden` 切换，Canvas 自己
画游戏画面。代价是 `main.js` 比较大，所以后文按职责拆开讲。
