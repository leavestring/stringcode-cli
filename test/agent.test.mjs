// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { runTurn, latestUsage, sessionContext } from "../dist/agent.js"
import { buildContext, manualCompact } from "../dist/context.js"
import { Workspace } from "../dist/workspace.js"
import { deriveModelMessages, lastTurnTools, Sessions } from "../dist/sessions.js"
import { loadSkill } from "../dist/skills.js"
import { availableTools } from "../dist/tools.js"
import { createWebSearch } from "../dist/web-search.js"

const apiKey = "fixture-api-key-1234567890"
const ready = { choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }

async function fixture(t) {
  const parent = await mkdtemp(path.join(tmpdir(), "string code fixture "))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const dataDir = path.join(parent, "cli home")
  const root = path.join(parent, "workspace with spaces")
  await mkdir(root)
  await mkdir(dataDir)
  const workspace = await Workspace.open(root, dataDir)
  const sessions = new Sessions(dataDir, workspace.root)
  const session = await sessions.open()
  t.after(() => session.close())
  return { workspace, sessions, session, parent, dataDir }
}

async function provider(t, handler) {
  const requests = []
  const errors = []
  const server = createServer(async (req, res) => {
    try {
      let input = ""
      for await (const chunk of req) input += chunk
      const body = JSON.parse(input)
      requests.push(body)
      assert.equal(req.url, "/v1/chat/completions")
      assert.equal(req.headers.authorization, "Bearer " + apiKey)
      await handler(body, res, requests.length)
    } catch (error) {
      errors.push(error)
      if (!res.headersSent) res.writeHead(500)
      res.end("mock error")
    }
  })
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    assert.deepEqual(errors, [])
  })
  return {
    config: { baseUrl: "http://127.0.0.1:" + server.address().port + "/v1", model: "mock-model" },
    requests,
  }
}

function sse(res, ...events) {
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const event of events) res.write("data: " + JSON.stringify(event) + "\r\n\r\n")
  res.end("data: [DONE]\n\n")
}

function calls(res, id, name, args, finish = "tool_calls") {
  const text = JSON.stringify(args)
  const halfway = Math.ceil(text.length / 2)
  sse(res,
    { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: text.slice(0, halfway) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: text.slice(halfway) } }] }, finish_reason: finish }] },
  )
}

function userInterface(approve = async () => true) {
  const events = { approvals: [], text: "", tools: [], notices: [], snapshots: [] }
  return {
    events,
    text: (chunk) => { events.text += chunk },
    thinking() {},
    notice: (notice) => events.notices.push(notice),
    tool: (name, state, detail) => events.tools.push({ name, state, detail }),
    context: (snapshot) => events.snapshots.push(snapshot),
    approve: async (approval, signal) => {
      events.approvals.push(approval)
      return approve(approval, signal)
    },
  }
}

function args(f, config, mode = "ask") {
  return { workspace: f.workspace, session: f.session, config, apiKey, mode }
}

function lastTool(body) {
  return body.messages.findLast((message) => message.role === "tool")?.content ?? ""
}

