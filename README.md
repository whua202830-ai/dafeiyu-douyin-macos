# 大肥鱼抖音插件 Mac 版

**面向 macOS 的 DeepSeek Harness 抖音插件适配，包含可复用 skill、插件源码和离线更新安装器。**

当前版本：`1.4.5-macos.1`。基于 [LockyBee/dsh-douyin-agent](https://github.com/LockyBee/dsh-douyin-agent) 的 `dsh-douyin-browser-local@1.4.5` 制作，是社区维护的 Mac 适配版。不是 DeepSeek 或抖音官方插件；未发布到 npm 或插件市场。

## Mac 版解决了什么

- 识别 `/Applications` 与 `~/Applications` 内的 **Google Chrome / Microsoft Edge / Chromium**，Mac 优先使用 Chrome；无需为了使用本插件专门安装 Edge。
- 识别 DeepSeek Harness 自带的独立 **Node.js**，实际探测 `node:sqlite`；拒绝把 Electron 包装脚本当作 Node。
- 启动与自检共用浏览器定位逻辑；浏览器始终使用专用资料目录，不接管日常 Chrome 资料。
- 可选音频 Python 支持 Mac venv 和 DSH 自己的运行时；去掉对 Codex 私有运行时的依赖。
- 更新 Mac 使用说明、故障处理和 skill；保留 Windows 的既有发现逻辑，Windows 未在本轮实机复验。

## Skill

入口：[SKILL.md](SKILL.md)，技能名为 `dafeiyu-douyin-macos`，明确标注为**大肥鱼抖音插件 Mac 版**。

Skill 说明如何在 DSH 内使用原生抖音工具，区分准备页、实际播放、图像采样、模型判断和发送许可。它需要配套插件，单独复制文字不会获得浏览器工具。完整插件源码位于 [plugin/](plugin/)，随包 skill 位于 [plugin/skill/SKILL.md](plugin/skill/SKILL.md)。

## 安装与更新

从 [Releases](https://github.com/whua202830-ai/dafeiyu-douyin-macos/releases) 下载同一版本的这两个文件，放在同一目录：

- `dsh-douyin-browser-local-1.4.5-macos.1.tgz`
- `install-macos.py`

本安装器的已验证范围是：**Mac 上已有 `dsh-douyin-browser-local@1.4.5` 的 DSH Desktop 安装**。它不会安装 DSH、浏览器或运行依赖，也不会处理其他上游版本。首次安装到空白 profile 尚未验收。

在 DSH 插件管理中暂时关闭抖音插件，然后在下载目录执行（Python 3.9+）：

```bash
# 只检查，不写入
python3 install-macos.py

# 执行更新，并自动备份
python3 install-macos.py --install
```

完成后重新启用抖音插件。默认目录为 `~/.dsh/profiles/desktop`；安装器会把来源固定到 `~/.dsh/douyin-browser/releases/` 中的本地包，并注册 DSH 自己的 skill 入口。不会连接 Codex 的可写技能或插件目录。

## 使用

1. 打开 **DeepSeek → 设置 → 刷抖音 → 自检与用量**，确认 Node 与浏览器检查通过。
2. 在“基础设置”选择已配置且支持图片输入的 DSH 模型。
3. 点“打开抖音”，在专用准备页自行登录或完成验证码。准备页保持暂停。
4. 在“视频观看”设置时段、每日分钟数和模型请求额度，再明确启动观看。

音频后端和 Hindsight 不是纯画面观看的前置条件。评论、私信、分享分别受许可和开关约束，安装或自检不代表允许外发。

详细运行说明见 [Mac 适配说明](plugin/docs/macos.md)。

## 已验证与限制

| 项目 | 结果 |
| --- | --- |
| 平台与路径回归 | 17 项通过 |
| 实际 Chrome 隔离测试 | 专用资料、CDP、准备页暂停与复用通过；使用合成页面，不访问抖音 |
| DSH Desktop 宿主自检 | 15 项通过 |
| 登录后的真实试刷 | 实际播放约 24 秒，3 次观察、2 个作品 ID，完成 2 次模型响应 |
| 模型行为 | 根据实际画面识别内容并决定继续停留；没有启用音频 |
| 试验结束 | 第 3 次请求期间宿主重启，已停止观看并恢复原额度；未将重启归因为插件崩溃 |

**未单独验收：显式换片动作、长时间后台运行、Windows 实机、音频转写、真实评论/私信/分享。** 同一轮试刷不能证明所有页面与账号都稳定可用。测试记录见 [VERIFY.md](VERIFY.md)。

当前继承的默认 `stateDir` 仍位于插件安装目录；包管理器重新安装可能覆盖该目录中的模型选择等状态。需要长期保存时，应先备份并按 [运行位置说明](plugin/docs/macos.md) 配置持久状态目录；本版没有进行该迁移。浏览器登录和共同记忆使用独立的 `~/.dsh/douyin-browser/` 目录。

## 开发验证

安装与包清单一致的依赖后，在 `plugin/` 中使用 Node 22.13+ 执行：

```bash
node --test tests/platform.test.mjs
node tests/browser-smoke.mjs
```

第二条会启动真实浏览器，但使用临时资料和合成页面。测试不会读取个人浏览器资料、登录、调用模型或发送消息。

## 备份与回滚

备份位置：`~/.dsh/douyin-browser/backups/<安装时间>-macos.1/`。先关闭本插件，使用实际备份目录检查：

```bash
python3 install-macos.py --rollback "$HOME/.dsh/douyin-browser/backups/<安装时间>-macos.1"
```

核对后追加 `--install` 执行。回滚只恢复本次安装的文件；检测到后续修改会停止，profile 仅恢复本插件依赖项。回滚不会清空观看账本、记忆或登录资料。

## 来源与许可证

原作者：**LockyBee and contributors**。本仓库由 `whua202830-ai` 发布 Mac 适配与 skill 整理，保留原作者版权及 [MIT LICENSE](LICENSE)。

第三方来源和许可证见 [THIRD_PARTY_NOTICES.md](plugin/THIRD_PARTY_NOTICES.md) 及 [media/vendor](plugin/media/vendor/)。`plugin/docs/` 中的上游历史记录保留其原日期，不代表本 Mac 版已经完成同样的验收。
