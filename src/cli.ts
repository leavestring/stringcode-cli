#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import { access, mkdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { latestUsage, runTurn, sessionContext } from "./agent.js"
import { efforts, helpText, type Effort } from "./commands.js"
import { dataDirectory, newProvider, ProviderStore, type Provider } from "./config.js"
import { manualCompact, skillBudget } from "./context.js"
import { Credentials, type CredentialOwner } from "./credentials.js"
import { fetchModelIds } from "./model.js"
import { Sessions, type Session } from "./sessions.js"
import { canRunSetup, checkConfigForKey, pickModel, promptKey, promptProvider } from "./setup.js"
import { loadSkill } from "./skills.js"
import { cycleMode, Terminal } from "./terminal.js"
import type { Mode } from "./types.js"
import { clip, isMissing, messageOf, redact, terminalText, writeAtomic } from "./util.js"
import { createWebSearch, searchCredential } from "./web-search.js"
import { Workspace } from "./workspace.js"

const usage = [
  "Usage:",
  "  stringcode [--resume <id>]",
  "  stringcode config",
  "  stringcode config --base-url <url> --model <id> [--context-window <tokens>]",
  "  stringcode --help | --version | --license",
  "",
  "First run: enter the Base URL and API key, then pick a model.",
  "Use /provider to manage providers, /model to pick a model, and Shift+Tab to cycle modes.",
  "",
  "Original String Code CLI project by leavestring. Copyright (C) 2026 leavestring.",
  "https://github.com/leavestring/stringcode-cli",
  "GPLv3. This software comes with no warranty. You may redistribute it under the license.",
  "Run stringcode --license to read the license and author notices.",
].join("\n")

async function interact<T>(terminal: Terminal, action: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const signal = terminal.startOperation()
  try {
    return await terminal.modal(() => action(signal))
  } catch (error) {
    if (!signal.aborted) throw error
  } finally {
    terminal.finishOperation()
  }
}

async function remember(
  terminal: Terminal, credentials: Credentials, profile: CredentialOwner, key: string, entered: boolean,
): Promise<void> {
  try {
    if (await credentials.remember(profile, key, entered)) {
      terminal.notice("Saved the API key with Windows encryption.")
    } else if (entered) {
      terminal.notice("The API key is available for this run.")
    }
  } catch {
    terminal.notice("Windows could not save the key. The key is available for this run.")
  }
}

async function verifiedKey(terminal: Terminal, provider: Provider, signal: AbortSignal): Promise<string | undefined> {
  while (!signal.aborted) {
    const key = await promptKey(terminal, provider.baseUrl, signal)
    if (!key) return
    const catalog = await fetchModelIds(provider.baseUrl, key, signal)
    if (catalog.status !== "unauthorized") return key
    terminal.notice("The provider rejected the API key. Enter another key, or press Ctrl+C to cancel.")
  }
}

async function accessProvider(terminal: Terminal, credentials: Credentials, provider: Provider) {
  try {
    const key = await credentials.read(provider)
    if (key) return key
  } catch {
    terminal.notice("The saved key could not be read. Enter it again to replace it.")
  }
  if (!canRunSetup()) throw new Error("Set STRINGCODE_API_KEY or open an interactive terminal to enter it.")
  terminal.notice("API key for " + provider.name)
  return interact(terminal, async (signal) => {
    const key = await verifiedKey(terminal, provider, signal)
    if (key) await remember(terminal, credentials, provider, key, true)
    return key
  })
}

