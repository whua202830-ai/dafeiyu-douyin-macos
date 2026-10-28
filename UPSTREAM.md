# 上游与 Mac 适配来源

- 上游仓库：https://github.com/LockyBee/dsh-douyin-agent
- 基础 npm 包：`dsh-douyin-browser-local@1.4.5`
- 上游包 integrity：`sha512-i0UarPWsbcr0ZsW3y0iDk/AFvWvynKoR2HiANAxVR/UirMuf4TS0VmEgDGxCpZsxwEACHxFMXOnqEPaHkegM4A==`
- 原作者和许可：LockyBee and contributors，MIT。
- 本地适配版本：`1.4.5-macos.1`。

`plugin/` 保存已验收的 Mac 适配插件内容，保持包名以便更新现有安装。源包中的 repository / author 等元数据继续保留上游来源。仓库根目录增加 Mac 版标题、独立 skill 入口、发行说明及离线安装器。仓库不代表上游官方发布，也没有推送上游、npm 或社区市场。

平台适配集中在 `browser-runtime.mjs`、`runtime-paths.mjs`、`browser-host.mjs`、`browser-launcher.mjs`、`diagnostics.mjs`、`native-settings.mjs` 和媒体 Python 定位；原始业务的观看预算、账号许可与发送核对继续保留。
