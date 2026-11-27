# 开发日志

按版本倒序记录每次改动：**先写看到的现象与证据，再写改了什么，最后写怎么验证的**。目的是让下一次改动的人（包括三个月后的自己）知道某个常量为什么是那个数、某段代码在防什么，而不是重新踩一遍。

写法约定：

- 每个条目挂**提交哈希**或**「未提交」**，否则不算记录。
- 数字必须是实测的，注明是怎么量的（哪个脚本、什么判据）。没有实测的地方写「待验证」，不写「应该会更快」。
- **踩过的坑单独记**，因为坑的复现成本最高、最容易被忘。尤其是「看起来在测量、其实什么都没测到」那一类。
- 判据比数字重要。同一个数在错误判据下会读成相反结论，这种情况要写明判据是怎么修正的。

| 版本 | 日期 | 提交 | 主题 |
| --- | --- | --- | --- |
| 0.2.2 | 2026-11-27 | `6aee5e6` | 抽搐：settle 从来没有真正建起来过 |
| 0.2.1 | 2026-11-27 | `2c3e28c` | 时间线遮挡：按钮锚到整个输入区，而不是卡片自己 |
| 0.2.0 | 2026-11-27 | `5ff02bc` | 滑移被提前结束时缓动收尾；颜色读取移出 mutation 回调 |
| 0.1.0 | 2026-11-26 | `fdbfd05` | 首次发布：逐字淡入、滑移跟随、行高卷动 |

---

## 0.2.2 — 抽搐：settle 从来没有真正建起来过

**提交**：`6aee5e6`（`Animate the column itself when a slide settles, and release 0.2.2`），已推 `dev`。版本号 `package.json:3` = `0.2.2`。

### 现象

用户在**含有多轮对话的会话**里，总结输出阶段看到「抽搐」——内容上下跳动。单轮新会话不明显。

### 证据

**一、`settleSlide()` 每次调用都抛异常。** 0.2.0 引入的收尾把列的位移缓动到零，但它写的是：

```js
const columnSettle = current.column.animate(...)
```

而 `startSlide` 存进 `current.column` 的是 **`column.animate(...)` 返回的 `Animation` 对象**（`src/follow/follow.js:432` 的 `column: columnSlide`）。`Animation` 没有 `.animate` 方法，所以这一行必然 `TypeError`。异常从 `onSlideResize` 抛出，被 `src/frame.js` 的 `runFrame` 里 `try { task.x(now) } catch (error) { reportError(error) }` 吞掉——页面不报错，只是**同一回调里后面的 `holdCheck()` 和 `consumePin()` 全部不执行**，而位移已经在 `stopSlide()` 里被 `cancel()` 归零。一次取消 = 一次单帧上跳。

这是 0.2.0 的回归：上一次修 settle 时只把 `counters` 换成 `elements: countersToAnimate`（因为 `Animation` 同样没有 `.animate`），漏掉了 `column` 这一处。**同一个错误在两处犯了两次，第二次没被工装发现。**

**二、`runCarried` 用错曲线。** settle 用 `SLIDE_SETTLE_EASE`（`cubic-bezier(0.33, 0, 0.2, 1)`）绘制，但 `runCarried` 一律按 `GLIDE_EASE`（`cubic-bezier(0.22, 0.61, 0.36, 1)`）读进度。两条曲线逐点差：

| t | glide | settle | 差 |
| --- | --- | --- | --- |
| 0.05 | 0.138 | 0.009 | 0.129 |
| 0.10 | 0.271 | 0.039 | 0.232 |
| 0.15 | 0.393 | 0.098 | 0.295 |
| **0.20** | **0.501** | **0.192** | **0.309** |
| 0.30 | 0.673 | 0.443 | 0.229 |
| 0.50 | 0.873 | 0.791 | 0.082 |
| 0.90 | 0.997 | 0.994 | 0.002 |

settle 走到 1/5 处时，按 glide 读会认为已经还了 0.501，实际只还了 0.192 —— 剩余距离少算 0.309×`from`。增长在这一刻到来，`startSlide` 从更小的数重启，列落到上一帧之上。

**三、`consumePin()` 的负 pin 把刚建的 settle 立刻取消。** `onSlideResize` 在 `delta < 0` 时调 `settleSlide()`，紧接着**同一个回调里**的 `consumePin()` 读到收缩造成的负 pin，执行 `if (pinned < 0) { stopSlide(); return }`。