async function skillsCommand(terminal: Terminal, session: Session, workspace: Workspace, args: string, apiKey: string) {
  if (!args) {
    terminal.notice(session.skills.map((skill) => "  " + skill.name + "  " + skill.path + "  " + skill.description).join("\n") || "No skills mounted.")
    return
  }
  const match = /^(add|remove)\s+(.+)$/s.exec(args)
  if (!match) throw new Error("Use /skills add <path> or /skills remove <name>.")
  const nameOrPath = match[2].trim().replace(/^(["'])(.*)\1$/, "$2")
  if (match[1] === "remove") {
    if (!session.skills.some((skill) => skill.name === nameOrPath)) throw new Error("Skill is not mounted.")
    await session.append({ type: "skill/remove", name: nameOrPath })
    terminal.notice("Removed " + nameOrPath + ".")
    return
  }
  const skill = await loadSkill(workspace, nameOrPath)
  if (Object.values(skill).some((value) => value.includes(apiKey))) throw new Error("Skill contains the active API key.")
  const skills = [...session.skills.filter((entry) => entry.name !== skill.name), skill]
  if (JSON.stringify(skills).length > skillBudget) throw new Error("Mounted skills exceed the context allowance.")
  await session.append({ type: "skill/add", skill })
  terminal.notice("Mounted " + skill.name + ".")
}

async function chat(
  initial: Provider, store: ProviderStore, credentials: Credentials, terminal: Terminal,
  dataDir: string, resume: string | undefined, showBrand: boolean,
) {
  await mkdir(dataDir, { recursive: true })
  const workspace = await Workspace.open(process.cwd(), dataDir)
  const sessions = new Sessions(dataDir, workspace.root)
  let session = await sessions.open(resume)
  let mode: Mode = "ask"
  let provider = initial
  let apiKey = ""
  const envSearchKey = process.env.ANYSEARCH_API_KEY?.trim()
  let searchKey = envSearchKey || undefined
  let searchEnabled = true
  const searchDisabledFile = path.join(dataDir, "web-search.disabled")
  const unavailableEfforts = new Set<string>()
  const protect = (text: string) => redact(redact(text, searchKey ?? ""), apiKey)

  const active = () => {
    const model = session.model ?? provider.model
    const config = model === provider.model ? provider : { baseUrl: provider.baseUrl, model }
    const effortKey = JSON.stringify([provider.id, model, session.effort])
    const effortUnavailable = unavailableEfforts.has(effortKey)
    return {
      config, apiKey, mode, session, workspace, effortUnavailable,
      webSearch: searchEnabled ? createWebSearch(searchKey) : undefined,
      effort: effortUnavailable ? "auto" as const : session.effort,
      onEffortUnavailable() {
        unavailableEfforts.add(effortKey)
        terminal.effortFallback()
      },
    }
  }

  const providerFor = async (target: Session, fallback: Provider): Promise<Provider> => {
    if (!target.providerId || target.providerId === fallback.id) return fallback
    const profile = (await store.list()).find(({ id }) => id === target.providerId)
    if (!profile) throw new Error("This session's provider is missing from the configuration.")
    return profile
  }

  const openSession = async (id?: string) => {
    if (id === session.id) return
    const next = await sessions.open(id)
    let swapped = false
    try {
      const profile = await providerFor(next, provider)
      const key = profile.id === provider.id ? apiKey : await accessProvider(terminal, credentials, profile)
      if (!key) return
      await session.close()
      session = next
      provider = profile
      apiKey = key
      mode = "ask"
      swapped = true
      terminal.notice((id ? "Resumed " : "New session ") + session.id + " · " + active().config.model + " · ask")
      if (id) {
        const history = session.events.flatMap(({ data }) =>
          data.type === "user/message" ? ["You: " + clip(data.content, 600)] :
            data.type === "assistant/message" && data.content ? ["String Code: " + clip(data.content, 600)] : [])
        for (const entry of history.slice(-4)) terminal.notice(redact(entry, apiKey))
      }
    } finally {
      if (!swapped) await next.close()
    }
  }

  const switchMode = (next: Mode) => {
    mode = next
    terminal.setMode(next)
  }

  const bindSession = async () => {
    if (!session.providerId) await session.append({ type: "provider/select", providerId: provider.id, model: session.model })
  }

  const changeModel = async (args: string) => {
    const current = active().config.model
    const model = args || await interact(terminal, async (signal) => {
      terminal.notice("Fetching models from " + provider.name + "…")
      const catalog = await fetchModelIds(provider.baseUrl, apiKey, signal)
      if (catalog.status === "unauthorized") {
        terminal.notice("The provider rejected its saved key. Use /provider key to replace it.")
        return
      }
      if (catalog.status !== "ok") terminal.notice("Live model list unavailable. The current model and manual entry are available.")
      return pickModel(terminal, provider.name, catalog.status === "ok" ? catalog.models : [], { baseUrl: provider.baseUrl, apiKey }, current, signal)
    })
    if (!model) return
    if (model.length > 256 || /[\r\n]/.test(model)) throw new Error("Enter a model ID of 1–256 characters.")
    checkConfigForKey({ model }, apiKey)
    await bindSession()
    await session.append({ type: "model/select", model })
    terminal.notice("Model: " + model + " (" + provider.name + ")")
  }

  const manageProviders = async (args: string) => {
    if (args === "key") {
      await interact(terminal, async (signal) => {
        const key = await verifiedKey(terminal, provider, signal)
        if (!key) return
        await remember(terminal, credentials, provider, key, true)
        apiKey = key
      })
      return
    }
    if (args && args !== "add") throw new Error("Use /provider, /provider add, or /provider key.")
    const selected = await interact(terminal, async (signal) => {
      if (args === "add") return promptProvider(terminal, signal, { label: true })
      const profiles = await store.list()
      const profileId = await terminal.pick("Model providers", [
        ...profiles.map((item) => ({
          id: item.id, label: item.name, detail: item.baseUrl + (item.id === provider.id ? "  ·  current" : ""),
        })),
        { id: "add", label: "Add a provider…" },
      ], provider.id, signal)
      if (profileId === "add") return promptProvider(terminal, signal, { label: true })
      if (!profileId || profileId === provider.id) return
      const profile = profiles.find(({ id }) => id === profileId)
      if (!profile) return
      let key: string | undefined
      try {
        key = await credentials.read(profile)
      } catch {
        terminal.notice("The saved key could not be read.")
      }
      if (key) return { profile, apiKey: key, entered: false }
      terminal.notice("API key for " + profile.name)
      key = await verifiedKey(terminal, profile, signal)
      if (key) return { profile, apiKey: key, entered: true }
    })
    if (!selected) return
    await store.select(selected.profile)
    await remember(terminal, credentials, selected.profile, selected.apiKey, selected.entered)
    await session.append({ type: "provider/select", providerId: selected.profile.id })
    provider = selected.profile
    apiKey = selected.apiKey
    terminal.notice("Provider: " + provider.name + "  ·  Model: " + provider.model)
  }

  const searchStatus = () => searchEnabled
    ? "Web search is on (AnySearch, " + (searchKey ? "API key" : "anonymous") + ")."
    : "Web search is off. Use /search on to enable it."

  const setSearchEnabled = async (enabled: boolean) => {
    if (enabled) await rm(searchDisabledFile, { force: true })
    else await writeAtomic(searchDisabledFile, "disabled\n")
    searchEnabled = enabled
  }

  const command = async (line: string): Promise<boolean> => {
    const [name = ""] = line.split(/\s+/, 1)
    const args = line.slice(name.length).trim()
    if (line.includes(apiKey) || (searchKey && line.includes(searchKey))) throw new Error("Command contains an API key.")
    switch (name) {
      case "/help":
        terminal.notice(helpText())
        break
      case "/new":
        await openSession()
        break
      case "/resume":
        if (!args) throw new Error("Use /resume <id>. List session IDs with /sessions.")
        await openSession(args)
        break
      case "/sessions": {
        const items = await sessions.list()
        terminal.notice(items.map((item) => "  " + item.id + "  " + redact(item.title, apiKey)).join("\n") || "No saved sessions.")
        break
      }
      case "/model":
        await changeModel(args)
        break
      case "/provider":
        await manageProviders(args)
        break
      case "/search": {
        if (!args) {
          terminal.notice(searchStatus())
        } else if (args === "on") {
          await setSearchEnabled(true)
          terminal.notice(searchStatus())
        } else if (args === "key") {
          if (!envSearchKey && !canRunSetup()) throw new Error("Open an interactive terminal or set ANYSEARCH_API_KEY.")
          const key = envSearchKey || await interact(terminal, async (signal) => {
            terminal.notice("AnySearch API key. Anonymous search is available without a key.")
            return promptKey(terminal, searchCredential.baseUrl, signal)
          })
          if (!key) break
          if (!envSearchKey) await remember(terminal, credentials, searchCredential, key, true)
          searchKey = key
          await setSearchEnabled(true)
          terminal.notice(searchStatus())
        } else if (args === "off") {
          await setSearchEnabled(false)
          await credentials.forget(searchCredential)
          searchKey = envSearchKey || undefined
          terminal.notice(searchStatus())
        } else {
          throw new Error("Use /search, /search on, /search key, or /search off.")
        }
        break
      }
      case "/effort": {
        const effort = args.toLowerCase() as Effort
        if (!args) {
          const current = session.effort === "auto" ? "default" : session.effort
          terminal.notice("Current effort: " + current + ". Use /effort auto|low|medium|high.")
          break
        }
        if (!efforts.includes(effort)) throw new Error("Use /effort auto|low|medium|high.")
        await session.append({ type: "effort/select", effort })
        unavailableEfforts.delete(JSON.stringify([provider.id, active().config.model, effort]))
        terminal.notice(effort === "auto" ? "Using the provider's default effort." : "Requested effort: " + effort + ".")
        break
      }
      case "/ask":
      case "/plan":
      case "/auto":
        switchMode(name.slice(1) as Mode)
        break
      case "/compact": {
        const checkpoint = manualCompact(session.events)
        if (checkpoint) {
          await session.append({ type: "context/compact", checkpoint })
          terminal.notice("Compacted earlier turns. Full history remains in the session log.")
        } else {
          terminal.notice("No older turns would benefit from compaction.")
        }
        break
      }
      case "/tools": {
        const start = session.events.findLastIndex(({ data }) => data.type === "user/message")
        const latest = start < 0 ? [] : session.events.slice(start)
        const calls = latest.flatMap(({ data }) => data.type === "assistant/message" ? data.toolCalls : [])
        if (!calls.length) {
          terminal.notice("The last turn has no tool activity.")
          break
        }
        const chosen = await interact(terminal, (signal) => terminal.pick("Last turn / tools",
          calls.map((call, index) => ({
            id: String(index), label: String(index + 1) + ". " + call.name,
            detail: call.name === "WebSearch" ? protect(call.arguments).replace(/\s+/gu, " ") : undefined,
          })),
          undefined, signal))
        if (chosen !== undefined) {
          const call = calls[Number(chosen)]
          const result = latest.findLast(({ data }) => data.type === "tool/result" && data.callId === call.id)?.data
          const input = ["Shell", "WebSearch"].includes(call.name) ? "\nArguments: " + clip(protect(call.arguments), 3_500) : ""
          terminal.notice(call.name + input + "\n" + (result?.type === "tool/result"
            ? clip(protect(result.content), 12_000) : "No result was recorded."))
        }
        break
      }
      case "/tokens": {
        const { snapshot } = sessionContext(active())
        terminal.notice("Estimated input " + snapshot.inputTokens + " / " + snapshot.inputLimit +
          " tokens · context window " + snapshot.window + (snapshot.assumedWindow ? " (assumed)" : "") +
          " · " + snapshot.compactedTurns + " compacted turns")
        const recent = latestUsage(session)
        if (recent) {
          const { input, output, total } = recent.usage
          terminal.notice("Latest provider usage (" + recent.model + "): input " + (input ?? "—") +
            ", output " + (output ?? "—") + ", total " + (total ?? "—"))
        } else {
          terminal.notice("The provider has not reported token usage for the latest turn.")
        }
        break
      }
      case "/skills":
        await skillsCommand(terminal, session, workspace, args, apiKey)
        break
      case "/exit":
        return false
      default:
        terminal.notice("Unknown command. Enter /help to list commands.")
    }
    return true
  }

  try {
    provider = await providerFor(session, initial)
    apiKey = await accessProvider(terminal, credentials, provider) ?? ""
    if (!apiKey) return
    searchEnabled = await access(searchDisabledFile).then(() => false, (error: unknown) => {
      if (isMissing(error)) return true
      throw error
    })
    if (!searchKey) {
      try {
        searchKey = await credentials.read(searchCredential)
      } catch {
        terminal.notice("The saved search key could not be read. Use /search key to replace it.")
      }
    }
    terminal.banner(workspace.root, active().config.model, session.id, showBrand)
    if (resume) {
      const last = session.events.findLast(({ data }) => data.type === "assistant/message" && data.content)
      if (last?.data.type === "assistant/message") terminal.notice("String Code: " + redact(clip(last.data.content, 600), apiKey))
    }
    while (true) {
      const current = active()
      const input = await terminal.compose({
        model: current.config.model, mode, effort: session.effort, effortUnavailable: current.effortUnavailable,
      })
      if (input === undefined) break
      try {
        if (input === cycleMode) {
          switchMode(({ ask: "plan", plan: "auto", auto: "ask" } satisfies Record<Mode, Mode>)[mode])
          continue
        }
        const line = input.trim()
        if (!line) continue
        terminal.echoInput(protect(line))
        if (line.startsWith("/")) {
          if (!await command(line)) break
          continue
        }
        await bindSession()
        const signal = terminal.startTurn(current.effort)
        let result: "complete" | "canceled" | "limit" | "error" = "error"
        let failure: string | undefined
        try {
          result = await runTurn(current, protect(line), signal, terminal)
        } catch (error) {
          failure = protect(messageOf(error))
        } finally {
          terminal.finishTurn(result, failure)
        }
      } catch (error) {
        terminal.notice("Error: " + protect(messageOf(error)))
      }
    }
  } finally {
    await session.close()
  }
}

async function main(args: string[]) {
  if (args.includes("--help")) {
    console.log(usage)
    return
  }
  if (args.length === 1 && args[0] === "--license") {
    for (const file of ["NOTICE", "LICENSE"]) {
      const content = await readFile(new URL("../" + file, import.meta.url), "utf8")
      console.log(content.trimEnd() + "\n")
    }
    return
  }
  if (args.length === 1 && args[0] === "--version") {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
    console.log(pkg.version)
    return
  }

  const dataDir = dataDirectory()
  const store = new ProviderStore(dataDir)
  const saved = await store.current()
  const credentials = new Credentials(dataDir)
  const envKey = process.env.STRINGCODE_API_KEY?.trim()

  if (args[0] === "config" && args.length > 1) {
    const { values } = parseArgs({
      args: args.slice(1),
      options: { "base-url": { type: "string" }, model: { type: "string" }, "context-window": { type: "string" } },
    })
    const window = values["context-window"]
    checkConfigForKey({ baseUrl: values["base-url"], model: values.model }, envKey)
    const profile = newProvider({
      baseUrl: values["base-url"], model: values.model, contextWindow: window === undefined ? undefined : Number(window),
    })
    const same = saved?.baseUrl === profile.baseUrl ? saved : (await store.list()).find(({ baseUrl }) => baseUrl === profile.baseUrl)
    await store.select(same ? { ...profile, id: same.id, name: same.name } : profile)
    console.log("Saved configuration for " + terminalText(profile.model) + ".")
    return
  }
  const configuring = args[0] === "config"
  const { values } = parseArgs({ args: configuring ? [] : args, options: { resume: { type: "string" } } })
  if ((!saved || configuring) && !canRunSetup()) {
    throw new Error("Start stringcode in an interactive terminal or run stringcode config --base-url <url> --model <id>.")
  }

  const terminal = new Terminal()
  try {
    let profile = saved
    if (!profile || configuring) {
      terminal.setupBanner()
      const setup = await interact(terminal, (signal) => promptProvider(terminal, signal, {
        apiKey: saved ? undefined : envKey, label: Boolean(saved),
      }))
      if (!setup) return
      profile = setup.profile
      await store.select(profile)
      await remember(terminal, credentials, profile, setup.apiKey, setup.entered)
      if (configuring) {
        terminal.notice("Saved " + profile.name + ". Run stringcode to start.")
        return
      }
    }
    credentials.useEnvironmentFor(profile)
    await chat(profile, store, credentials, terminal, dataDir, values.resume, Boolean(saved))
  } finally {
    terminal.close()
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error("stringcode: " + terminalText(redact(messageOf(error), process.env.STRINGCODE_API_KEY?.trim() ?? "")))
  process.exitCode = 1
})
