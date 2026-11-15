# 04 AI 选球加权

## 1. 为什么需要这一层

旧 AI 只有一个总分：

```text
进球分值 + 走位价值 + 彩球加成 - 切角惩罚
```

它能打进球，但选球不像人。典型表现：

- 明明有一颗贴袋口的简单黑球，却去远台做斯诺克。
- 同等分值下不区分长台、薄球、翻袋、组合球。
- 球员画像只能靠 `colorBias`、`comfortW` 这类零散参数调，风格差异很小。
- 连续不进球后的“必须拼一杆”对所有球员用同一个阈值。

2026-11-15 新增 `js/ai-style.js`，把一杆拆成可解释的特征，再按球员权重
合成得分。搜索仍然用原来的 `value` 选前几名，加权只在前几名里重排，避免
为了风格把搜索剪枝改坏。

## 2. 九个特征

| 特征 | 代码 | 含义 |
|---|---|---|
| 进球概率 | `potProb` | 切角、距离、目标球行程、加塞量折算；有误差画像用 `robustRate` 的真实成功率 |
| 击球距离 | `distance` | 白球到幽灵点的距离 |
| 薄厚/切角 | `thin` | `cut / 1.36`，0 = 正球，1 = 极限薄球 |
| 加塞量 | `spin` | `hypot(spinX, spinY) / 0.75` |
| 母球走位距离 | `cueTravel` | 白球从接触点/出杆点继续走的距离 |
| 目标球行程 | `objectTravel` | 目标球到袋口的距离 |
| 防守难度 | `safetyDifficulty` | 对手无进球线、无直击线、白球孤立、后斯诺克限制 |
| 击球复杂度 | `complexity` | 翻袋/组合/一库/加塞/切角/实际撞库次数 |
| 球局开放程度 | `openness` | 红球最近邻平均距离；满堆约 0.1，散开接近 1 |

### 防守难度

`opponentView()` 返回：

```text
potLines   对手能打进的线路数
hitLines   对手能直接碰到的目标数
ease       最好那条线有多舒服
cush       白球是否贴库
cueNear    白球离最近球多远
crowd      白球周围挤了几颗球
escape     对手最近目标离白球多远
cueBlock   后斯诺克限制值
```

`ai-style.safetyDifficulty()` 折算：

```text
potLines === 0        +0.50
hitLines === 0        +0.28
escape / 900          +0.12
cueBlock              +0.08
cueNear 孤立度        +0.08
```

0 = 留了一台好球，1 = 零漏球/必须多库解。

## 3. 进攻评分

`scorePot()` 的核心：

```text
futureRaw   = max(0, 搜索价值 - 本杆得分)
future      = clamp(futureRaw / 26, 0, 1)
breakValue  = min(futureRaw, 45) * breakWeight * 0.8
immediate   = 本杆得分 + (gameOver ? 18 : 0)

attack = (immediate + 4.6 * future + breakValue)
       * (0.62 + 0.95 * potWeight * potProb)
       * (0.82 + 0.36 * openBefore)

risk = (1 - potProb) * (8.0 + 12.0 * openBefore) * riskCost

cost = distanceCost * distance * 2.2
     + thinCost * thin * 1.8
     + spinCost * spin * 1.0
     + cueTravelCost * cueTravel * 1.6
     + objectTravelCost * objectTravel * 1.2
     + complexityCost * complexity * 2.0

openReward = opennessValue * (openAfter - 0.5) * 1.4

score = attack - risk - cost + openReward
```

几个设计点：

- `potWeight` 同时乘在命中概率上：高权重球员更愿意选“把握大”的球。
- `breakValue` 单独保留连续进攻价值。没有它，AI 会变成“每杆挑最好进的
  球”，单杆很短。
- `risk` 在低命中率时惩罚很重；这是“不要用远台斯诺克换简单黑球”的另一半。
- `openAfter` 用打完后的球局开放度，鼓励拆球堆/打开局面。

## 4. 防守评分

```text
leave = safetyValue * (1.20 + 4.80 * safetyDifficulty)
      + opennessValue * (1 - openAfter) * 1.6

cost = cueTravelCost * cueTravel * 0.8
     + complexityCost * complexity * 0.45
     + distanceCost * 0.25

score = leave - cost
```

防守分不直接和进攻分在同一个“分数单位”上比较，而是在球员阈值以下时
才额外搜一杆防守，再比较两者。

## 5. 候选选择流程

### 同步路径

1. `searchBest()` 先按旧 `value` 取前 10。
2. `C.aiStyle.choosePot(top, prof, ctx)` 给每杆算 `styleScore`。
3. 取加权分最高的一杆作为 `best`。
4. 有出杆误差的画像再用 `rerankRobust()` 按“加权分 × 成功率”重排。
5. 如果 `potScore < prof.tactics.compareSafety`，额外跑一杆安全球搜索。
6. 安全球必须比进攻高 `0.45` 分以上才改选防守，避免两个分数接近时摇摆。
7. 否则出杆。

### Worker 路径

1. Worker 里跑 `searchBest()`，`packEntry()` 把 `styleScore` 带回来。
2. 主线程 `mergeParts()` 合并 top。
3. `chooseFromTop()` 有误差画像先 `rerankRobust`；否则按 `styleScore` 选。
4. `shouldCompareSafety()` 判断要不要再跑安全球。
5. 安全球 worker 返回 `styleScore`，主线程比较。

两条路径共用 `ai-style.js` 的评分，避免“浏览器里一个风格、Worker 里另一个
风格”。

## 6. 球员权重

`PROFILES` 里每个画像带 `tactics` 和 `forceAfter`。

