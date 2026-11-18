# 09 测试与调试

## 1. 测试目标

这个项目最怕的不是“某个按钮点不开”，而是**AI 和实机不一致**：

- AI 说这杆能进，实机却进不了；
- AI 说安全，实机判犯规；
- AI 的力度估计和物理模型对不上；
- Worker 路径和主线程路径决策不同。

所以测试的核心是“同源复现”，不是追求覆盖率数字。

## 2. 浏览器自检

打开：

```text
index.html?selftest=1
```

`selftest.js` 会在控制台输出测试结果，并把摘要写进状态行。

### 测试 A：AI 声称 vs 独立复现

随机生成经典局面，让 AI 决策，然后拿它给出的杆法独立重跑：

1. `simulateShot` 跑一遍；
2. `rules.judge` 重新判罚；
3. 对比 AI 的 `kind`/结果和实际结果。

统计：

- 进攻杆：AI 说能进，复现是否真进；
- 防守杆：AI 说安全，复现是否合法；
- 兜底；
- 不匹配数；
- 异常数。

当前结果：24 个局面，不匹配 0，异常 0，一致率 100%。

### 测试 B：大师连续进攻

从标准开球台面开始，让 Master 147 一直打，统计：

- 出杆数；
- 犯规数；
- 最高单杆；
- 比分；
- 剩余红球/彩球；
- 是否清台。

当前浏览器预算下当次最高单杆 66；无头虚拟时钟下 Master 对局最高单杆 142。

### 测试 C：决策耗时

对 easy/medium/hard/master 各跑若干随机局面，统计平均/最大耗时。用来发现：

- 搜索预算失控；
- 某档位被预算截断；
- Worker 不可用时同步路径卡顿。

### 测试 D：防守质量

打完整局，统计每杆结束后对手的进球线路数：

- 0 条 = 对手无球可下；
- 1 条 = 只剩一条；
- 平均线路数。

当前防守后对手无球可下约 22.7%。

### 测试 F：斯诺克质量

对每一杆防守，检查对手接手时：

- `potLines = 0`：一颗都打不进；
- `hitLines = 0`：连直击都够不到；
- 两者都 0：只能撞库解。

这是“真斯诺克”的质量指标。

## 3. 无头对局

用 Node 加载同一份脚本，构造标准球局，循环：

```text
AI decide → simulateShot → judge → advanceWorld → 更新 state
```

用途：

- 快速比较不同画像的单杆/防守比例；
- 调 `tactics` 权重；
- 检查是否死循环；
- 检查犯规。

跑分时建议打开虚拟时钟：

```js
SNK.ai.setVirtualClock(true, 0);
```

预算参数的含义变成“允许模拟多少杆”，同一局面结果可复现。

一个最小对局循环的伪代码：

```js
const d = SNK.ai.decide(state, balls, { level: 'master', budgetMs: 2600 });
const sim = SNK.sim.simulateAndJudge(state, balls, d.shot);
balls = SNK.ai.advanceWorld(sim.res, sim.verdict);
// 根据 verdict.turnContinues / nextNeedRed 更新 state
```

## 4. 语法检查

提交前至少：

```powershell
node --check js/ai-style.js
node --check js/ai.js
node --check js/ai-pool.js
node --check js/main.js
```

所有脚本都过一遍更稳：

```powershell
Get-ChildItem js/*.js | ForEach-Object { node --check $_.FullName }
```

## 5. 无头浏览器

项目不使用 npm，所以测试可以用本机 Chrome 的 headless 模式：

```powershell
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$url = "file:///C:/.../SnookerAI147/index.html?selftest=1"

& $chrome --headless=new --disable-gpu `
  --allow-file-access-from-files `
  --autoplay-policy=no-user-gesture-required `
  --virtual-time-budget=45000 `
  --enable-logging=stderr --v=0 `
  --dump-dom $url 2>&1
```

关键 flag：

- `--allow-file-access-from-files`：允许 `file://` 加载脚本；
- `--autoplay-policy=no-user-gesture-required`：避免音频阻塞；
- `--enable-logging=stderr`：把 `console.log` 打到 stderr；
- `--virtual-time-budget`：给自检足够时间。

用 `Select-String` 过滤“一致率/最高单杆/Uncaught”即可。

### Worker 路径测试

`ai-pool.js` 用 Blob Worker，测试时要确认：

1. `ai-pool.js` 的 `files` 列表包含 `ai-style.js`；
2. Worker 能 `importScripts` 加载所有依赖；
3. 主线程 `chooseFromTop` 能拿到 `styleScore`；
4. Worker 失败时能回退同步 `decide()`。

一个简单测试页加载 `constants → ... → ai-style → ai → ai-pool`，构造贴袋口
黑球，调用 `SNK.aiPool.decide(...)`，检查返回 `kind === 'pot'`。

## 6. 调试 AI 决策

看一杆为什么被选中，建议临时输出：

- `best.value`；
- `best.styleScore`；
- `entry.potProb`；
- `entry.cand.ball.label`；
- `entry.cand.cut`；
- `entry.tag`；
- `entry.world` 是否存在。

不要只看最终 `kind`。很多问题来自：

- 候选没找到；
- 找到了但 `pickSafetyAbove` 拒绝；
- `rerankRobust` 换了杆；
- `styleScore` 因为 `value/world` 缺失被算成 0；
- 防守比较阈值过高/过低。

## 7. 调试 UI

- 用 `?selftest=1` 先确认游戏能跑。
- 打开 DevTools，看 `Uncaught` 和 `SNK` 是否完整。
- 检查 `G` 状态：`balls`、`state`、`aimAngle`、`power`。
- 检查 Canvas 尺寸：CSS 尺寸和逻辑 1416×736 的换算。
- 3D 问题先切回俯视正交，确认球位对不对，再看轨道相机。

## 8. 回归清单

每次改 AI/物理/UI 后：

1. `node --check` 所有改动脚本。
2. `index.html?selftest=1`，一致率必须 100%。
3. 普通对局：能开球、能进球、能换人、能存档。
4. 教学模式：能进课程、能通过一步、能退出恢复对局。
5. 三点规划：能搜索、能 Apply、能解锁。
6. 3D：俯视/轨道都显示球、袋口、粉块。
7. Worker：控制台无 `SNK.aiStyle is undefined`。
8. 听声音：击球轻/重有明显区别，碰撞不连续爆音。

## 9. 测试的边界

- 自检只覆盖随机经典局面，不覆盖所有 8 球/9 球规则组合。
- 无头对局用虚拟时钟，和浏览器真实预算下的结果可能不同。
- 物理是离散帧，极端高速/极薄球仍有模型误差。
- “100% 一致”指 AI 声称 vs 同一物理复现，不代表 AI 一定赢或一定清台。