test("streams a multi-step search, file edit, and PowerShell test in a workspace with spaces", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t)
  const filename = path.join(f.workspace.root, "sample file.txt")
  await writeFile(filename, "Old value\r\nKeep line\r\n")
  const previousEnv = process.env.STRINGCODE_API_KEY
  const previousSearchKey = process.env.ANYSEARCH_API_KEY
  process.env.STRINGCODE_API_KEY = apiKey
  process.env.ANYSEARCH_API_KEY = "shell-fixture-search-key"
  t.after(() => {
    if (previousEnv === undefined) delete process.env.STRINGCODE_API_KEY
    else process.env.STRINGCODE_API_KEY = previousEnv
    if (previousSearchKey === undefined) delete process.env.ANYSEARCH_API_KEY
    else process.env.ANYSEARCH_API_KEY = previousSearchKey
  })
  const mock = await provider(t, async (body, res, count) => {
    if (count === 1) {
      assert.deepEqual(body.tools.map((tool) => tool.function.name), ["ReadFile", "Glob", "Grep", "WriteFile", "EditFile", "Shell"])
      calls(res, "search1", "Grep", { query: "Old value" })
    } else if (count === 2) {
      assert.match(lastTool(body), /sample file\.txt:1: Old value/)
      calls(res, "read1", "ReadFile", { path: "sample file.txt" })
    } else if (count === 3) {
      assert.match(lastTool(body), /CRLF/)
      calls(res, "edit1", "EditFile", { path: "sample file.txt", old_text: "Old value", new_text: "New value" })
    } else if (count === 4) {
      assert.match(lastTool(body), /Saved sample file/)
      calls(res, "shell1", "Shell", {
        command: "if (Test-Path Env:STRINGCODE_API_KEY) { throw 'key inherited' }\n" +
          "if (Test-Path Env:ANYSEARCH_API_KEY) { throw 'search key inherited' }\n" +
          "if ((Get-Content -Raw -LiteralPath 'sample file.txt') -notmatch 'New value') { exit 4 }\nWrite-Output 'PASS'",
      })
    } else {
      assert.match(lastTool(body), /Exit: 0[\s\S]*PASS/)
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "Updated " + apiKey.slice(0, 9) } }] }) + "\n\n")
      const rest = Buffer.from("data: " + JSON.stringify({ choices: [{ delta: { content: apiKey.slice(9) + " ✓" }, finish_reason: "stop" }] }) + "\n\n")
      const char = rest.indexOf(Buffer.from("✓"))
      res.write(rest.subarray(0, char + 1))
      await delay(15)
      res.write(rest.subarray(char + 1))
      res.end("data: {\"usage\":{\"prompt_tokens\":123,\"completion_tokens\":5,\"total_tokens\":128}}\n\ndata: [DONE]\n\n")
    }
  })
  const ui = userInterface(async (prompt) => {
    if (prompt.title.startsWith("Modify")) {
      assert.equal(await readFile(filename, "utf8"), "Old value\r\nKeep line\r\n")
      assert.match(prompt.detail, /-Old value/)
      assert.match(prompt.detail, /\+New value/)
    } else {
      assert.match(prompt.detail, /workspace with spaces/)
      assert.match(prompt.detail, /Write-Output 'PASS'/)
    }
    return true
  })
  assert.equal(await runTurn(args(f, mock.config), "Find and change Old value, then test it.", new AbortController().signal, ui), "complete")
  assert.equal(mock.requests.length, 5)
  assert.equal(await readFile(filename, "utf8"), "New value\r\nKeep line\r\n")
  assert.equal(ui.events.approvals.length, 2)
  assert.equal(ui.events.text, "Updated [REDACTED] ✓")
  assert.equal(latestUsage(f.session).usage.total, 128)
  assert.doesNotMatch(JSON.stringify(f.session.events), /fixture-api-key/)
})

