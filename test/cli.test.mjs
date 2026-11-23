// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { fetchModelIds } from "../dist/model.js"
import { checkConfigForKey } from "../dist/setup.js"
import { Credentials } from "../dist/credentials.js"
import { ProviderStore, newProvider } from "../dist/config.js"
import { renderBrand } from "../dist/brand.js"
import { suggest } from "../dist/commands.js"
import { composeFrame } from "../dist/composer.js"
import { updateFrame } from "../dist/terminal-frame.js"
import { approvalPreview, toolPreview, toolSummary } from "../dist/transcript.js"
import stringWidth from "string-width"

const run = promisify(execFile)
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url))

test("the CLI works from a different cwd, configures the endpoint and keeps secrets out of config", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "string code cli "))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const cwd = path.join(parent, "workspace with spaces")
  const home = path.join(parent, "local configuration")
  await mkdir(cwd)
  const options = { cwd, env: { ...process.env, STRINGCODE_HOME: home, STRINGCODE_API_KEY: "test-credential-only-for-env" } }
  const invoke = (...args) => run(process.execPath, [cli, ...args], options)
  assert.match((await invoke("--help")).stdout, /stringcode \[--resume/)
  assert.match((await invoke("--help")).stdout, /Original String Code CLI project by leavestring/)
  assert.equal((await invoke("--version")).stdout.trim(), "0.4.0")
  const license = (await invoke("--license")).stdout
  assert.match(license, /Original String Code CLI project by leavestring/)
  assert.match(license, /GNU GENERAL PUBLIC LICENSE/)
  await assert.rejects(invoke(), /Start stringcode in an interactive terminal/)
  await assert.rejects(invoke("config", "--base-url", "https://user:secret@example.invalid", "--model", "sample"), /without credentials/)
  assert.match((await invoke("config", "--base-url", "http://127.0.0.1:12345/v1/chat/completions", "--model", "sample", "--context-window", "6000")).stdout, /Saved configuration/)
  const config = await readFile(path.join(home, "config.json"), "utf8")
  const parsed = JSON.parse(config)
  assert.equal(parsed.version, 1)
  assert.deepEqual(parsed.providers[0], {
    id: parsed.activeId, name: "127.0.0.1", baseUrl: "http://127.0.0.1:12345/v1", model: "sample", contextWindow: 6000,
  })
  assert.doesNotMatch(config, /test-credential|apiKey/)
})

test("loads legacy provider settings and keeps distinct providers after switching", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "string code registry "))
  t.after(() => rm(home, { recursive: true, force: true }))
  await writeFile(path.join(home, "config.json"), JSON.stringify({ baseUrl: "https://first.example/v1", model: "old" }))
  const store = new ProviderStore(home)
  const legacy = await store.current()
  assert.equal(legacy.id, "legacy")
  const newer = newProvider({ baseUrl: "https://first.example/v1", model: "new" }, "Secondary account")
  await store.select(newer)
  assert.deepEqual(await store.list(), [legacy, newer])
  assert.deepEqual(await store.current(), newer)
  await store.select(legacy)
  assert.deepEqual(await store.current(), legacy)
})

test("remembers provider keys across processes without storing plaintext", { skip: process.platform !== "win32" }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "string code encrypted keys "))
  t.after(() => rm(home, { recursive: true, force: true }))
  const credentials = new Credentials(home)
  const provider = { id: "provider-one", baseUrl: "https://first.example/v1" }
  const secret = "fixture-credential-for-dpapi"
  assert.equal(await credentials.remember(provider, secret, true), true)
  const directory = path.join(home, "credentials")
  const [filename] = await readdir(directory)
  assert.match(filename, /\.dpapi$/)
  assert.equal((await readFile(path.join(directory, filename))).includes(Buffer.from(secret)), false)
  const later = new Credentials(home)
  assert.equal(await later.read(provider), secret)
  assert.equal(await later.read({ ...provider, baseUrl: "https://second.example/v1" }), undefined)
  assert.equal(await later.read({ ...provider, id: "provider-two" }), undefined)
  await later.forget(provider)
  assert.equal(await later.read(provider), undefined)
  assert.deepEqual(await readdir(directory), [])
})

test("does not treat a matching hostname as a leaked key", () => {
  assert.doesNotThrow(() => checkConfigForKey({
    baseUrl: "https://service.example.test/v1", model: "demo",
  }, "example.test"))
  assert.throws(() => checkConfigForKey({
    baseUrl: "https://service.example.test/key-example-123/v1", model: "demo",
  }, "key-example-123"), /API key is in the Base URL/)
  assert.throws(() => checkConfigForKey({
    baseUrl: "https://service.example.test/v1", model: "key-example-123",
  }, "key-example-123"), /API key is in the model ID/)
})

test("loads unique model IDs with the supplied key and handles unavailable catalogs", async (t) => {
  const server = createServer((req, res) => {
    const key = req.headers.authorization
    if (req.url !== "/v1/models" || req.method !== "GET") {
      res.writeHead(404).end()
    } else if (key === "Bearer bad-key") {
      res.writeHead(401).end()
    } else if (key === "Bearer no-catalog") {
      res.writeHead(405).end()
    } else if (key === "Bearer mock-catalog-key") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        data: [{ id: "zebra" }, { id: "alpha" }, { id: "alpha" }, { id: 17 }, null],
      }))
    } else {
      res.writeHead(403).end()
    }
  })
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const baseUrl = "http://127.0.0.1:" + server.address().port + "/v1"
  const signal = new AbortController().signal
  assert.deepEqual(await fetchModelIds(baseUrl, "mock-catalog-key", signal), { status: "ok", models: ["alpha", "zebra"] })
  assert.deepEqual(await fetchModelIds(baseUrl, "bad-key", signal), { status: "unauthorized" })
  assert.deepEqual(await fetchModelIds(baseUrl, "no-catalog", signal), { status: "unavailable" })
})

