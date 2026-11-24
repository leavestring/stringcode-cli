# String Code CLI

[![简体中文](https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-%E5%88%87%E6%8D%A2%E8%AF%AD%E8%A8%80-57606a?style=flat-square)](README.md) [![English](https://img.shields.io/badge/English-current-0969da?style=flat-square)](README.en.md)

**A local coding agent for Windows Terminal and PowerShell.** Created and maintained by [leavestring](https://github.com/leavestring).

Run `stringcode` in a project folder and connect your own OpenAI-compatible model. String Code can read and search the workspace, preview file changes, run PowerShell commands, and resume a conversation later.

## Install

You need **Windows, Node.js 24 or later, and npm**. Run the following in PowerShell to install from [npm](https://www.npmjs.com/package/stringcode-cli).

~~~powershell
npm install -g stringcode-cli
stringcode --version
~~~

Open a terminal in the project folder you want to work on and run:

~~~powershell
stringcode
~~~

On first launch, enter your provider's **OpenAI-compatible Base URL** (for example, `https://provider.example/v1`) and **API key**, then select a model. If the model list is unavailable, enter the model ID manually. Choose a model with streaming and tool-call support to use the file and PowerShell tools. Use `/provider` or `/model` to change them later.

### Install from GitHub Releases

You can also download `stringcode-cli-0.4.0.tgz` from [GitHub Releases](https://github.com/leavestring/stringcode-cli/releases) and run the following command in PowerShell from the download directory.

~~~powershell
npm install -g .\stringcode-cli-0.4.0.tgz
~~~

## Connect to magpie

String Code CLI can use magpie's local OpenAI-compatible gateway as a model provider. Enable the providers you want in magpie and keep the gateway running.

Enter `/provider add` at the String Code CLI prompt and fill in the fields below. On first launch, enter the gateway URL and API key in the setup prompt, then select a model.

| Field | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:3425/v1`. If you changed the gateway port, use that port and keep `/v1` |
| Provider name | `Magpie` |
| API key | Use `magpie-stringcodecli` for a gateway on the same machine so magpie can identify requests from String Code CLI |
| Model | Pick a model from the gateway's list, or enter the full model ID, including the `provider/` prefix |

For example, you can choose a WorkBuddy model if it appears in magpie's model list. Use `/model` to switch models or `/provider` to switch providers. Model availability depends on the providers enabled in magpie. Choose a model with streaming and tool-call support to use the file and PowerShell tools.

If the model list is empty, check that magpie is running and that the gateway's `/v1/models` includes your model. When you use a cloud model, magpie forwards model requests to the selected provider. [magpie gateway integration guide](https://usemagpie.ai/docs/integrate)

## Try a task

Try this prompt in a test project.

> Read the project structure and draft a short development guide. Show me the file changes before writing NOTES.md, then verify the file with PowerShell.

New sessions start in **Ask** mode. The CLI previews file changes before writing and asks for approval before running PowerShell. Press `d` to expand a folded approval and `y` to approve it. Use `Shift+Tab` to switch modes or `Ctrl+C` to cancel the current turn.

| Mode | Behavior |
| --- | --- |
| Ask | Requests approval for individual file changes and PowerShell commands |
| Plan | Starts with read-only tools. Approving the plan enables file changes for that turn. PowerShell still requires individual approval |
| Auto | Runs available tools directly, including file writes and PowerShell |

## Common commands

| Command | Purpose |
| --- | --- |
| `/help` | Lists all commands. Type `/` to browse with the arrow keys and press Tab to complete |
| `/new`, `/sessions`, `/resume <id>` | Start, list, or resume workspace conversations |
| `/provider`, `/provider add`, `/provider key` | Switch or add a model provider, or update its key |
| `/model [id]` | Pick a model or set its ID directly |
| `/ask`, `/plan`, `/auto` | Switch approval modes |
| `/tools` | Inspect the last turn's tool activity |
| `/compact`, `/tokens` | Compact older messages, or inspect context estimates and reported token usage |
| `/effort [auto\|low\|medium\|high]` | Set the requested reasoning effort, subject to model support |
| `/skills`, `/skills add "<path>"`, `/skills remove <name>` | List, mount, or remove a workspace `SKILL.md` |
| `/search`, `/search key`, `/search on`, `/search off` | Check, configure, or toggle AnySearch |
| `/exit` | Exit. Run `stringcode --resume <id>` in the same workspace to continue later |

## Data and execution permissions

- The default data directory is `%LOCALAPPDATA%\StringCodeCLI`. It holds configuration and JSONL session history. Set `STRINGCODE_HOME` to use a different directory.
- API key input is visible in the terminal. Windows DPAPI protects keys saved by the CLI. You can also supply the model key through `STRINGCODE_API_KEY`.
- Workspace excerpts and tool output included in requests go to the model provider you choose. Web search is enabled by default and sends queries to AnySearch when used, subject to its anonymous quota. Set `ANYSEARCH_API_KEY` for authenticated search, or use `/search off` to disable search and remove its saved key.
- File tools check workspace paths and skip protected paths such as `.git` and `.env`. **PowerShell runs with your Windows user's permissions.** Auto mode runs commands without individual approval.

## Develop and contribute

Pull requests are welcome. For a first contribution, pick a [good first issue](https://github.com/leavestring/stringcode-cli/labels/good%20first%20issue). For a fix, include the shortest way to reproduce the problem. For an interaction change, a short terminal transcript can help. Run `npm test` before opening a PR. The tests use a simulated provider and require no real API key.

~~~powershell
git clone https://github.com/leavestring/stringcode-cli.git
Set-Location .\stringcode-cli
npm ci
npm test
npm start
~~~

`npm run build` compiles TypeScript into `dist/`. Run `npm pack` to build an installable package, then `npm install -g .\stringcode-cli-0.4.0.tgz` to install it globally.

## License and code origins

String Code CLI is licensed under [GPL-3.0-only](LICENSE). See [NOTICE](NOTICE) for author attribution, the origin of modified versions, and use of the project branding. [leavestring/stringcode-cli](https://github.com/leavestring/stringcode-cli) is the official home for the source, issues, and releases.

The SSE parser and token estimator come from the String Code desktop project at commit `6aaf4a96ba17d351c3c99a8e527ddbf9a16cf356`. The agent loop, OpenAI-compatible streaming, transcript display, path checks, skill metadata, and context compaction were adapted from the same revision.

Interaction references include [Claude Code](https://code.claude.com/docs/en/interactive-mode), [OpenCode](https://opencode.ai/docs/permissions/), and [Gemini CLI](https://geminicli.com/docs/tools/shell/).