test("web search sends only the query with its own key and works after changing models", async (t) => {
  const f = await fixture(t)
  const searchKey = "fixture-separate-search-key"
  const queries = []
  const webSearch = createWebSearch(searchKey, async (url, init) => {
    assert.equal(url, "https://api.anysearch.com/v1/search")
    assert.equal(init.redirect, "error")
    assert.equal(init.headers.Authorization, "Bearer " + searchKey)
    const body = JSON.parse(init.body)
    assert.deepEqual(Object.keys(body), ["query", "max_results"])
    assert.equal(body.max_results, 5)
    queries.push(body.query)
    return Response.json({ code: 0, data: { results: [{
      title: "Release notes", url: "https://example.test/releases", snippet: "Latest details. " + searchKey,
    }] } })
  })
  const mock = await provider(t, (body, res, count) => {
    assert.equal(body.model, count <= 2 ? "chat-first" : "chat-second")
    assert.doesNotMatch(JSON.stringify(body), /fixture-separate-search-key/)
    assert.match(body.messages[0].content, /AnySearch web search is on with an API key configured/)
    assert.match(body.messages[0].content, /\/search key/)
    assert.ok(body.tools.some(({ function: { name } }) => name === "WebSearch"))
    if (count % 2 === 1) {
      calls(res, "web-" + count, "WebSearch", { query: "release notes " + body.model })
    } else {
      assert.match(lastTool(body), /Found 1 web result\.[\s\S]+https:\/\/example\.test\/releases/)
      sse(res, { choices: [{ delta: { content: "[Release notes](https://example.test/releases)" }, finish_reason: "stop" }] })
    }
  })
  for (const model of ["chat-first", "chat-second"]) {
    const ui = userInterface()
    const options = { ...args(f, { ...mock.config, model }), webSearch }
    assert.equal(await runTurn(options, "Find release notes.", new AbortController().signal, ui), "complete")
    assert.equal(ui.events.approvals.length, 0)
    assert.match(ui.events.text, /https:\/\/example\.test\/releases/)
    assert.equal(ui.events.tools[0].name, "WebSearch")
  }
  assert.deepEqual(queries, ["release notes chat-first", "release notes chat-second"])
  assert.doesNotMatch(JSON.stringify(f.session.events), /fixture-separate-search-key/)
})

test("the model sees whether AnySearch is off or configured for anonymous search", async (t) => {
  const f = await fixture(t)
  const options = args(f, { baseUrl: "http://127.0.0.1:12345/v1", model: "mock-model" })
  const disabled = sessionContext(options)
  assert.match(disabled.messages[0].content, /AnySearch web search is off.*\/search on/)
  const anonymous = sessionContext({ ...options, webSearch: createWebSearch() })
  assert.match(anonymous.messages[0].content, /AnySearch web search is on in anonymous mode/)
  assert.match(anonymous.messages[0].content, /\/search key.*String Code prompt/)
  assert.equal(f.session.events.length, 0)
})

test("AnySearch sends no authorization in anonymous mode and keeps quota credentials out of results", async () => {
  const signal = new AbortController().signal
  const anonymous = createWebSearch(undefined, async (_url, init) => {
    assert.ok(!new Headers(init.headers).has("Authorization"))
    return Response.json({ code: 0, data: { results: [
      { title: "Release notes", url: "https://example.test/releases", content: "Latest version" },
      { title: "Readme", url: "https://example.test/readme" },
    ] } })
  })
  assert.match(await anonymous("release notes", signal), /Found 2 web results\.[\s\S]+Latest version[\s\S]+\/readme/)

  const quota = createWebSearch(undefined, async () => Response.json({
    code: -1, message: "Quota reached. api_key=fixture-generated-key",
  }, { status: 402 }))
  await assert.rejects(quota("release notes", signal), {
    message: "The AnySearch anonymous quota is exhausted. Use /search key to configure an AnySearch API key.",
  })
})

test("AnySearch reports service errors without exposing the response body", async () => {
  const key = "fixture-separate-search-key"
  const search = createWebSearch(key, async () => new Response("Invalid token: " + key, { status: 401 }))
  const signal = new AbortController().signal
  await assert.rejects(search("release notes", signal), { message: "AnySearch rejected the API key. Check /search key or ANYSEARCH_API_KEY." })
  await assert.rejects(search(key, signal), { message: "The search query contains the search API key." })
  const empty = createWebSearch(key, async () => Response.json({ code: 0, data: { results: [] } }))
  assert.equal(await empty("release notes", signal), "No web results.")
})