### 改动

`src/follow/follow.js` 五处：

1. `startSlide` 的 `current` 加 `target: column`（元素本身）。
2. `settleSlide` 改用 `current.target.animate(...)`。注释记下了原因：`Animation` 没有自己的 `animate`，向它要一个会在 size 回调里抛，于是每次 settle 都丢失，而它本该承载的位移一帧内跟着丢。
3. `runCarried` 改成 `return run.from * (1 - easeValueAt(run.ease ?? GLIDE_EASE, linear))`，`settled` 带 `ease: SLIDE_SETTLE_EASE`。
4. `consumePin()` 的 `if (pinned < 0)` 从 `stopSlide()` 改成 `settleSlide()`（实测单帧 268 px）。
5. `settleSlide` 顶部加 `if (current.settling === true) return`，`settled` 带 `settling: true`。守卫的原因：一个已经在跑的 settle 会自己走到静止；触发它的那次收缩在下一帧还会再来一次（移动的 scroll 被同一回调读到），每次重建都从更短的距离重新起表，位移永远走不完自己的曲线。**加守卫之前实测：下落的每一帧都新建一个 settle 又取消一个。**

### 验证

**`test/settle-probe.mjs`（新增，已纳入 `npm test`）**：headless Chrome + `test/harness.html?hostpin`。给 `Element.prototype.animate` 打桩，对列上的每个动画记 `ledger`（`made` 带 `carried`/`from`/`dur`/`ease`，`cancel` 带 `carried`/`now`/调用栈），`carried` 在 `animate` 被调用前与 `cancel` 被调用后各读一次真实 `translateY`。序列：40 个 filler → 建 `[data-streaming]` 20px → 涨到 320px → **45ms 后**塌回 20px（让收缩落在滑动途中）→ 60ms 后涨到 220px → 静置 500ms。

四条断言，修复后 **4/4 通过**：

- `bundle applies in the harness loader`
- `the content never moves back down in a frame`（`worstBack 0`、`reversals 0`）
- `a shrink while an offset is carried makes a settle`（3 个 settle）
- `every handover keeps the offset it took over`（`carried` 与下一个 `from` 逐个相等）

修复后的 ledger（8 个动画、3 个 settle），每次交接的 `carried` 与 `from` 完全相等：

```
#1 carried=0       from=translateY(899px)
#2 carried=899     from=translateY(1200px)
#3 carried=1067.2  from=translateY(1087.19px)
#4 carried=721.34  from=translateY(721.34px)   dur=320  cubic-bezier(0.33, 0, 0.2, 1)
#5 carried=1.54    from=translateY(298.54px)
#6 carried=88.86   from=translateY(88.86px)    dur=320  cubic-bezier(0.33, 0, 0.2, 1)
#7 carried=46.74   from=translateY(235.74px)
#8 carried=23.79   from=translateY(23.79px)    dur=320  cubic-bezier(0.33, 0, 0.2, 1)
```

**真实多轮会话（`node test/bounce-ab.mjs 9501 fix-real "…"`，`flows: 37`）**：

```
seconds 28.3  samples 5309  framesWithOffset 1234
visualJumps 668  visualDown 0  visualUp 668
worstVisualDown 0  worstVisualUp -45.19
cancels 29  cancelsWithDistance 26  snaps 254  boundaries 0
biggestCancels left = 220 / 217 / 210 / 160
```

`visualDown` 恒为 0：内容从未向下移动。`cancels 29` 说明真实会话里滑移仍被频繁提前结束（宿主反复重挂流式容器），但每次都由 settle 接住，不再丢位移。

历史对照（同一脚本、同一提示词，`worstVisualUp` 是单调上移的最大单帧，不是跳变）：

| 标签 | 秒 | worstVisualUp | cancels | cancelsWithDistance | 最大 left |
| --- | --- | --- | --- | --- | --- |
| `base-true`（0.1.0 行为） | 15.5 | -45.09 | 25 | 24 | 203 |
| `bounce-fix2` | 17.1 | -17.28 | 23 | 19 | 149 |
| `fix-b` | 23.2 | -24.44 | 22 | 19 | 142 |
| `fix-real`（本版） | 28.3 | -45.19 | 29 | 26 | 220 |

