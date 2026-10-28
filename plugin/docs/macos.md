# Mac 适配版 1.4.5-macos.1

这是在上游 `dsh-douyin-browser-local@1.4.5` 基础上制作的本地插件更新，支持 macOS；不是上游官方发行版，也没有发布到 npm 或社区市场。Windows 独立 EXE 不在本次移植范围。

## 使用

在 DSH“设置 → 刷抖音”运行“一键自检”，然后点“打开抖音”。专用准备页会保持视频暂停；登录和验证码由本人完成。之后按自己的时段和额度开启观看。音频服务和 Hindsight 不是浏览器观看的前置条件。

本版不更改已有许可、评论、分享或自动观看开关，不复制其他浏览器的登录资料。测试通过也不代表已登录、主模型请求成功或自动互动已验收。

## 自动寻找的程序

- Mac 浏览器：先 Chrome，后 Edge、Chromium；支持 `/Applications` 与 `~/Applications`。Windows 默认仍先 Edge。
- 浏览器专用资料：`~/.dsh/douyin-browser/cli-profile`。控制记录在相邻的 `control` 目录；已有状态路径保持不变。
- Node：校验当前独立 Node，或寻找 DSH 自己的 `Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node`，随后查找 PATH 和 Mac 常规 Node 安装位置。要求 Node 22.13+、非 Electron、SQLite 实际可用。
- Python（可选音频）：Mac `.venv/bin/python3`，或 DSH 自己的 Python，再回退 `python3`。Windows 保留 `.venv/Scripts/python.exe`。不访问 Codex 的私有运行时。

自定义启动环境可以设置 `DOUYIN_BROWSER=chrome|msedge|chromium`、`DOUYIN_BROWSER_EXECUTABLE` 或 `DOUYIN_NODE_EXECUTABLE`。程序路径必须是绝对路径，Mac 浏览器要指向 `.app/Contents/MacOS/` 中的可执行文件。显式指定的路径无效时会报错，不静默切换。Finder 启动的 GUI 不一定继承终端的环境变量；默认安装无需配置这些变量。

## 排障

| 自检码 | 处理 |
| --- | --- |
| `NODE_OK` | 独立 Node 与 SQLite 已通过实际探测 |
| `BROWSER_OK` | 自检与启动已选择同一个已安装浏览器；连接和登录另查 |
| `NODE_UNAVAILABLE` | 核对 DSH bundled Node 或自定义路径；`runtime/bin/node` 是 Electron 包装器，不能代替独立 Node |
| `BROWSER_MISSING` | 安装 Chrome / Edge，或核对自定义路径；Mac 不再强制安装 Edge |
| `BROWSER_NOT_CONNECTED` | 点击“打开抖音”；此项不会自行打开窗口 |
| `LOGIN_REQUIRED` / `CAPTCHA_REQUIRED` | 用户本人在专用窗口完成操作 |

更新后若插件自检仍显示 `1.4.5`，通过插件管理重新加载本插件。若宿主保留了旧 ESM 模块缓存，可在其他工作完成后正常退出并重开 DSH；无需重装其他插件。

## 验证与范围

`node --test tests/platform.test.mjs` 检查 Mac / Windows 程序选择、独立 Node / SQLite、自定义路径错误、Python 和已有数据路径。`node tests/browser-smoke.mjs` 启动真实浏览器，但使用隔离临时资料及拦截的合成页面，不请求抖音网络、不登录、不发送消息；检查宿主就绪、CDP、准备页暂停及页面复用。

真实抖音页面、DSH 宿主加载及模型观看的结果以交付时的验证记录为准。不能把合成测试当成真实账号验收，也不能把历史 Windows 验收算作本版 Mac 验收。

## 更新与回滚

本地安装器只更新本插件文件和对应的 DSH skill，并把本插件依赖固定到 DSH 目录中的本地包。它保留现有状态、记忆、登录资料、其他插件和代理设置。备份及安装清单位于 `~/.dsh/douyin-browser/backups/`。回滚只恢复清单中属于本次更新的文件；如果文件已被后续更新修改，先核对差异，不覆盖新改动。

原作者、MIT 许可证和第三方通知保持随包提供。上游资料见 [插件说明](plugin.md) 与 [来源](reuse.md)。
