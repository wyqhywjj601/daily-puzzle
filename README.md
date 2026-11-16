# 每日拼图 · Daily Calendar Puzzle

一个无依赖的网页版「每日日历拼图」。用十块不规则木片盖住棋盘，只留下当天的 **月份、日期、星期** 三个格子。

## 运行

直接双击 `index.html` 即可游玩。若浏览器对 `file://` 下的 `localStorage` 有限制，可以在目录中启动一个静态服务器：

```bash
cd daily-puzzle
python3 -m http.server 4173
# 打开 http://localhost:4173
```

## 玩法

- 把右侧木片拖到棋盘上，木片会自动吸附到格子。
- 木片可以旋转和翻转：
  - `R` 旋转所选木片
  - `F` 翻转所选木片
  - 双击木片也可以旋转
  - 点选木片后使用「旋转 / 翻转」按钮
- 选中棋盘上的木片后，用方向键 `↑` `↓` `←` `→` 可以逐格平移（遇到留白或其他木片会被挡住）。
- 把棋盘上的木片拖出棋盘，即可收回木片盒。
- 卡住时点「提示」，会自动放好一块。
- 日期左右箭头切换前一天 / 后一天；点击日期卡片可以直接跳转到任意日期。
- 每个日期的进度、用时和提示次数会自动保存在浏览器本地。

## 部署

线上地址：**https://puzzle.5888688.xyz**

站点以 Cloudflare Workers 静态资源方式部署（`_headers` 中的缓存与安全响应头仍然生效）：

```bash
npm install
npm run deploy          # 构建 dist/ 并部署
npm run preview         # 本地 Workers 环境预览
```

首次部署前执行 `npx wrangler login`。自定义域名在 `wrangler.toml` 的 `routes` 中配置；`src/index.js` 只负责把 HTTP 请求 301 到 HTTPS，其余请求交给静态资源绑定。

## 文件

```
daily-puzzle/
├── index.html      # 页面结构
├── styles.css      # 视觉样式、响应式布局与动效
├── game.js         # 棋盘/木片模型、拖拽、求解器、存档、音效
├── src/index.js    # Worker 入口：HTTP → HTTPS 跳转
├── wrangler.toml   # Cloudflare 部署配置与自定义域名
├── _headers        # 缓存与安全响应头
├── package.json    # build / preview / deploy 脚本
└── README.md
```

`npm run build` 会生成 `dist/`（实际部署的静态文件目录）。

## 实现说明

- 棋盘为 7 × 8 的不规则布局，共 50 个可玩格子：12 个月份 + 31 个日期 + 7 个星期。
- 十块木片总计 47 格；完成时恰好空出「月份、日期、星期」3 格。
- 十块木片（5 格 × 7 + 4 格 × 3 = 47 格）：U 形、缺角、大 Z、丁字、长 L、台阶、小 Z、长条、小 L、拐角，允许旋转与翻转。
- 求解器使用 50 位位图 + MRV 回溯搜索；「提示」会基于当前已放置木片求出剩余解，再放置其中一块。
- 当前木片组在全部 `12 × 31 × 7 = 2604` 种「月份 / 日期 / 星期」组合下均有解。
- 音效使用 Web Audio 合成，无外部音频资源。
- 全部图标、木纹和纸纹均由 CSS / 内联 SVG 绘制，无图片与第三方依赖。

## 自定义

- 木片形状：`game.js` 中的 `BASE_PIECES`（坐标为格子单位，左上角为 `[0,0]`）。
- 木片配色：`game.js` 中的 `PIECE_TONES`。
- 整体配色与字体：`styles.css` 顶部 `:root` 变量。