**十个探针全绿**：reveal 19/19、follow 29/29、tail-press 6/6、jitter 4/4、race 2/2、burst 4/4、collapse 6/6、open 6/6、group 8/8、settle 4/4。

### 踩到的坑

**一、这个工装在修复前后的两个构建上都通过。** 用 `git stash push -- src/ lib/` 回到未修复的 `8e09eea` 跑，同样 `4/4` 通过、`worstBack 0`、`reversals 0`、抛出的异常为空。原因是收缩发生在滑动**已经跑完**之后（`cancel #2 carried=10.78`），此时 `runCarried` 返回 0，`settleSlide` 在 `left > 1` 之前就返回了，异常路径根本没走到。**修法：把收缩提前到滑动途中（`sleep(45)` 而不是 `sleep(70)`），并加一条「必须有 settle」的断言**——不看帧好不好看，只看「有位移要交出去的时候，有没有人接」。这条断言才是真正有区分力的那条。

**二、判据错了三次。**
- 第一版直接看 `translateY` 步长，报 `worstUp -89.42` —— 但滑移本来就该让内容上移。
- 第二版改成看合成位移 `ty - scrollTop`，仍然错：探针脚本自己写了三处 `scroll.scrollTop = scroll.scrollHeight`，与 `harness.html` 的 hostpin 观察器同时钉住同一次增长，`y` 走了 +399 而内容只长 200。
- 第三版把「快」当成错。`-53.3px` 那一帧经逐帧核对是 glide 曲线起步快（169ms 动画首帧走掉 27%），视觉位置单调上移。**抽搐是方向反转，不是速度**：内容先上移、又下落。判据最终改成数「内容向下移动」的帧。

**三、塌陷会让浏览器钳制 `scrollTop`。** 内容从 320px 塌到 20px 时 `scrollHeight` 变小，浏览器把 `scrollTop` 夹回去，`ty - scrollTop` 出现一个 -299px 的假位移，看起来像巨大的向下跳动。**修法：采样带上 `scrollHeight`，高度变化的帧整帧跳过**（实测每轮 13–24 帧被跳过）。

**四、PowerShell 正则批量改 `.mjs` 会把换行写进字符串字面量**，产生 `SyntaxError: Invalid or unexpected token`，还把文件尾部复制了一份。多行改动必须用编辑工具。

**五、注入进页面的脚本里 `'\n'` 会被模板字符串展开成真换行。** 所有反斜杠写两遍（`split('\\n')`）。

**六、`Animation.cancel` 被包装后 `animation.currentTime` 变 null**，要先读 `now` 再调原函数。

---

## 0.2.1 — 时间线遮挡

**提交**：`2c3e28c`（`Lift the button above the dock, not just above the card`），已推 `dev`。版本号 `package.json:3` = `0.2.1`。

### 现象

装了 `@deepseek-ai/dsh-timeline` 之后，任务时间线出现时，「回到底部」按钮压在时间线条带上，挡住右侧的进度百分比和展开按钮。截图（1594×109）里按钮正好盖住条带右端。

### 证据

真机 1400×900 量到的盒子（打开真实会话、时间线在场）：

```
section.timeline-dock     top 728  bottom 764  h 36   left 312  right 1061  w 749
div.timeline-dock-bar     top 728  bottom 764  h 36   left 328  right 1045  w 717
div.uV2eYG_card           top 770  bottom 870  h 100  left 312  right 1061  w 749
div.wSkVaW_composerStack  top 728  bottom 900  h 172  w 813
```

按钮原来的位置公式是 `bottom = window.innerHeight - cardBox.top + FOLLOW_TAIL_AIR_PX`，即 `900 − 770 + 12 = 142px`，按钮实际落在 **top 724 / bottom 758** —— 整条压在 728–764 上。

根因不在按钮，在锚点选错了：**时间线在卡片上方，而代码只看卡片自己的 `top`**。时间线注册在 `conversation.input.dock` 插槽，DSH 对该插槽的契约写的是「Full-width entries above the composer card」（`packages/client/ui-conversation/src/client/contract/slots.ts:351`），同一插槽还挂着 queue dock、todo dock、goal —— 也就是说**任何**这些 dock 出现，按钮都会被压住，时间线只是第一个被发现的。

更麻烦的是 DOM 形状：`wSkVaW_composerStack` 的两个子都是 `display: contents` 包装，第一个包 `section.timeline-dock`，第二个包 `uV2eYG_root`。**那层包装没有自己的盒子**，所以从卡片往上看一层，看到的仍然是「没有东西」，看不出上方还有 36px 的条带。

