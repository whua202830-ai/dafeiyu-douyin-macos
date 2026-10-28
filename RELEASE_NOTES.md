大肥鱼抖音插件 Mac 版 `1.4.5-macos.1`，基于 LockyBee 上游 1.4.5 的社区适配测试版。

支持 Mac Chrome / Edge / Chromium，识别 DSH 自带独立 Node 和 SQLite，提供 Mac skill、完整配套源码与可回滚安装器。无需借用 Codex 私有运行时。

17 项回归与 DSH 内 15 项自检通过；完成约 24 秒真实播放和 2 次模型响应。第 3 次请求遇到宿主重启而中断。显式换片、长时间运行、Windows 实机、音频与真实外发未单独验收。

下载 `.tgz`、`install-macos.py` 和 `SHA256SUMS.txt` 到同一目录，按 README 操作。安装器只更新已安装上游 1.4.5 的 DSH Desktop，不支持空白 profile 的首次安装。

保留原作者 LockyBee and contributors 与 MIT 许可证。不是 DeepSeek 或抖音官方发行，未发布 npm 或插件市场。
