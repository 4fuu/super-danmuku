# 隐私政策 / Privacy Policy

super-danmuku 基于开源项目 [xmcp/pakku.js](https://github.com/xmcp/pakku.js)（GPLv3）修改而成。本政策说明扩展如何处理你的数据。

## 本地处理

弹幕的抓取、合并、去重以及所有统计计算全部在你的浏览器本地完成。扩展不收集你的 B 站账号信息、观看历史或任何个人身份信息，不包含任何遥测或统计上报。

## AI 过滤（可选功能）

启用「AI 弹幕质量过滤」并配置 API key 后：

- 发送的内容：当前时间窗内的弹幕文本（合并去重后的代表文本）、该时间窗前后若干秒的 AI 生成字幕片段、视频标题/UP主/标签（来自页面）。
- 接收方：你在设置中配置的 AI 服务（[typesafe.ai](https://typesafe.ai)），使用你自己的 API key 发起请求。
- 这些内容仅用于当次判定，本扩展的开发者不会收到任何数据。

## 字幕获取

AI 字幕通过 B 站官方接口获取，使用浏览器现有的 B 站登录态（仅携带 Cookie 请求字幕文件，不读取、不存储 Cookie 内容），按视频缓存于内存中。

## 本地存储

- 设置：保存于浏览器扩展存储（`chrome.storage`）。
- API key：仅保存于 `chrome.storage.local`，不参与浏览器云同步，不进入页面上下文。
- AI 过滤日志：仅保存于本浏览器（`chrome.storage.local`，上限 300 条），包含弹幕文本与判定结果，不含 API key，可随时在设置页清空或导出。

## 联系

如有问题请到 [GitHub Issues](https://github.com/4fuu/super-danmuku/issues) 反馈。