test("denies writes, rejects unadvertised plan-mode tools, and still asks before Shell after plan approval", async (t) => {
  const f = await fixture(t)
  const mock = await provider(t, (body, res, index) => {
    if (index === 1) {
      assert.ok(!body.tools.some((tool) => tool.function.name === "Shell"))
      calls(res, "blocked", "Shell", { command: "Write-Output blocked" })
    } else if (index === 2) {
      assert.match(lastTool(body), /unavailable/)
      calls(res, "plan", "SubmitPlan", { plan: "Create notes.txt and check the result." })
    } else if (index === 3) {
      assert.match(lastTool(body), /approved/i)
      calls(res, "write", "WriteFile", { path: "notes.txt", content: "approved plan" })
    } else if (index === 4) {
      calls(res, "shell", "Shell", { command: "Set-Content forbidden.txt runaway" })
    } else if (index === 5) {
      assert.match(lastTool(body), /User denied/)
      sse(res, ready)
    } else if (index === 6) {
      calls(res, "denied-write", "WriteFile", { path: "forbidden.txt", content: "runaway" })
    } else if (index === 7) {
      assert.match(lastTool(body), /User denied/)
      sse(res, ready)
    } else {
      sse(res, ready)
    }
  })
  const ui = userInterface(async (prompt) => prompt.title.includes("plan"))
  await runTurn(args(f, mock.config, "plan"), "Plan and create notes.", new AbortController().signal, ui)
  await runTurn(args(f, mock.config), "Try to create another file.", new AbortController().signal, ui)
  assert.equal(await readFile(path.join(f.workspace.root, "notes.txt"), "utf8"), "approved plan")
  await assert.rejects(readFile(path.join(f.workspace.root, "forbidden.txt")), { code: "ENOENT" })
  assert.deepEqual(ui.events.approvals.map((item) => item.title), [
    "Approve this turn's plan", "Run PowerShell", "Create forbidden.txt",
  ])
})

test("runs file writes and PowerShell without approval in Auto", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t)
  const mock = await provider(t, (body, res, index) => {
    if (index === 1) {
      calls(res, "auto-write", "WriteFile", { path: "automatic.txt", content: " from the file tool" })
    } else if (index === 2) {
      assert.match(lastTool(body), /Saved automatic.txt/)
      calls(res, "auto-shell", "Shell", { command: "Get-Content -Raw -LiteralPath 'automatic.txt'" })
    } else {
      assert.match(lastTool(body), /Exit: 0[\s\S]*from the file tool/)
      sse(res, ready)
    }
  })
  const ui = userInterface(async () => {
    assert.fail("Auto prompted for approval")
  })
  assert.equal(await runTurn(args(f, mock.config, "auto"), "Write and read a sample.", new AbortController().signal, ui), "complete")
  assert.equal(ui.events.approvals.length, 0)
})

test("marks a failed request as historical when a fresh message follows", async (t) => {
  const f = await fixture(t)
  const mock = await provider(t, (body, res, index) => {
    if (index === 1) {
      res.writeHead(500, { "content-type": "application/json" }).end('{"error":{"message":"temporary failure"}}')
    } else {
      assert.match(body.messages.find((message) => message.role === "user").content, /Earlier unfinished request/)
      assert.equal(body.messages.at(-1).content, "Hello")
      sse(res, ready)
    }
  })
  const ui = userInterface()
  await assert.rejects(runTurn(args(f, mock.config), "Create a file.", new AbortController().signal, ui), /temporary failure/)
  await runTurn(args(f, mock.config, "auto"), "Hello", new AbortController().signal, ui)
  assert.equal(ui.events.approvals.length, 0)
})

test("recovers from one output limit using recorded results without replaying a write", async (t) => {
  const f = await fixture(t)
  const mock = await provider(t, (body, res, index) => {
    if (index === 1) {
      assert.equal(body.max_tokens, 3200)
      return calls(res, "initial", "WriteFile", { path: "result.txt", content: "initial result" })
    }
    if (index === 2) {
      assert.match(lastTool(body), /Saved result.txt/)
      return sse(res, { choices: [{ delta: { content: "Unfinished draft", tool_calls: [{
        index: 0, id: "truncated-call-fixture", function: { arguments: '{"path":' },
      }] }, finish_reason: "length" }] })
    }
    assert.equal(body.max_tokens, 6400)
    if (index === 3) {
      assert.match(body.messages[0].content, /previous model response hit its output limit/)
      assert.match(lastTool(body), /Saved result.txt/)
      assert.doesNotMatch(JSON.stringify(body), /Unfinished draft|truncated-call-fixture/)
      return calls(res, "recover", "ReadFile", { path: "result.txt" })
    }
    assert.match(lastTool(body), /initial result/)
    assert.doesNotMatch(body.messages[0].content, /previous model response hit its output limit/)
    sse(res, ready)
  })
  const ui = userInterface()
  assert.equal(await runTurn(args(f, mock.config), "Write and verify a result.", AbortSignal.timeout(5000), ui), "complete")
  assert.equal(mock.requests.length, 4)
  assert.equal(ui.events.approvals.length, 1)
  assert.equal(ui.events.notices.filter((notice) => /output limit/.test(notice)).length, 1)
  assert.equal(await readFile(path.join(f.workspace.root, "result.txt"), "utf8"), "initial result")
  assert.ok(f.session.events.some(({ data }) => data.truncated && data.content === "Unfinished draft"))
})