### 改动

1. `src/follow/follow.js` 新增 `composerBlockTop(card)`：从卡片往上走祖先，收集每个**有实际高度**的盒子顶端，取最高者作锚。两个停止条件 ——
   - `if (scroller !== null && parent.contains(scroller)) break`：越过装着对话滚动容器的那一层就停，再往上就是聊天区，继续走会把面板顶端当成输入区顶端。
   - `if (box.height > 0 && box.top < top)`：跳过 `display: contents` 的空盒子（它们报一个原点处的空盒）。
   `readTailPlacement` 里 `cardBox.top` 换成 `composerBlockTop(card)`。
2. `src/follow/params.js` 新增 `COMPOSER_CLIMB_DEPTH = 8`（实测四层到 stack、再两层到 scroller，留两层余量给将来多包一层）、`TAIL_MOVE_MS = 180`、`TAIL_MOVE_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'`。
3. `src/client.js` 给按钮的 `bottom`/`right` 各加 180ms 过渡；`prefers-reduced-motion: reduce` 时整条去掉。
4. `test/harness.html` 加 `#composerStack`（`display:flex`）包住 `#composerDock`（`hidden`，36px）与 `#composer`，把宿主的 dock 槽位形状搬进工装。
5. `test/follow-probe.mjs` 新增两条断言：`a dock above the composer lifts the button above it`（`gapAboveDock >= 0 && overlapsDock === false`）、`the lift is animated, not a jump`（`/bottom/.test(transition)`），断言里 `await window.__sleep(400)` 等过渡走完再量。
6. 中英 README 各补两段（锚点为什么是整个输入区、上移为什么是滑过去的）。

### 验证

**位置**（真机注入 36px dock，`wrap.style.display = 'contents'` 后插进 `wSkVaW_composerStack` 首位）：

```
before  { top: 724, bottom: 758 }        ← 压住 728–764
after   { top: 683, bottom: 717 }        ← 落在 728 之上
dock    { top: 728, bottom: 764 }
gapAboveDock: 11    overlaps: false    tailBottomVar: "184px"
```

**平滑性**（逐帧采样按钮 `getBoundingClientRect().top`，不等待固定时长、按经过时间取样）：

```
t=0     y=724        --tail-bottom: 142px
t=108   y=724        --tail-bottom: 184px   ← 变量已改，位移刚开始
t=115   y=687.2
t=122   y=686.1
t=126   y=685.3
t=137   y=684.6
t=204   y=682.1
t=320   y=682
```

中间每一帧都在变，不是瞬跳。CSS 变量是一次性从 `142px` 跳到 `184px` 的，过渡负责把这段距离走完。

**工装**：九个套件全绿（19/19、29/29、6/6、4/4、2/2、4/4、6/6、6/6、8/8）、`live.mjs` 13/13 + 2 skipped、`fold-live.mjs` 12/12。构建 `lib/client.js` 43592 B。

### 踩到的坑

- **CSS 模板字符串里的反引号**：`src/client.js` 的样式用模板字符串，注释里写了 `` `bottom` `` 当强调，esbuild 报 `src/client.js:47:4: ERROR: Expected ";" but found "bottom"` —— 反引号把模板字符串提前终止了。样式表里的注释一律不用反引号。
- **`live.mjs` 的规则数断言**：加了 reduced-motion 那条规则后规则总数从 10 变 11，断言写死 `=== 10` 于是失败（`FAIL the stylesheet carries the clip, the button placement and every fade step 11`）。改断言时同步改了注释，说明第三条规则是什么 —— 否则下次加规则又只看到「数字不对」。

---

## 0.2.0 — 滑移收尾与颜色读取

**提交**：`5ff02bc`（`Settle an ended slide instead of cancelling it, and release 0.2.0`）、`fbba3dd`（`Read a run's colour in the paint frame, not in the mutation callback`）。两个都在 `dev` 上，`main` 停在 `fbba3dd`。

### 现象一：总结输出时上下跳动

用户报「现在出现了总结输出的时候上下跳动的情况」。

### 证据一

判据修正过一次，这次修正本身是这条最重要的收获。