test("startup branding fits wide and narrow terminals and sanitizes external labels", () => {
  const details = ["Model demo", "D:\\弦码 工作区", "Session fixture   /help"]
  const wide = renderBrand(details, 80, true)
  assert.match(wide, /[█▀▄]/)
  assert.match(wide, /\x1b\[38;2;\d+;\d+;\d+;48;2;\d+;\d+;\d+m▀/)
  assert.match(wide, /;255;232;178m/)
  assert.equal(wide.split("\n").length, 8)
  const narrow = renderBrand(details, 32, false)
  assert.match(narrow, /▄▄▄▄/)
  assert.match(narrow, /\n\nString Code\n/)
  assert.doesNotMatch(narrow, /\x1b/)
  const piped = renderBrand(["bad \x1b[2K label"], undefined, false)
  assert.match(piped, /\\u001b/)
  assert.doesNotMatch(piped, /[█▀▄]|\x1b/)
})

test("a streaming update leaves the footer and unchanged composer rows untouched", () => {
  const lines = ["  ● A", "────────", "  › draft", "────────", "Ask mode"]
  const before = { lines, cursorRow: 2, cursorColumn: 8 }
  const after = { ...before, lines: ["  ● Answer", ...lines.slice(1)] }
  const update = updateFrame(before, after)
  assert.match(update, /nswer/)
  assert.doesNotMatch(update, /● A|\x1b\[K/)
  assert.doesNotMatch(update, /Ask mode|draft|──|\x1b\[J/)
  assert.equal(updateFrame(after, after), "")
  const inserted = updateFrame(after, { lines: ["Done", ...after.lines], cursorRow: 3, cursorColumn: 8 })
  assert.match(inserted, /Done/)
  assert.match(inserted, /\r\n/)
  assert.doesNotMatch(inserted, /\x1b\[J/)
})

test("file approvals present counts and a compact excerpt", () => {
  const changes = Array.from({ length: 67 }, (_, i) => "+line " + (i + 1)).join("\n")
  const preview = approvalPreview({ kind: "diff", title: "Modify example", detail: "--- sample\n+++ sample\n@@ -0,0 +1,67 @@\n" + changes })
  assert.equal(preview.folded, true)
  assert.match(preview.detail, /\+67 \/ −0 lines/)
  assert.doesNotMatch(preview.detail, /@@|line 67|\+\+\+/)
  assert.equal(preview.detail.split("\n").length, 5)
})

test("tool previews stay on one row and leave room for the execution result", () => {
  const command = "$file = '弦码 演示.txt'\r\n\tWrite-Output $file\nWrite-Output '" + "长命令".repeat(35) + "'"
  assert.equal(toolPreview("Get-Date\r\n\tWrite-Output $file"), "Get-Date Write-Output $file")
  const summary = toolSummary("Shell", command, "Exit: 0\nChecked the file", 45, false)
  assert.match(summary, /│  ✓ PowerShell .*Exit: 0/)
  assert.ok(stringWidth(summary) <= 45)
  assert.doesNotMatch(summary, /[\r\n\t\x1b]/)
  assert.match(toolSummary("Shell", command, "Exit: 1\nFile was not found", 80, false), /│  ! PowerShell .*Exit: 1/)
})

test("the composer shows live commands, a responsive footer and a wrapped input cursor", () => {
  const status = { model: "provider/model-with-a-long-identifier", mode: "plan", effort: "high", effortUnavailable: true }
  assert.deepEqual(suggest("/ef").map(({ text }) => text), ["/effort"])
  assert.deepEqual(suggest("/effort h").map(({ text }) => text), ["/effort high"])
  assert.deepEqual(suggest("/search ").map(({ text }) => text), ["/search key", "/search off", "/search on"])
  assert.deepEqual(suggest("What is /help?"), [])
  const frame = composeFrame({
    text: "/", cursor: 1, status, suggestions: suggest("/"), selected: suggest("/").findIndex(({ text }) => text === "/auto"), columns: 80, height: 18, color: false,
  })
  assert.equal(frame.cursorRow, 1)
  assert.equal(frame.cursorColumn, 5)
  assert.match(frame.lines.join("\n"), /Plan mode/)
  assert.match(frame.lines.join("\n"), /Effort high \(unsupported\)/)
  assert.match(frame.lines.join("\n"), /› \/auto/)
  assert.ok(frame.lines.every((line) => stringWidth(line) < 80))

  const text = "测试输入🙂".repeat(22)
  const narrow = composeFrame({
    text, cursor: text.length, status, suggestions: [], selected: 0, columns: 28, height: 9, color: false,
  })
  assert.ok(narrow.lines.every((line) => stringWidth(line) < 28))
  assert.ok(narrow.cursorRow < narrow.lines.length - 2)
  assert.equal(stringWidth(narrow.lines[narrow.cursorRow]), narrow.cursorColumn)
})
