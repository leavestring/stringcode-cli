# String Code CLI · 弦码终端版

[![简体中文](https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-%E5%BD%93%E5%89%8D%E8%AF%AD%E8%A8%80-0969da?style=flat-square)](README.md) [![English](https://img.shields.io/badge/English-switch%20language-57606a?style=flat-square)](README.en.md)

**为 Windows Terminal 和 PowerShell 打造的本地编程 Agent。** 由 [leavestring](https://github.com/leavestring) 发起并维护。

在项目目录里启动 `stringcode`，接入你自己的 OpenAI 兼容模型。它可以读取和搜索工作区、展示文件修改预览、运行 PowerShell，并在下次启动时接着上一次会话。

## 安装

需要 **Windows、Node.js 24+ 和 npm**。在 PowerShell 中运行以下命令，从 [npm](https://www.npmjs.com/package/stringcode-cli) 安装。

~~~powershell
npm install -g stringcode-cli
stringcode --version
~~~

### 从 GitHub Release 安装

也可以从 [GitHub Releases](https://github.com/leavestring/stringcode-cli/releases) 下载 `stringcode-cli-0.4.0.tgz`，在下载目录打开 PowerShell 并运行以下命令。

~~~powershell
npm install -g .\stringcode-cli-0.4.0.tgz
~~~

## 接入模型

进入要处理的项目目录，打开终端输入：

~~~powershell
stringcode
~~~

### 直接接入 OpenAI 兼容模型

首次启动时输入模型服务的 **OpenAI 兼容 Base URL**（例如 `https://provider.example/v1`）和 **API Key**，然后选模型。模型列表不可用时，可以手动输入模型 ID。使用文件和 PowerShell 工具需要模型支持流式输出和工具调用。之后可用 `/provider` 切换服务商，用 `/model` 切换模型。

### 通过 magpie 接入模型

String Code CLI 支持把 magpie 的本地 OpenAI 兼容网关添加为模型供应商。先在 magpie 中启用所需的供应商，并保持网关运行。

在 String Code CLI 的输入框里输入 `/provider add`，按提示填写以下各项。首次启动时可直接在初始配置中填写网关地址和 API Key，再选择模型。

| 配置项 | 填写内容 |
| --- | --- |
| Base URL | `http://127.0.0.1:3425/v1`。如果修改过网关端口，换成实际端口，保留 `/v1` |
| Provider name（自定义，可留空） | 例如 `Magpie`。直接按 Enter 使用 Base URL 的主机名，默认地址对应 `127.0.0.1` |
| API Key | 同机接入时填 `magpie-stringcodecli`，用于在 magpie 中识别 String Code CLI 的请求 |
| Model | 从网关返回的列表中选择模型，手动输入时填写完整模型 ID，包括 `provider/` 前缀 |

例如，如果 magpie 的模型列表里有 WorkBuddy 供应商提供的模型，可以直接选择它。用 `/model` 可切换模型，用 `/provider` 可切换供应商。模型可用性取决于 magpie 中启用的供应商，文件和 PowerShell 工具需要所选模型支持流式输出和工具调用。

如果模型列表为空，先确认 magpie 正在运行，并检查所需模型是否出现在网关的 `/v1/models` 中。使用云模型时，magpie 会将模型请求转发给所选供应商。 [magpie 网关接入文档](https://usemagpie.ai/docs/zh/integrate)

## 试一个任务

在测试项目里输入：

> 读一下项目结构，拟一份简短的开发说明。先让我看改动，再写入 NOTES.md，最后用 PowerShell 确认文件内容。

新会话默认进入 **Ask**。写入前会展示修改预览，执行 PowerShell 前会询问是否批准。遇到折叠的审批详情，按 `d` 展开，按 `y` 批准。`Shift+Tab` 可切换模式，`Ctrl+C` 可中断当前轮次。

| 模式 | 行为 |
| --- | --- |
| Ask | 分别审批文件修改和 PowerShell 命令 |
| Plan | 先使用只读工具。批准计划后可在本轮修改文件，PowerShell 仍需单独审批 |
| Auto | 可直接调用可用工具，包括文件写入和 PowerShell |

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看完整命令表。输入 `/` 可用方向键浏览，Tab 补全 |
| `/new`、`/sessions`、`/resume <id>` | 新建、列出或恢复当前工作区的会话 |
| `/provider`、`/provider add`、`/provider key` | 切换、添加模型服务或更新密钥 |
| `/model [id]` | 选择或直接设置模型 |
| `/ask`、`/plan`、`/auto` | 切换审批模式 |
| `/tools` | 检查上一轮的工具输入和输出 |
| `/compact`、`/tokens` | 压缩早期对话、查看上下文估算和供应商报告的用量 |
| `/effort [auto\|low\|medium\|high]` | 设置推理强度，以所选模型支持的级别为准 |
| `/skills`、`/skills add "<path>"`、`/skills remove <name>` | 列出、挂载或移除工作区里的 `SKILL.md` |
| `/search`、`/search key`、`/search on`、`/search off` | 查看、配置或开关 AnySearch 网页搜索 |
| `/exit` | 退出。下次可在同一工作区用 `stringcode --resume <id>` 恢复 |

## 数据和执行权限

- 配置和 JSONL 会话默认保存在 `%LOCALAPPDATA%\StringCodeCLI`。可用 `STRINGCODE_HOME` 指定独立数据目录。
- 终端输入的 API Key 在输入时可见，保存时使用 Windows DPAPI。也可以通过 `STRINGCODE_API_KEY` 环境变量传入模型密钥。
- 参与模型请求的工作区片段和工具输出会发送给你选择的模型服务。网页搜索默认可用，调用时会把查询词发送给 AnySearch，受匿名配额限制。可配置 `ANYSEARCH_API_KEY`，或用 `/search off` 关闭搜索并移除本地保存的搜索密钥。
- 文件工具执行工作区路径检查，跳过 `.git`、`.env` 等受保护路径。**PowerShell 以当前 Windows 用户的权限运行**。Auto 模式下，命令执行无需逐条确认。

## 源码开发与贡献

欢迎 PR。第一次贡献可从 [good first issue](https://github.com/leavestring/stringcode-cli/labels/good%20first%20issue) 开始。修复问题时请附上最短的复现步骤，改动交互时可以附一段终端输出。提交前请运行 `npm test`，测试使用模拟模型服务，无需真实 API Key。

~~~powershell
git clone https://github.com/leavestring/stringcode-cli.git
Set-Location .\stringcode-cli
npm ci
npm test
npm start
~~~

`npm run build` 将 TypeScript 编译到 `dist/`。运行 `npm pack` 可打包当前源码，再用 `npm install -g .\stringcode-cli-0.4.0.tgz` 安装到全局。

## 许可证与代码来源

源码按 [GPL-3.0-only](LICENSE) 发布。作者署名、改版来源说明和品牌使用见 [NOTICE](NOTICE)。官方源码、Issue 和安装包由 [leavestring/stringcode-cli](https://github.com/leavestring/stringcode-cli) 发布。

SSE 解析器和 token 估算器沿用弦码桌面版提交 `6aaf4a96ba17d351c3c99a8e527ddbf9a16cf356`。Agent 循环、OpenAI 兼容流处理、会话展示、路径检查、Skill 元数据和上下文压缩改编自同一版本。

交互参考来自 [Claude Code](https://code.claude.com/docs/en/interactive-mode)、[OpenCode](https://opencode.ai/docs/permissions/) 和 [Gemini CLI](https://geminicli.com/docs/tools/shell/)。