| 球员 | potWeight | distanceCost | thinCost | complexityCost | safetyValue | compareSafety | breakWeight | forceAfter |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Novice | 0.80 | 1.10 | 1.10 | 1.00 | 1.00 | 3.0 | 0.75 | 3 |
| Amateur | 0.95 | 0.90 | 0.90 | 0.75 | 1.00 | 3.6 | 0.75 | 3 |
| Veteran | 1.15 | 0.55 | 0.55 | 0.50 | 0.90 | 6.0 | 0.85 | 3 |
| Master 147 | 1.55 | 0.22 | 0.22 | 0.20 | 0.55 | 2.5 | 1.15 | 2 |
| Ronnie O'Sullivan | 1.42 | 0.48 | 0.46 | 0.30 | 0.62 | 5.0 | 0.95 | 2 |
| John Higgins | 1.02 | 0.86 | 0.88 | 0.86 | 1.65 | 13.0 | 0.78 | 4 |
| Judd Trump | 1.20 | 0.20 | 0.28 | 0.24 | 0.42 | 3.5 | 0.82 | 2 |
| Ding Junhui | 1.24 | 0.52 | 0.50 | 0.46 | 0.86 | 9.0 | 1.00 | 3 |
| Mark Selby | 0.92 | 0.96 | 1.00 | 0.95 | 1.85 | 15.0 | 0.68 | 5 |

读表方式：

- `distanceCost` 越低，越不怕长台。Trump 0.20，Selby 0.96。
- `complexityCost` 越低，越愿意翻袋/组合/多库。Ronnie 0.30，Selby 0.95。
- `safetyValue` 越高，越看重把对手做死。Selby 1.85，Higgins 1.65。
- `compareSafety` 越高，越容易触发“进攻和防守比较”；不是越高越防守，
  还要看 `safetyValue` 和实际防守分。
- `forceAfter` 是连续几杆没进球后强制拼一杆的阈值。

## 7. 连续不进球阈值

旧逻辑所有球员统一 3 杆。现在：

- Master/Ronnie/Trump：2 杆。
- Veteran/Ding：3 杆。
- Higgins：4 杆。
- Selby：5 杆。

`main.js` 的 `publicState()` 按当前 AI 画像算 `forcePot`，界面提示的文字也
同步该阈值。AI 内部仍然会再判断一次，防止外部状态没传对。

## 8. 调参时踩过的坑

### 8.1 只按当前得分选，单杆变短

第一版加权把 `future` 压到 0~1，最多加 4.6 分。结果 AI 开始选“好进的
1 分红球”，不选“稍微难一点但下一杆是黑球”的球。无头对局最高单杆从 83
掉到 48。

解决：加 `breakValue`，按搜索价值与当前得分的差值给连续进攻价值，并给
Master/Ronnie/Ding 更高权重。改完无头大师对局回到 107 单杆。

### 8.2 `rerankRobust` 拿到没有 value 的 entry

`searchBest()` 原来只给最终 `best.entry` 挂 `value/world`。`rerankRobust()`
会从 `top` 里挑别的杆，那些 entry 没有 `value`，加权分重算时变成 0，导致
决策分和候选分对不上。

解决：对 `top` 里每个 entry 都挂 `value`、`world`、`styleScore`，不只挂
当前 best。

### 8.3 只给当前 best 挂 world，开放度算错

加权选择时 `best` 是重新构造的对象，最初漏了 `world` 字段。`scorePot()` 拿
不到打完后的球局，`openAfter` 退回 `openBefore`。虽然影响不大，但会让候选
分和最终分不一致。

解决：`best = { ..., world: pick.world }`，并在 top 循环里统一挂 world。

### 8.4 简单球被防守换掉

如果无条件比较进攻和防守，防守分在“完美斯诺克”时可能很高，简单黑球反而
被换掉。

解决：只在 `potScore < compareSafety` 时比较；比较时安全球还必须高出
`0.45` 分。简单黑球的加权分通常在 50~100，远高于阈值。

### 8.5 加权只加在搜索排序，没加在防守选择

最初 `safetySearch()` 仍按 raw `snookerScore` 选最佳防守，球员的
`safetyValue` 只影响最终比较，不影响选哪一杆防守。

解决：`safetySearch()` 同时维护 raw 最优和加权最优；有 `styleScore` 时按
加权分选，没有时才退回 raw score。这样 Selby/Higgins 的防守落点会和
Ronnie 不同。

### 8.6 Worker 漏加载 ai-style.js

`ai-pool.js` 的 `importScripts` 列表如果只加 `ai.js`，Worker 里
`SNK.aiStyle` 是 undefined，主线程正常、AI 回合却回退同步路径。

解决：`files` 列表加 `ai-style.js`，并写了 Worker 路径的浏览器测试。

## 9. 验证结果

2026-11-15 的验证：

- 浏览器自检 `index.html?selftest=1`：一致率 100%，不匹配 0，异常 0。
- 大师无头对局（虚拟时钟，2600 ticks）：最高单杆 107，清台。
- 浏览器自检预算下当次最高单杆 73（预算和局面会影响）。
- 防守后对手无球可下约 22.7%。
- 贴袋口黑球场景：所有画像都选黑球，没有选斯诺克。
- Worker 路径：黑球场景返回 `pot`，`styleScore` 正常。

## 10. 后续可调项

- `compareSafety` 和 `safetyValue` 是风格旋钮，改之前先用无头对局看单杆和
  防守比例。
- `breakWeight` 影响单杆长度，不要为了“更像人”压得太低。
- `staticPotProb()` 只是几何近似；有误差画像的真实概率来自 `robustRate()`，
  两者不要混用。
- 增加新球员时，先复制一个相近画像，再只改 2~3 个权重，避免一次改太多
  无法归因。
