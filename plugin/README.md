# DSH 抖音助手

本地 Mac 适配版 **1.4.5-macos.1**，基于上游 1.4.5，未发布到 npm／插件市场。Mac 安装、验证和回滚见 [Mac 说明](docs/macos.md)。以下固定 npm／Windows 下载入口仍为上游版本，不包含本地 Mac 修改。

1.4.5 原有功能说明。插件与独立软件共用人格、兴趣、观看用量和许可名单；独立软件另外提供任务对话。本文的固定安装入口对应 1.4.5，包是否已可下载以 GitHub 和 npm 页面为准。

在本机专用 Google Chrome / Microsoft Edge 中浏览抖音电脑版，采样真实画面交给模型，按人格和实际观看行为更新兴趣。这是第三方适配，不是 DeepSeek 官方发行版。

## 功能

| 功能 | 用法与范围 |
| --- | --- |
| 自主观看 | 开启“允许自动观看”后，在允许时段和每日额度内挑片、停留、换片或停止；保留手动启动／暂停按钮 |
| 每日额度 | “高级选项”内设置每日观看分钟数和每日模型请求数，均可选不限 |
| 人格与兴趣 | 两版共用人格卡；兴趣依据实际播放进度、观看比例和已确认互动，看到主题不等于喜欢 |
| 好友互动 | 一个总开关管理许可会话的新消息回复及观看中的自主分享，默认开启；须由本人选择许可好友或群聊 |
| 群聊回复 | 仅回复已许可群聊中被 @ 或叫到设定昵称的消息 |
| 自主分享 | 通过官方面板发送当前实际观察作品的卡片，按平台稳定身份绑定收件人，同作品同会话去重 |
| 公开评论 | 独立开关，默认关闭；保留每日及每次观看的尝试上限，同作品不重复评论 |
| 静默观看 | 持续静音，核实窗口归属后尝试最小化；仍使用有窗口 Chrome / Edge |
| 自检与用量 | 一键诊断、限定修复建议、实际请求与已报告 token 用量、进行中状态 |
| 观看日报 | 从本机观看记录生成 Markdown，不额外调用模型 |
| 可选音频 | 本地 Whisper 转写对白，视频音频还可选择 MiMo 或 MiniMax 云端后端 |

好友互动不设人数、回复请求数或分享次数的业务上限，模型调用仍会消耗额度。默认开启总开关不会自行添加许可会话。旧自动续火花／自动问候入口已移除。

## 两种用法

| | 插件版 | 软件版 |
| --- | --- | --- |
| 入口 | DSH“设置 → 刷抖音”分类设置页 | Windows 独立软件的分类设置和任务对话 |
| 主模型 | DSH 已配置的提供商与支持图片的模型 | 自己填写的 API Key、接口地址和模型 |
| 运行依赖 | 兼容的 DSH 宿主 | 无需安装或启动 DSH、QQ 服务或 Node.js |
| 文档 | [插件说明](docs/plugin.md) | [软件说明](desktop/README.md)、[本机 API 说明](docs/standalone-api.md) |

同一时刻只运行一条自主观看。两版共享每日账本，暂停、重启或改设置不会清空当天用量。

## 上游 Windows 1.4.5 安装资料

DSH Desktop：打开“应用 → 桌面插件”，填写 `dsh-douyin-browser-local@1.4.5` 安装或更新。Desktop profile 由 Electron 管理，不要用普通 CLI 另改一份。更新后完全退出并重新打开同一份 DSH。

Web profile 在终端执行：

```powershell
dsh plugin --profile web add dsh-douyin-browser-local@1.4.5
```

插件需要 Windows、Microsoft Edge 和兼容 DSH。已检查 0.2.0-rc.2、0.2.1-rc.2 两代 SDK；完整允许版本以 `package.json` 的 `engines.dsh` 为准，不笼统保证任意 0.2.x 预发布宿主。设置通信适配常用 WebServer、Connection 与宿主 RPC 入口，第三方宿主仍以实际自检和加载结果为准。npm、GitHub Release 和插件市场分别同步；市场未更新时可核对固定 npm 版本。

