// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import { createHash, randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, readdir, stat, truncate } from "node:fs/promises"
import path from "node:path"
import lockfile from "proper-lockfile"
import type { ContextCheckpoint } from "./context.js"
import type { Effort } from "./commands.js"
import type { ModelMessage, Skill, ToolCall, Usage } from "./types.js"
import { isMissing } from "./util.js"

export type EventData =
  | { type: "user/message"; content: string }
  | { type: "assistant/message"; content: string; reasoning?: string; toolCalls: ToolCall[]; usage?: Usage; model: string; truncated?: true }
  | { type: "tool/result"; callId: string; content: string }
  | { type: "turn/end"; reason: "complete" | "canceled" | "error" | "limit" }
  | { type: "context/compact"; checkpoint: ContextCheckpoint }
  | { type: "skill/add"; skill: Skill }
  | { type: "skill/remove"; name: string }
  | { type: "model/select"; model: string }
  | { type: "provider/select"; providerId: string; model?: string }
  | { type: "effort/select"; effort: Effort }

export interface SessionEvent {
  seq: number
  at: string
  data: EventData
}

const sessionId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

async function readLog(file: string): Promise<{ events: SessionEvent[]; tornAt?: number }> {
  const raw = await readFile(file, "utf8").catch((error: unknown) => {
    if (isMissing(error)) return ""
    throw error
  })
  const end = raw.lastIndexOf("\n") + 1
  // Append always writes a newline. A final fragment can be left by a terminated process.
  const events = raw.slice(0, end).split("\n").filter(Boolean).map((line) => {
    const entry = JSON.parse(line) as SessionEvent
    if (!Number.isSafeInteger(entry?.seq) || typeof entry?.data?.type !== "string") {
      throw new Error("Invalid session event.")
    }
    return entry
  })
  return { events, tornAt: end < raw.length ? Buffer.byteLength(raw.slice(0, end)) : undefined }
}

export class Session {
  constructor(
    readonly id: string,
    readonly events: SessionEvent[],
    private readonly file: string,
    private readonly unlock: () => Promise<void>,
    private readonly checkLock: () => void,
  ) {}

  async append(data: EventData): Promise<void> {
    this.checkLock()
    const entry = { seq: (this.events.at(-1)?.seq ?? 0) + 1, at: new Date().toISOString(), data }
    await appendFile(this.file, JSON.stringify(entry) + "\n", { mode: 0o600 })
    this.events.push(entry)
  }

  async close(): Promise<void> {
    await this.unlock()
  }

  get skills(): Skill[] {
    const skills = new Map<string, Skill>()
    for (const { data } of this.events) {
      if (data.type === "skill/add") skills.set(data.skill.name, data.skill)
      if (data.type === "skill/remove") skills.delete(data.name)
    }
    return [...skills.values()]
  }

  get providerId(): string | undefined {
    const event = this.events.findLast(({ data }) => data.type === "provider/select")?.data
    return event?.type === "provider/select" ? event.providerId : undefined
  }

  get model(): string | undefined {
    const event = this.events.findLast(({ data }) => data.type === "model/select" || data.type === "provider/select")?.data
    return event?.type === "model/select" || event?.type === "provider/select" ? event.model : undefined
  }

  get effort(): Effort {
    const event = this.events.findLast(({ data }) => data.type === "effort/select")?.data
    return event?.type === "effort/select" ? event.effort : "auto"
  }
}

export class Sessions {
  private readonly directory: string

  constructor(dataDir: string, workspace: string) {
    const identity = process.platform === "win32" ? workspace.toLowerCase() : workspace
    const key = createHash("sha256").update(identity).digest("hex")
    this.directory = path.join(dataDir, "sessions", key)
  }