第一版 `test/bounce-ab.mjs` 只看列的 `translateY`（`ty`），统计出 `rawDown=34`、`rawUp=232`，看起来像剧烈跳动。但 `ty` 的向下移动与 `scrollTop` 的增量**一一对应** —— 那是宿主钉住增长、`ty` 做补偿的结果，**视觉上内容没动**。

改成看合成后的视觉位置 `visual = (after.ty - after.y) - (before.ty - before.y)`（`y` 是 `scroller.scrollTop`），并按帧间隔归一化到 16.7ms（headless 的 rAF 约 300Hz，原始每帧步长会低估读者在 60Hz 下看到的一步），才得到真信号。

根因：`stopSlide()` 用 `cancel()` 让列的 `translateY` 一帧归零，而那个位移正是内容被画在最终位置下方的距离 —— **一次取消就是一次单帧上跳**。触发者是宿主随回答变长反复重挂流式容器（每次重挂被尺寸订阅读作 `delta < 0` 收缩），不是原先猜的「思考行结束」。

### 改动一

`src/follow/follow.js` 新增 `settleSlide()`：取当前剩余位移 `runCarried(current)`，`stopSlide()`，若剩余大于 1px 就用 320ms 缓动把它走完（反向滑移元素跟着 `translateY(-left)` 走），记录以 `settled` 存回 `slide`。三个结构边界从硬 `cancel()` 改调 `settleSlide()`：`if (delta < 0)`、思考行离开 `running`、`removedNodes` 含 `CHAT_RUNNING_SELECTOR`。硬 `cancel()` 只留给读者接管与卸载。

`src/follow/params.js` 新增 `SLIDE_SETTLE_MS = 320`、`SLIDE_SETTLE_EASE = 'cubic-bezier(0.33, 0, 0.2, 1)'`。

### 验证一

```
base-true    sec=15.5  jumps=574  worstUp=-45.09  cancels=25
bounce-fix2  sec=17.1  jumps=217  worstUp=-17.28  cancels=23
fix-b        sec=23.2  jumps=530  worstUp=-24.44  cancels=22
```

**最大单帧上跳稳定从 45px 降到 17–24px**。总次数不可比（各轮回复长度与重挂次数不同，`jumps` 在 217–530 之间波动），所以判据是「最坏一次」而不是总数。

### 现象二：每次追加后有一次整篇样式重算

不是用户报的，是排查「流式时卡顿」时量出来的。

### 证据二

`test/append-cost.mjs` 在真实页面上把三臂放在同一页同一容器上跑（240 批 × 16ms 与 5ms 两个节奏）：

```
per-append@16ms  themeTotal 12118.1ms  p50 49.7  p95 68.7  max 87.7
per-frame@16ms   themeTotal    12.2ms  p50  0    p95  0.1  max  0.4
dropped@*        themeTotal     0ms
```

放大到更大页面（`flows: 14`、`nodes: 4600`）后：`per-append` 的 `themeTotal` 到 17971ms、`p95 110.7`；`per-frame` 只有 274.5ms、`p95 2`。

三条结论：

1. **在 mutation 回调里读样式约 50–130ms/次；同一读推到 rAF 里约 0.05–1ms/次，快约三个数量级。**
2. `getComputedStyle` 调用本身两侧都只有 2–4ms —— **贵的是「在样式已脏时读它」，与缓存无关**。
3. `per-frame` 与 `dropped` 的帧间隔几乎相同（`p50 73.4` vs `70`、`over50 239` vs `240`）—— **成本是真消失了，不是转进帧**。

### 改动二

`src/reveal/engine.js` 的 `createRunColorPublisher()` 拆成两半：`mark(element)` 只 `setAttribute(CHAT_REVEAL_RUN_ATTR, '')`，不读样式；`publish(element)` 才做 `getComputedStyle` → 比 `color` → 比 `getPropertyValue` → 写内联属性。`publish.mark = mark` 挂出去。

`src/reveal/diff.js` 里 `const markRunColor = publishRunColor.mark ?? publishRunColor`，扫描时改调 `markRunColor(element)`，run 的 `colorElement` 从 `element` 改成 `null` —— 让第一个绘制该 run 的帧去读它的颜色。`src/reveal/paint.js:164` 的 `if (element !== run.colorElement)` 因此首帧必读一次、之后不再读。

写属性是免费的（写不会让浏览器解析样式），读才贵。

### 踩到的坑

