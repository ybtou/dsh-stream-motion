<div align="center">

# dsh-stream-motion

**回答流式输出时，聊天区做两件事：新到的字逐字淡入，被宿主贴底推上去的文字被滑回原位，而不是跳一下。**

[![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.md)
[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.en.md)

</div>

一个 DeepSeek Harness 插件。淡入与滑移来自
[dsh-claude-style](https://github.com/nwflower/dsh-claude-style)，在那里它们是某个主题的两个功能；
这里是一个不需要主题的独立插件。具体哪些是移植、哪些是新写的，见[参考项目](#参考项目)。

## 支持的 DSH 版本

**只支持 DSH `0.2.3-alpha.2`。** manifest 精确锁定该版本 ——
`"engines": { "dsh": "0.2.3-alpha.2" }` —— 其他版本安装会被直接拒绝
（`incompatible-version`），而不是先装上再出问题。

精确锁定是故意的。这个包抓着聊天框的 DOM 形状：找「回到底部」按钮靠从列元素的祖父走到
下一个兄弟槽位；读的是宿主自己节点上的 `data-chat-following-tail` / `data-chat-flow` /
`data-chat-running` / `data-step-process-body`；写的是宿主拥有的滚动容器。这些都是宿主内部
实现，不是公开契约。用 caret 范围会放行 `0.2.3-alpha.3`、`0.2.3-beta.1`、`0.2.3` 和
`0.2.4` —— 它们都是看着合理的预发布或补丁步进，但一个都没在这里验证过。在没跑过的版本上，
失败是静默的，比拒绝更糟：框架挪了位置就答「没有按钮」，跟随交还悄悄失效；标记改名让守卫
永远读到 `false`；滚动容器换了主人，位置仲裁就变成第二个写入者跟宿主打架。

放宽版本是一条**测试**动作，不是改个版本号。对新运行时跑
`node test/reveal-probe.mjs`、`node test/follow-probe.mjs`、`node test/tail-press.mjs`
和 `node test/live.mjs`，并把「工作原理」一节的标记表对着宿主的 `dsh-client-ui-chat`
构建重新核一遍，再去动范围。

非要在未验证版本上装，DSH 提供针对具体运行时的精确版本豁免 ——
`dsh-stream-motion@0.1.0`，通过插件管理器或 `dsh plugin allow-version`。之后发生什么按未测处理。

## 安装

```bash
npm install          # 只为了 esbuild 这一个开发依赖
npm run build        # src/ -> lib/client.js + lib/host.js
```

然后把 DSH 的插件管理器指向本目录（`install_bundle`），或把构建好的目录作为本地 bundle 安装。
`lib/` 已入库，所以 clone 下来可以直接装；改过 `src/` 再重新构建。

## 它做什么

**淡入。** 字先以低不透明度出现，再落到实色，每帧一个 alpha 台阶，于是长回答读起来像在写，
而不是一块一块地蹦出来。到达顺序被保留：后到的一批不会超过先到的；淡入的时长跟着相邻两批
之间的间隔走。

**滑移。** 回答流式输出时，宿主把对话钉在末尾：每到一个片段就整段写一次末尾，于是最后一
行以上的文字在一帧之内被推上去「增长量」那么多。这个插件把列元素按同样的增长量放回来，并
在合成器上滑到静止，读者的眼睛留在同一行上，而不是每次爆发都被踢一下。当前轮次那一行被钉
在滚动容器底部，会跟着这个位移走，所以它在同一帧里反向滑移同样的量，原地不动。

**跟随交还。** 聊天区的跟随会在几个时刻丢失 —— 工具行挂载、思考行离开 `running`、折叠滑移
落地、切换会话、恢复历史。宿主在自己的 500 ms 采样窗口里遇到任何写入都会关掉跟随，只留一
条回头路：那个只在关闭状态下才渲染的「回到底部」按钮。守卫替你按它。

宿主把那个按钮放在列的右侧空隙里、对话区水平居中。这个包把它挪到输入框右上角的外侧 ——
读者真正在看的地方，因为文字末尾就在输入框正上方 —— 并以右边缘对齐，这样按钮自己的宽度
不需要被知道。两个数每次都重新测，因为两条边都会动：草稿换行时输入框会长高，侧边栏会从列
里拿走宽度。

**平滑按下。** 按那个按钮本身也被平滑了。宿主的处理函数一帧写到底，等于把读者瞬移过去；
这个包在宿主处理函数之前截下这次点击，用一条定时缓动把位置走到末尾 —— 起步慢、中段最快、
贴着目标收住 —— 然后再真的按一次按钮，把宿主的跟随打开。用定时缓动而不是弹簧，因为这段
行程的形状是给读者看的；弹簧渐近逼近目标，最后几像素会爬，而且它的前置量会在第一帧就把
读者挪走一屏。时长从距离读出（`sqrt(px) * 12`，夹在 220–700 ms），短程快、长途不熬。

**追赶。** 被限高的过程体（可折叠的工具输出）落后超过 40 px 后，会用一条临界阻尼弹簧走到
自己的末尾，读起来是追赶，而不是宿主那种慢悠悠的平滑滚动。

## 工作原理

这里没有任何东西解析网络流。所有输入都是宿主已经写好的标记，本包不在聊天树里写任何标记：

| 标记 | 宿主写在哪 | 这里当作 |
| --- | --- | --- |
| `data-streaming`、`data-shimmer` | 回答容器 / 思考摘要 | 内容正在到达 |
| `data-chat-following-tail` | 聊天根节点 | 宿主自己的跟随是开着的 |
| `data-chat-flow` | 流列元素 | 被滑移的那个盒子 |
| `data-conversation-scroll` | 对话滚动容器 | 位置的所有者 |
| `data-chat-running` | 当前轮次的行 | 钉在容器底部，需要反向滑移 |
| `data-step-process-body` | 被限高的工具组主体 | 要追赶的盒子 |
| `data-conversation-session`、`data-phase` | 对话体与根节点 | 屏幕上哪个会话 |

淡入骑在 `::highlight()` 上：这个伪元素的属性集里没有 `opacity`，所以 alpha 花在颜色上，
每个台阶一条规则，各自把元素自己发布的颜色与 `transparent` 混合。规则的主语是文字所挂的
那个元素 —— 绝不是「流式块下面的任何东西」，因为后代组合器主语会让每一批都重新匹配它下面
的每一个元素，实测就是流式期间整页 style recalc。

滑移是流列元素上的一个 `Animation`：`translateY(增长量)` 到 `translateY(0)`，曲线
`cubic-bezier(0.22, 0.61, 0.36, 1)`，上限 240 ms，时长取相邻两批之间的间隔 —— 下一批落下
时还在播的滑移，重启的距离里包含它还没还完的部分，位移就会随每次爆发累加。附加式动画上不
了合成器，所以已走过的距离是从动画自己的时钟和曲线上读出来再重启，而不是相加。

滚动位置只有一个写入者。六个来源的优先级是
`jump > fold > reader > composer > follow > process`；比正在跑的缓动更低的请求会被拒绝，
读者按住容器时所有跟随类来源都被拒绝。读者一旦滚动就取得按住权，直到他们自己回到末尾。

## 测试

```bash
npm test                            # 三个浏览器工装
node test/live.mjs                  # 对着正在运行的 DSH web app
```

三个工装通过 CDP 驱动无头 Chromium 跑一个假宿主页面，不需要装 DSH。`test/live.mjs` 从运行中
的应用日志里读 `?token=` 的 URL，驱动真实的聊天框，是那个能抓到「宿主挪了位置」的套件。

## 限制

- 只在 DSH `0.2.3-alpha.2` 上测过，manifest 精确锁定该版本。见上面「支持的 DSH 版本」。
- 淡入需要 Custom Highlight API（Chromium 105+、Safari 17.2+）。没有它时淡入退场，滑移照常。
- 滑移需要 `Element.prototype.animate`。没有它时滑移退场，淡入照常。只有两个 API 都缺的
  浏览器什么都拿不到，此时页面不被标记。
- 宿主的「回到底部」按钮靠聊天框的形状找到：列元素的祖父框架，再下一个兄弟槽位。宿主改了
  这个框架就答「没有按钮」，交还与平滑按下都跳过，而不是猜一个。
- 打开在已保存阅读位置的对话永远不算「跟随末尾」，所以交还不会动它：读者自己的位置不会被
  走到末尾。
- 减动效时淡入与滑移都退场，按下交回宿主自己的跳转。减动效从页面读：
  `data-dsh-stream-motion-motion="reduced"` 或 `"full"` 优先，两者都没有时由系统偏好回答。
- 淡入时长、滑移曲线与追赶阈值在这里是常量，不是设置项。

## 参考项目

淡入与滑移是移植，不是发明。两者都来自
**[dsh-claude-style](https://github.com/nwflower/dsh-claude-style)**（作者
[Nwflower](https://github.com/nwflower)，MIT 协议，Copyright (c) 2026 Nwflower），
在那里它们是 Claude Code 风格主题的 `chat-reveal` 与 `chat-follow` 两个功能，跑在一套共享
引擎上（`frame`、`bus`、`scroll-owner`、`scroll-ease`、`chat-dom`）。

从这里移植、为本包重写：

| 本包 | 上游 |
| --- | --- |
| `src/reveal/{diff,engine,paint,text,params}.js` | `packages/client/src/features/chat-reveal/` |
| `src/follow/{follow,scroll-owner,scroll-ease,process-follow,chat-dom,ease}.js` | `packages/client/src/features/chat-follow/` 与 `packages/engine/src/` |
| `src/frame.js`、`src/bus.js` | `packages/engine/src/{frame,bus}.ts` |

移植时改了什么：TypeScript 转 JavaScript；去掉主题的功能注册表、设置行、样式表流水线和皮肤
词汇重写，所以本包不需要主题；所有标记从 `dsh-claude-*` 改名为 `dsh-stream-motion*`；两个
body 门拆开，于是只有其中一个 API 的浏览器仍能拿到它能跑的那一半；`::highlight()` 规则的
主语从一个后代选择器扩成两个，这样「文字直挂在流式容器自身」的情形也能淡入；以及新增了上游
没有的平滑按下 —— 那边「回到底部」按钮仍然是瞬移。

新写、非移植：`package.json`、`cordis.patch.yml`、`src/host.js`、`src/client.js`、
`src/{motion,session,stylesheet,params}.js`、`build.mjs`、`icon.svg`、`locale/`，
以及四个测试工装。

上游的 MIT 声明全文保留在 [LICENSE](LICENSE)。

## 协议

MIT。Copyright (c) 2026 ybtou。部分内容移植自 dsh-claude-style，
Copyright (c) 2026 Nwflower，同为 MIT —— 见 [LICENSE](LICENSE)。