test("skips truncated tool calls and bounds recovery while pending approvals remain cancelable", async (t) => {
  const f = await fixture(t)
  const mock = await provider(t, (body, res, index) => {
    if (index === 4) {
      assert.match(lastTool(body), /interrupted/)
      assert.ok(body.messages.every((message) => message.role !== "assistant" || message.content || message.tool_calls?.length))
      sse(res, ready)
    } else {
      calls(res, "write-" + index, "WriteFile", { path: "blocked.txt", content: "should never appear" }, index <= 2 ? "length" : "tool_calls")
    }
  })
  const controller = new AbortController()
  const ui = userInterface(async () => {
    controller.abort()
    return true
  })
  await assert.rejects(runTurn(args(f, mock.config), "first", new AbortController().signal, ui), /length/)
  assert.equal(mock.requests.length, 2)
  assert.deepEqual(lastTurnTools(f.session.events), [])
  assert.equal(ui.events.approvals.length, 0)
  assert.equal(await runTurn(args(f, mock.config), "second", controller.signal, ui), "canceled")
  assert.equal(lastTurnTools(f.session.events)[0].result, undefined)
  await runTurn(args(f, mock.config), "inspect state", new AbortController().signal, ui)
  await assert.rejects(readFile(path.join(f.workspace.root, "blocked.txt")), { code: "ENOENT" })
})

test("recovers from the WorkBuddy output-limit error frame", async (t) => {
  const f = await fixture(t)
  const mock = await provider(t, (body, res, index) => {
    if (index === 1) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end("data: " + JSON.stringify({ error: { message:
        "WorkBuddy: an empty reply (the model answered nothing; try again) — cut at its length, the whole output spent on reasoning",
      } }) + "\n\n")
    } else {
      assert.match(body.messages[0].content, /previous model response hit its output limit/)
      assert.equal(body.max_tokens, 6400)
      sse(res, ready)
    }
  })
  const ui = userInterface()
  const signal = AbortSignal.timeout(5000)
  assert.equal(await runTurn(args(f, mock.config), "Summarize the task.", signal, ui), "complete")
  assert.equal(mock.requests.length, 2)
  assert.equal(ui.events.text, "Done.")
})

test("feeds PowerShell timeout and checkpoint guidance back into the same turn", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t)
  const mock = await provider(t, (body, res, index) => {
    if (index === 1) {
      const shell = body.tools.find(({ function: tool }) => tool.name === "Shell").function
      assert.match(shell.description, /small sample/)
      assert.match(shell.parameters.properties.timeout_ms.description, /100 to 300000, default 120000/)
      return calls(res, "long", "Shell", { command: "Write-Output 'checkpoint logged'; Start-Sleep -Seconds 20", timeout_ms: 2000 })
    }
    if (index === 2) {
      assert.match(lastTool(body), /timed out after 2000 ms[\s\S]*partial files or checkpoints[\s\S]*smaller sample or batch[\s\S]*checkpoint logged/)
      return calls(res, "probe", "Shell", { command: "Write-Output 'small probe passed'", timeout_ms: 5000 })
    }
    assert.match(lastTool(body), /Exit: 0[\s\S]*small probe passed/)
    sse(res, ready)
  })
  const ui = userInterface()
  assert.equal(await runTurn(args(f, mock.config), "Run a check.", AbortSignal.timeout(15_000), ui), "complete")
  assert.equal(mock.requests.length, 3)
  assert.deepEqual(ui.events.approvals.map(({ detail }) => detail.match(/Timeout: \d+ ms/)?.[0]), ["Timeout: 2000 ms", "Timeout: 5000 ms"])
})