  async open(id?: string): Promise<Session> {
    const selected = id ?? randomUUID()
    if (!sessionId.test(selected)) throw new Error("Invalid session ID.")
    const file = path.join(this.directory, selected + ".jsonl")
    if (id) {
      try {
        if (!(await stat(file)).isFile()) throw new Error("Invalid session file.")
      } catch (error) {
        if (isMissing(error)) throw new Error("Session not found for this workspace.")
        throw error
      }
    } else {
      await mkdir(this.directory, { recursive: true })
    }

    let compromised: Error | undefined
    const unlock = await lockfile.lock(file, {
      realpath: false,
      stale: 30_000,
      onCompromised: (error) => { compromised = error },
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ELOCKED") throw new Error("That session is already open in another process.")
      throw error
    })
    const checkLock = () => {
      if (compromised) throw new Error("Session lock was lost. Reopen the CLI before continuing.")
    }

    try {
      const { events, tornAt } = await readLog(file)
      if (tornAt !== undefined) {
        checkLock()
        await truncate(file, tornAt)
      }
      return new Session(selected, events, file, unlock, checkLock)
    } catch (error) {
      await unlock().catch(() => {})
      throw error
    }
  }

  async list(): Promise<Array<{ id: string; title: string; updated: string }>> {
    const files = await readdir(this.directory).catch((error: unknown) => {
      if (isMissing(error)) return []
      throw error
    })
    const records = []
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue
      const id = file.slice(0, -6)
      if (!sessionId.test(id)) continue
      try {
        const { events } = await readLog(path.join(this.directory, file))
        if (events.length === 0) continue
        const firstMessage = events.find(({ data }) => data.type === "user/message")?.data
        const first = firstMessage?.type === "user/message" ? firstMessage.content : undefined
        records.push({ id, title: first?.split(/\r?\n/, 1)[0].slice(0, 80) || "(untitled)", updated: events.at(-1)!.at })
      } catch {
        records.push({ id, title: "(cannot read session log)", updated: "" })
      }
    }
    return records.sort((left, right) => right.updated.localeCompare(left.updated))
  }
}

interface ToolActivity {
  call: ToolCall
  result?: string
}

export function lastTurnTools(events: SessionEvent[]): ToolActivity[] {
  const start = events.findLastIndex(({ data }) => data.type === "user/message")
  const tools: ToolActivity[] = []
  if (start < 0) return tools

  const batch = new Map<string, ToolActivity>()
  for (const { data } of events.slice(start + 1)) {
    if (data.type === "assistant/message") {
      batch.clear()
      for (const call of data.toolCalls) {
        const entry = { call }
        batch.set(call.id, entry)
        tools.push(entry)
      }
    } else if (data.type === "tool/result") {
      const entry = batch.get(data.callId)
      if (entry) entry.result = data.content
    } else if (data.type === "turn/end") {
      break
    }
  }
  return tools
}

export function deriveModelMessages(events: SessionEvent[], reasoningModel?: string): ModelMessage[] {
  const messages: ModelMessage[] = []
  let pending: ToolCall[] = []
  const results = new Map<string, string>()

  const finishBatch = () => {
    for (const call of pending) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: results.get(call.id) ?? "Tool interrupted. Result is unconfirmed. Inspect current state before retrying.",
      })
    }
    pending = []
    results.clear()
  }

  for (const { data } of events) {
    if (data.type === "user/message") {
      finishBatch()
      messages.push({ role: "user", content: data.content })
    } else if (data.type === "assistant/message") {
      finishBatch()
      if (data.truncated) continue
      pending = data.toolCalls
      if (!pending.length && !data.content?.trim()) continue
      messages.push({
        role: "assistant",
        content: data.content || null,
        ...(reasoningModel === data.model && pending.length && data.reasoning
          ? { reasoning_content: data.reasoning } : {}),
        ...(pending.length ? {
          tool_calls: pending.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        } : {}),
      })
    } else if (data.type === "tool/result" && pending.some((call) => call.id === data.callId)) {
      results.set(data.callId, data.content)
    } else if (data.type === "turn/end") {
      finishBatch()
    }
  }
  finishBatch()
  return messages
}
