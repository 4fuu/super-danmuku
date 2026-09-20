# AGENTS.md

## 项目概况

super-danmuku 是 [xmcp/pakku.js](https://github.com/xmcp/pakku.js)（GPLv3）的 fork，在其弹幕合并管线之上新增了由 TypeSafe Jev 驱动的 AI 弹幕质量过滤层。`master` 跟随上游结构，功能改动集中在本 fork 的提交内（`git log --reverse` 查看演进）。

## 构建与验证

```bash
npm install
npx tsc --noEmit          # 类型检查，必须零错误
npm run build:chrome      # 产物在 dist/C，可加载已解压扩展
node tools/smoke_ai_filter.js   # AI 过滤层冒烟测试（mock chrome 与 Jev，无网络依赖）
node tools/smoke_ad_skip.js     # 口播广告跳过冒烟测试（真实夹具 BV17Neb6wE87 裁剪 + mock Jev）
```

改任何 `core/` 或 `background/` 下的代码后，以上五步都要跑。B 站真实页面的 E2E 无法在海外数据中心 IP 进行（412 风控），需要真页面时通过 SOCKS 代理（见"开发环境备注"）。

## 代码结构

- `pakkujs/core/ai_filter.ts` — AI 过滤层。插入点在 `core/scheduler.ts` 的 `try_start_postproc`：pakku 合并（post_combine）之后、egress 之前。**全量判定**：每个分片等**所有**窗口判完才发版（`AI_BUDGET_MS` 默认 300000ms 仅为超时保险，超时才放行未判定弹幕），因此上屏弹幕总是已过滤的；拖动进度条时后到的区间请求从已完成的 chunks_out 直接取，无脏数据。**语义窗口 + 请求打包**：窗口是固定的 5 秒内部常量（`SEMANTIC_WINDOW_S`，非设置项），仅作语义单位——淘汰比例作用域、<3 条豁免、L2 判定键；请求不再与窗口一一对应，相邻已判定窗口打包进同一请求，受候选数（≤`AI_MAX_CANDIDATES`）与时间跨度（≤`PACK_SPAN_S`=90s）约束，请求候选带 `t_seconds` 时刻、字幕取打包区间前后 `AI_SUBTITLE_PADDING_SECONDS` 秒；窗口的所有 pack 返回后才应用淘汰比例并 `gate_window_done`。请求并发受全局 `AI_CONCURRENCY` 限制（跨分片共享信号量，按播放头距离排序）。**主动限流**：令牌桶匀速请求发送（15 req/s、突发 4，官方限额 20 req/s 的 75%），每次尝试（含重试）前 `rl_acquire`；429/529 指数退避（500ms·2^n，最多 5 次，尊重 Retry-After）仅作兜底。**加载门控**（`AI_PAUSE_GATE`）：弹幕处理启动即暂停 `<video>` 并覆盖等待动画（进度+预估），**所有已加载分片的窗口全部判完**才恢复播放（跨分片按 cid 累计，仅换视频时重置；等待期间覆盖用户播放/暂停操作；45 秒无任何窗口完成则放行并对本视频停用门控）。`gate_window_done` 必须先 `gate_pending.delete` 再做幂等早退——重复注册的窗口（同区间重请求）否则会永远卡在 pending。超过 `AI_MAX_TEXT_LEN`（默认 12 字）的弹幕不判定直接放行。判定缓存两级：内存 L1（会话内，按 pack 键 `hash([pack_lo, segidx, cands])`）+ 持久 L2（`AI_VERDICT_CACHE`，**默认关闭**，实验性；键 `cid|window_lo|text`，值含 p/score/model/timestamp/bvid，上限 2 万条 LRU）。每窗/每分片判定记录经 `ai_log_append` 发给 background（上限 300 条），独立页面 `page/ai_log.html` 查看/清空/导出。
- `pakkujs/core/ad_skip.ts` — **独立管线**：AI 口播广告跳过（与弹幕质量过滤并行，复用 scheduler 已下载的 chunks 与共享 Jev 配额/信号量，优先级 +10000 永不与过滤层抢槽；fail-open，任何失败只是无提示）。流程：本地粗筛（30s 窗网格：promo 词表命中字幕 / 弹幕抱怨·欢迎回归·模板夸赞信号 / burst≥4）→ 候选窗 ±1 邻域扩展 + ≤2 窗空洞填充 → 打包（≤90s）送 Jev 窗口级初筛（`AD_CRITERIA`：品牌作话题 ≠ 广告）→ p≥0.6 的窗合并成区间（桥接 ≤1 未判窗）→ Jev 逐行边界细化到 ~1s（`AD_LINE_CRITERIA`；无字幕时降级为弹幕标记吸附）→ 边界情况过滤：短于 `AI_AD_SKIP_MIN_S`（默认 10s，一句带过的赞助商不值得割裂）的丢弃；合计覆盖 ≥`AI_AD_SKIP_MAX_COVER`（默认 0.6）视为「广告即内容」（全片定制/软广）全部抑制。结果按 cid 持久缓存（`ai_ad_intervals`，2000 条 LRU，30 天 TTL），重访零请求；缓存读写均受 `AI_AD_SKIP_CACHE` 门控（默认开；关闭 = 每次访问重扫、不落盘），options「清除口播广告缓存」按钮删 `ai_ad_intervals` 并向打开标签页广播 `pakku_ad_clear_cache`（本文件监听，清内存 intervals + 移除提示条，独立于弹幕过滤的 `ai_clear_cache`）。扫描日志（`ad_scan` 类型）与其他 AI 日志同存，`page/ai_log.html` 顶部按「口播广告 / 弹幕过滤」类型筛选。UI：播放器顶部居中提示条 + 手动跳过按钮；`AI_AD_SKIP_AUTO` 开启时 conf ≥ `AI_AD_SKIP_AUTO_THRESHOLD` 自动跳（每区间一次，跳后 6 秒内可点「回到」撤回）。字幕来源经 background `bili_subtitle`：UP 自传中文字幕 > ai-zh > 其他。设置在 options「AI 口播广告跳过」区（默认全关）。冒烟测试 `tools/smoke_ad_skip.js` 用 BV17Neb6wE87 真实裁剪夹具（真值 [252.35, 397.86]）验证全管线。scheduler 三个挂钩：`on_ingress`（换视频重置）、`feed_chunk`（扫描开始前收集，去重）、`begin_scan`（num_chunks 就绪后触发，此后迟到的分片忽略）。
- `pakkujs/background/background.ts` — 消息代理：`jev_call`（调 Jev API）、`jev_ready`（key 存在性）、`bili_subtitle`（拉字幕，按 cid 缓存；排序 UP 自传中文字幕 > ai-zh > 其他 AI 字幕）。
- `pakkujs/page/options.*` — 设置页（AI 设置在一级菜单，pakku 原生设置收拢）。「清除弹幕判定缓存」按钮删除 `ai_verdicts` 并向所有打开标签页广播 `ai_clear_cache`（内容脚本在 `ai_filter.ts` 监听，同步清掉内存 L1 与 verdict_store）；「清除口播广告缓存」按钮镜像此模式但走 `pakku_ad_clear_cache`。**新增设置项必须四处接线，漏一处会静默不保存**（曾踩坑：ad-skip 区首版没进 change 监听列表，勾选后看似生效实则未存）：① options.html 标记；② `loadconfig()` 表单 ← config；③ `update()` config ← 表单（`update()` 是唯一保存路径，没有通用序列化器）；④ 文件底部的 change 监听列表。config 新 key 还必须进 `background/config.ts` 的 `DEFAULT_CONFIG`，否则 `migrate_config` 加载时丢弃。
- `pakkujs/background/config.ts` — `DEFAULT_CONFIG`，AI_* 前缀为本 fork 新增配置。
- `tools/` — 开发脚本（登录、抓字幕、冒烟测试），不进构建产物。

## 硬性约束

1. **fail-open**：AI 层任何失败（超时、429、无 key、解析错误）都必须放行原始弹幕，绝不阻断弹幕加载或报错打断观看。
2. **API key 只存 `chrome.storage.local`**：不得写入 `chrome.storage.sync`（pakku 的 config 会同步）、不得进入页面上下文、不得入库或写日志。
3. **统计归代码**：簇计数、时间跨度、窗口切分等一律在代码层算好，Jev 只做语义判断（其数数与时间比较不可靠，见官方 jaggedness 文档）。
4. **删除语义是窗口级时效判断**：求中奖类弹幕在"当前窗口的视频内容正在讲抽奖"时允许保留（pakku 合并层会压成一条 `[xN]`），其余窗口删除。此规则固化在 `ai_filter.ts` 的 `WORST_CRITERIA`，改动前先读相关提交信息（e438f99 与 972ad0c 的演进）。
5. **无字幕/未登录是正常降级路径**，不是错误：只用标题/简介/标签作为上下文继续工作。
6. 提交信息用英文；遵循 pakku 原有代码风格（缩进、命名、注释习惯）。

## 发布

发布为手动触发：`.github/workflows/release.yml` 仅由 `workflow_dispatch` 触发（GitHub 界面 Actions → Release → Run workflow，或 `gh workflow run release.yml`）。它读取 `pakkujs/manifest.json` 的版本号（`YYYY.MDD.N`，按 Asia/Shanghai 当日日期校验），该版本无对应 tag 时构建 Chrome/Firefox 包、跑冒烟测试并创建 release（提交列表即 release note）。发布步骤：把 manifest 版本号改成当天新序号并推送，然后在同一上海日内手动触发该工作流。重复触发是安全的：版本已存在对应 release 时自动跳过；普通推送不再触发发布。

发布产物：Chrome 包、Firefox 包、源码包（`git archive` 生成，供 AMO 人工提交时满足"提供源码"要求）。商店上架为人工操作：从 release 下载对应 zip，AMO 上传 firefox 包（listed 渠道，源码步骤上传 source 包或填仓库链接），Chrome Web Store 上传 chrome 包。

## 开发环境备注

- B 站 API 对海外数据中心 IP 返回 412。`tools/bili_login.py` 与 `tools/fetch_subtitle.py` 支持 `--proxy socks5h://...`，配合 SSH 动态转发（上海机器 `ssh -D 11080`）使用。
- 走代理时保持 requests/curl 原生 UA：Chrome UA 叠加非浏览器 TLS 指纹会触发风控。
- 扫码登录得到的 cookie 文件（含 SESSDATA）权限 600，永不入库、永不打印。
- 离线评测脚本与标注数据放在开发机 `/tmp` 下，属于一次性产物，不入库。