test("last-turn tool results stay paired when a provider reuses a tool ID in a later batch", async (t) => {
  const f = await fixture(t)
  const duplicateId = "reused-id"
  const mock = await provider(t, (body, res, count) => {
    if (count === 1) return calls(res, duplicateId, "Glob", { pattern: "sample.txt" })
    if (count === 2) return calls(res, duplicateId, "ReadFile", { path: "sample.txt" })
    assert.match(lastTool(body), /file contents with a distinct marker/)
    sse(res, ready)
  })
  await writeFile(path.join(f.workspace.root, "sample.txt"), "file contents with a distinct marker")
  await runTurn(args(f, mock.config), "Find and read sample.txt.", new AbortController().signal, userInterface())

  const [glob, read] = lastTurnTools(f.session.events)
  assert.equal(glob.call.name, "Glob")
  assert.equal(glob.result, "sample.txt")
  assert.equal(read.call.name, "ReadFile")
  assert.match(read.result, /file contents with a distinct marker/)
})

test("model errors are surfaced and tool support can fall back to text", async (t) => {
  const f = await fixture(t)
  const mock = await provider(t, (body, res, count) => {
    if (count === 1) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Bad key " + apiKey } }))
    } else if (count === 2) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "tools are not supported" } }))
    } else if (count === 3) {
      assert.ok(!body.tools)
      sse(res, ready)
    }
  })
  const ui = userInterface()
  await assert.rejects(runTurn(args(f, mock.config), "auth error", new AbortController().signal, ui), /401: Bad key \[REDACTED\]/)
  await runTurn(args(f, mock.config), "text fallback", new AbortController().signal, ui)
  assert.ok(ui.events.notices.some((notice) => notice.includes("rejected tool calling")))
  assert.equal(mock.requests.length, 3)
})

test("after 24 tool steps, the last result gets a text-only summary with a visible fallback", async (t) => {
  const f = await fixture(t)
  const mock = await provider(t, (body, res, count) => {
    if (body.tools) {
      calls(res, "loop-" + count, "Glob", { pattern: "**/*.txt" })
      return
    }
    assert.equal(body.tool_choice, undefined)
    assert.match(body.messages[0].content, /The tool step limit has been reached/)
    assert.ok(lastTool(body))
    if (count === 25) {
      assert.equal(body.messages.at(-1).tool_call_id, "loop-24")
      sse(res, { choices: [{ delta: { content: "The searches finished. No files were changed." }, finish_reason: "stop" }] })
    } else {
      calls(res, "should-not-run", "WriteFile", { path: "blocked.txt", content: "unexpected" })
    }
  })
  const ui = userInterface()
  assert.equal(await runTurn(args(f, mock.config, "auto"), "bounded loop", new AbortController().signal, ui), "limit")
  assert.equal(mock.requests.length, 25)
  assert.equal(ui.events.tools.filter(({ state }) => state === "result").length, 24)
  assert.match(ui.events.text, /No files were changed/)
  assert.ok(deriveModelMessages(f.session.events).some(({ content }) => content === ui.events.text))

  const fallback = userInterface()
  assert.equal(await runTurn(args(f, mock.config, "auto"), "bounded loop without summary", new AbortController().signal, fallback), "limit")
  assert.equal(mock.requests.length, 50)
  assert.equal(fallback.events.text, "")
  assert.ok(fallback.events.notices.some((notice) => notice.includes("Final summary unavailable. Use /tools")))
  assert.ok(fallback.events.tools.every(({ name }) => name === "Glob"))
  await assert.rejects(readFile(path.join(f.workspace.root, "blocked.txt")), { code: "ENOENT" })
})