独立软件及校验文件见 [1.4.5 下载页](https://github.com/LockyBee/dsh-douyin-agent/releases/tag/v1.4.5)，文件名为 `Dafeiyu-Douyin-API-1.4.5-win-x64.exe`。正常退出旧版后打开新版，保留共享记忆、登录目录和本机设置。便携包未签名，要求及更新说明见 [desktop/README.md](desktop/README.md)。

从源码安装插件需要 Node.js 22.13+、pnpm 和已核对路径的 DSH：

```powershell
git clone https://github.com/LockyBee/dsh-douyin-agent.git
cd dsh-douyin-agent
pnpm install --frozen-lockfile
$dshInstallDirectory = 'C:\Apps\DSH Desktop' # 替换为实际安装目录
.\install-native.ps1 -DshRoot $dshInstallDirectory
```

不带 `-Install` 只检查。确认无误、完全退出 DSH 后再执行：

```powershell
.\install-native.ps1 -DshRoot $dshInstallDirectory -Install
```

## 第一次使用

1. 配置支持图片的主模型。插件从 DSH 目录选择；独立软件在模型设置的密码框填写自己的 Key。
2. 点击“打开抖音”，在专用 Chrome / Edge 中手动登录或完成验证码。
3. 在“视频观看”选择时段，按需展开“高级选项”设置每日分钟数和请求数，再开启“允许自动观看”。无需先开始新轮次，应用需保持运行。
4. 在“好友互动”读取当前会话，核对稳定身份并勾选许可好友或群聊，按需填写群聊响应昵称。总开关开启且模型、名单就绪后自动准备回复；观看中可自主分享。

普通设置自动保存，文本输入离开输入框后提交，开关和下拉选择修改后提交，以页面回读为准；失败会保留草稿。密钥保留独立保存入口：桌面主模型 Key 走桌面 IPC；音频 Key 在“音频与密钥”密码框填写，离开后通过专用接口保存，不回显，也不会因此开启音频。

## 状态与验证边界

顶部状态栏区分在线、观看中、准备中和需要处理。未确认发送、身份不符或待人工处理的消息会显示原因；不能只凭总开关开启认定服务已就绪。好友回复与观看分开运行，观看时仍检查许可会话的新消息，实际速度受页面读取和模型耗时影响。

遇到问题先运行“自检与用量 → 一键自检”，按报告处理限定修复项。登录、验证码、无效 Key、损坏记录和宿主适配不能靠删除锁、记忆或登录目录解决。发送结果不确定时保留收据，等待人工核对，不自动重发。

本机已核对浏览、采样、暂停、真实模型人格候选和受控卡片流程，稳定身份、最终输入、每日账本及自动保存另有隔离测试。真实群聊、长期连续运行及本轮更新后的新私信自动回复仍需单独实测；MiMo／MiniMax 云端和真实公开评论也不能视为已验收。

后台打开浏览器仍有偶发超时，尚未根治；最小化后的持续播放受网站行为影响。历史某次发送或旧版测试不代表所有账号、宿主和消息类型都通过。记录见 [验证目录](docs/verification/)、[软件验证说明](desktop/VERIFICATION.md)，保留各自日期和版本。

## 开发与来源

```powershell
pnpm test
pnpm run test:native
```

测试使用临时目录、合成模型或临时浏览器，不应把测试通过写成真实平台联调通过。运行状态、Key、登录资料、私信及联系人记录不进入仓库。

浏览器控制复用 Playwright；来源见 [功能复用与来源](docs/reuse.md)、[软件来源](desktop/UPSTREAM.md)。原创代码采用 [MIT](LICENSE)，第三方通知见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。模型使用说明见 [skill/SKILL.md](skill/SKILL.md)，历史详细资料见 [docs/details.md](docs/details.md)。
