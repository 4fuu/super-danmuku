# AGENTS.md

## 项目概况

super-danmuku 是 [xmcp/pakku.js](https://github.com/xmcp/pakku.js)（GPLv3）的 fork，在其弹幕合并管线之上新增了由 TypeSafe Jev 驱动的 AI 弹幕质量过滤层。`master` 跟随上游结构，功能改动集中在本 fork 的提交内（`git log --reverse` 查看演进）。

## 构建与验证

```bash
npm install
npx tsc --noEmit          # 类型检查，必须零错误
npm run build:chrome      # 产物在 dist/C，可加载已解压扩展
node tools/smoke_ai_filter.js   # AI 过滤层冒烟测试（mock chrome 与 Jev，无网络依赖）
```

改任何 `core/` 或 `background/` 下的代码后，以上四步都要跑。B 站真实页面的 E2E 无法在海外数据中心 IP 进行（412 风控），需要真页面时通过 SOCKS 代理（见"开发环境备注"）。

## 代码结构

- `pakkujs/core/ai_filter.ts` — AI 过滤层。插入点在 `core/scheduler.ts` 的 `try_start_postproc`：pakku 合并（post_combine）之后、egress 之前。
- `pakkujs/background/background.ts` — 消息代理：`jev_call`（调 Jev API）、`jev_ready`（key 存在性）、`bili_subtitle`（拉 AI 字幕，按 cid 缓存）。
- `pakkujs/page/options.*` — 设置页（AI 设置在一级菜单，pakku 原生设置收拢）。
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

推送到 master 即自动发布：`.github/workflows/release.yml` 读取 `pakkujs/manifest.json` 的版本号（`YYYY.MDD.N`，按 Asia/Shanghai 当日日期校验），该版本无对应 tag 时自动构建 Chrome/Firefox 包、跑冒烟测试并创建 release（提交列表即 release note）。发布 = 把 manifest 版本号改成当天新序号并推送，无需其他手动步骤。

发布后可自动上架商店（凭证缺失时自动跳过，不阻塞）：AMO 用 `web-ext sign --channel=listed`（secrets `WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET`，附 `git archive` 源码包满足 AMO 源码审查）；Chrome Web Store 用 v2 API（secrets `CWS_CLIENT_ID`/`CWS_CLIENT_SECRET`/`CWS_REFRESH_TOKEN`，variables `CWS_EXTENSION_ID`/`CWS_PUBLISHER_ID`）。两个商店的首次 listing 都必须人工创建（API 不能创建新 item），之后新版本才走自动流程。

## 开发环境备注

- B 站 API 对海外数据中心 IP 返回 412。`tools/bili_login.py` 与 `tools/fetch_subtitle.py` 支持 `--proxy socks5h://...`，配合 SSH 动态转发（上海机器 `ssh -D 11080`）使用。
- 走代理时保持 requests/curl 原生 UA：Chrome UA 叠加非浏览器 TLS 指纹会触发风控。
- 扫码登录得到的 cookie 文件（含 SESSDATA）权限 600，永不入库、永不打印。
- 离线评测脚本与标注数据放在开发机 `/tmp` 下，属于一次性产物，不入库。