test("sends a requested effort and retries without it when the provider rejects it", async (t) => {
  const f = await fixture(t)
  let rejected = 0
  const mock = await provider(t, (body, res, count) => {
    if (count === 1) {
      assert.equal(body.reasoning_effort, "high")
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Unsupported parameter: reasoning_effort" } }))
    } else if (count === 2) {
      assert.equal(body.reasoning_effort, undefined)
      calls(res, "search", "Glob", { pattern: "**" })
    } else {
      assert.equal(body.reasoning_effort, undefined)
      sse(res, ready)
    }
  })
  const ui = userInterface()
  const options = { ...args(f, mock.config), effort: "high", onEffortUnavailable: () => rejected++ }
  assert.equal(await runTurn(options, "Test effort fallback.", new AbortController().signal, ui), "complete")
  assert.equal(rejected, 1)
  assert.equal(mock.requests.length, 3)
  assert.ok(ui.events.notices.some((notice) => notice.includes("Retrying with its default")))
})

test("reuses successful gateway compatibility settings after a tool call and on the next turn", async (t) => {
  const f = await fixture(t)
  const mock = await provider(t, (body, res, count) => {
    if (count === 1 || count === 2) {
      const field = count === 1 ? "stream_options" : "max_tokens"
      assert.ok(body[field])
      res.writeHead(400, { "content-type": "application/json" })
      return res.end(JSON.stringify({ error: { message: "Unsupported parameter: " + field } }))
    }
    assert.equal(body.stream_options, undefined)
    assert.equal(body.max_tokens, undefined)
    assert.ok(body.max_completion_tokens > 0)
    if (count === 3) return calls(res, "glob", "Glob", { pattern: "*.txt" })
    sse(res, ready)
  })
  const options = { ...args(f, mock.config), compatibility: {} }
  const signal = new AbortController().signal
  assert.equal(await runTurn(options, "Find text files.", signal, userInterface()), "complete")
  assert.equal(await runTurn(options, "Confirm the result.", signal, userInterface()), "complete")
  assert.equal(mock.requests.length, 5)
})

test("workspace tools protect paths, match globs, create files and reject edit conflicts", async (t) => {
  const f = await fixture(t)
  const file = path.join(f.workspace.root, "code.ts")
  await writeFile(file, "let one = 1\nlet two = 2\n")
  await writeFile(path.join(f.workspace.root, ".env"), "protected")
  await mkdir(path.join(f.workspace.root, "src"))
  await writeFile(path.join(f.workspace.root, "src", "demo.ts"), "let three = 3\n")
  const outside = path.join(f.parent, "outside")
  await mkdir(outside)
  await symlink(outside, path.join(f.workspace.root, "junction"), process.platform === "win32" ? "junction" : "dir")
  const context = { workspace: f.workspace, apiKey, signal: new AbortController().signal }
  const prepare = (name, request) => availableTools("ask", false).find((tool) => tool.definition.function.name === name).prepare(request, context)

  for (const forbidden of ["../outside", ".env", ".git/config", "junction", f.dataDir]) {
    await assert.rejects(async () => (await prepare("ReadFile", { path: forbidden })).execute(), /protected|outside|junction/i)
  }
  if (process.platform === "win32") {
    await assert.rejects(async () => (await prepare("ReadFile", { path: "code.ts:stream" })).execute(), /Unsupported Windows/)
  }
  const glob = await (await prepare("Glob", { pattern: "**/*.ts" })).execute()
  assert.deepEqual(glob.split("\n"), ["code.ts", "src/demo.ts"])
  assert.match(await (await prepare("Grep", { query: "three", glob: "src/**" })).execute(), /demo\.ts:1/)
  const create = await prepare("WriteFile", { path: "src/extra dir/new.txt", content: "new" })
  await create.execute()
  assert.equal(await readFile(path.join(f.workspace.root, "src", "extra dir", "new.txt"), "utf8"), "new")
  await assert.rejects(prepare("EditFile", { path: "code.ts", old_text: "let", new_text: "const" }), /more than once/)
  const edit = await prepare("EditFile", { path: "code.ts", old_text: "one", new_text: "first" })
  await writeFile(file, "External write\n")
  await assert.rejects(edit.execute(), /changed since preview/)
  assert.equal(await readFile(file, "utf8"), "External write\n")
})