- **`Animation` 没有 `.animate()`**：第一版 settle 对 `current.counters`（存的是 `Animation` 对象）调 `.animate()`，抛异常打断整个 `onRecords` 回调，而 `stopSlide()` 已经执行、偏移照样被丢弃，实测恶化到 `worstUp 107px`。修法：`startSlide` 里另存 `elements: countersToAnimate`，settle 用元素而不是 `Animation`。
- **按行号认回调会静默失效**：`AB_THEME=drop` 臂第一版用 `label.endsWith(':85450')` 判定要丢弃哪个观察器。行号随构建变化，换个 rev 就对不上，于是 drop 臂**什么都没丢**，数据读起来像「这个回调不花钱」。改成按源码 `String(callback).includes('smApplyTheme')` 判定。**结论：任何按行号或按偏移认代码的探针，都必须先验证它真的命中了目标。**
- **测试机残留进程会污染 A/B**：本机留着 4 个上一会话的 Chrome 占着 CDP 端口抢 CPU，240 批 × 16ms 本该 4 秒却跑 29–35 秒。清理命令：
  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -match 'remote-debugging-port' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  ```
  此前所有 A/B（包括一条「开启插件是净收益」的结论）都在污染状态下跑的，全部作废。
- **`getComputedStyle` 返回的 declaration 无法从 JS 侧打桩**：想给 `CSSStyleDeclaration.prototype` 的 `colorScheme`/`backgroundColor` getter 计时，实测 `hasCSSStyleProperties: "undefined"`（直接引用抛 `ReferenceError` 会把整个探针带下去）、原型链上没有自有描述符。这条路走不通，不要重试。
- **纯文本节点不脏样式**：`node.appendData()` 不触发 `childList` 观察器；`document.createTextNode()` 触发了但 `styleMs` 只有 2.1ms/1920 次。**只有挂元素才脏样式** —— 合成负载必须挂元素，否则测的是空转。
- **minify 会消掉标识符**：验证页面跑的是哪个构建时，不能用 `SLIDE_SETTLE_MS` 这类常量名（bundle 里不存在），要选保留下来的字符串字面量，比如 `cubic-bezier(0.33, 0, 0.2, 1)`。

---

## 0.1.0 — 首次发布

**提交**：`fdbfd05`（`Stream fade and follow for DeepSeek Harness`），之后 `c63ec70`、`8ae5909`、`a138a47` 三个修正仍在这个版本号下。

三件事：新到的字逐字淡入（`src/reveal/`）、被宿主贴底推上去的文字被滑回原位（`src/follow/`）、思考与工具行的开合卷动高度而不是整块瞬移。

淡入与滑移来自 [dsh-claude-style](https://github.com/nwflower/dsh-claude-style)；这里是独立插件，不需要主题。哪些是移植、哪些是新写的见 README 的「参考项目」。

`a138a47` 跟进上游 0.22.3：改成按路由取尺寸、去掉结构性交还、滑移改 replace 模式。

---

## 未决事项

- **`main` 落后 `dev` 三个提交**（`main` = `fbba3dd`，`dev` = 0.2.2 的提交）。合并前要决定 `main` 是否也接受 0.2.x 的行为变更。
- **`dsh-session-manager` 的 `smApplyTheme` 与本插件 0.2.0 之前的写法是同一个错误**：它在 `document.body` 上挂 `{ childList: true, subtree: true }` 的无过滤观察器，每次流式追加都读几次 `getComputedStyle` —— 正是上面量到的「在脏样式上读」那 50–130ms。**尚未修**。修法与 `fbba3dd` 相同：把读推到 rAF。
- **真实流式下「开启插件是否让用户少看到卡顿」仍未定论**。清理环境后按秒归一化的中位数显示开着更差约两倍（`over50` 1.50/秒 vs 0.75/秒、长任务 78.4ms/秒 vs 47.9ms/秒），但只有 4 轮、且各轮回复长度差四倍；离屏 headful 不参与合成，rAF 不受 60Hz 限制（实测 `p50 3.3ms`，约 300fps），「超过 50ms 的帧」统计的不是读者看到的那一帧。**需要更多轮次的 headless 数据才能下结论。**
- **`test/append-cost.mjs` 与 `test/stream-ab.mjs` 未纳入 `npm test`**：它们是需要真实页面和端口的测量工装，不适合当回归测试跑。是否要留成长期工装、还是改造成可自动化的形状，待定。