test("session locks are exclusive and resume from torn logs without guessing tool results", async (t) => {
  const f = await fixture(t)
  const session = await f.sessions.open()
  await session.append({ type: "user/message", content: "recover pending operation" })
  await session.append({
    type: "assistant/message", content: "", model: "mock-model",
    toolCalls: [{ id: "pending", name: "WriteFile", arguments: "{}" }],
  })
  await assert.rejects(f.sessions.open(session.id), /already open/)
  assert.ok((await f.sessions.list()).some((entry) => entry.id === session.id))
  const other = new Sessions(f.dataDir, path.join(f.parent, "another project"))
  await assert.rejects(other.open(session.id), /not found/)
  await session.close()
  const base = path.join(f.dataDir, "sessions")
  const [folder] = await readdir(base)
  const log = path.join(base, folder, session.id + ".jsonl")
  await appendFile(log, "{\"seq\": 3, \"partial\":")
  const resumed = await f.sessions.open(session.id)
  t.after(() => resumed.close())
  const messages = deriveModelMessages(resumed.events)
  assert.match(messages.at(-1).content, /interrupted/)
  await resumed.append({ type: "user/message", content: "follow-up" })
  assert.doesNotMatch(await readFile(log, "utf8"), /partial/)
})

test("loads a named skill and compacts earlier turns while keeping the newest request intact", async (t) => {
  const f = await fixture(t)
  const skillPath = path.join(f.workspace.root, "SKILL.md")
  await writeFile(skillPath, "---\nname: review\ndescription: Review changes\n---\nLook for missed cases.")
  const skill = await loadSkill(f.workspace, "SKILL.md")
  assert.equal(skill.name, "review")
  await f.session.append({ type: "skill/add", skill })
  for (let i = 0; i < 6; i += 1) {
    await f.session.append({ type: "user/message", content: "Must retain goal " + i + "\n" + "long narrative ".repeat(120) })
    await f.session.append({ type: "assistant/message", content: "assistant response ".repeat(50), toolCalls: [], model: "mock-model" })
  }
  const checkpoint = manualCompact(f.session.events)
  assert.equal(checkpoint.count, 5)
  const events = f.session.events.slice()
  const context = buildContext({
    workspace: f.workspace.root, mode: "ask", skills: [skill], tools: [], planApproved: false,
    events, contextWindow: 2100,
  })
  assert.ok(context.checkpoint.count > 0)
  assert.match(context.messages[0].content, /Look for missed cases/)
  assert.equal(context.messages.findLast((message) => message.role === "user").content, events.at(-2).data.content)
  assert.equal(f.session.events.length, 13)
  await f.session.append({ type: "context/compact", checkpoint })
  assert.equal(f.session.events.length, 14)
  await f.session.append({ type: "skill/remove", name: "review" })
  assert.deepEqual(f.session.skills, [])
})

test("PowerShell times out and stops on Ctrl+C signal", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t)
  const shell = availableTools("auto", false).find((tool) => tool.access === "shell")
  const timeout = await shell.prepare({ command: "Start-Sleep -Seconds 20", timeout_ms: 500 }, {
    workspace: f.workspace, apiKey, signal: new AbortController().signal,
  })
  assert.match(await timeout.execute(), /timed out after 500 ms/)
  const controller = new AbortController()
  const canceled = await shell.prepare({ command: "Start-Sleep -Seconds 20" }, {
    workspace: f.workspace, apiKey, signal: controller.signal,
  })
  const abort = setTimeout(() => controller.abort(), 500)
  try {
    await assert.rejects(canceled.execute(), { name: "AbortError" })
  } finally {
    clearTimeout(abort)
  }
})
