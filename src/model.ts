// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import { randomUUID } from "node:crypto"
import type { Effort } from "./commands.js"
import { readJsonLines, readServerSentEvents } from "./sse.js"
import type { ModelConfig, ModelMessage, ToolCall, ToolDefinition, Usage } from "./types.js"
import { clip, redact } from "./util.js"

interface Completion {
  content: string
  reasoning: string
  toolCalls: ToolCall[]
  usage?: Usage
  finish: string
  toolsEnabled: boolean
}

interface Choice {
  delta?: Delta
  message?: Delta
  text?: unknown
  finish_reason?: string | null
}

interface Delta {
  content?: unknown
  refusal?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
  thinking?: unknown
  tool_calls?: Array<{
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>
}

interface Envelope {
  error?: { message?: unknown } | string
  choices?: Choice[]
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown }
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value.map((part: { text?: unknown } | null) => typeof part?.text === "string" ? part.text : "").join("")
  }
  return ""
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function errorDetail(value: unknown, apiKey: string): string {
  return clip(redact(textOf(value), apiKey).replace(/\s+/g, " ").trim(), 600)
}

function providerErrorText(text: string, apiKey: string): string {
  try {
    const value = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown } | null
    const details = typeof value?.error === "string" ? value.error : value?.error?.message
    return errorDetail(details ?? value?.message ?? text, apiKey)
  } catch {
    return errorDetail(text, apiKey)
  }
}

function parseEnvelope(input: string): Envelope {
  let data: unknown
  try {
    data = JSON.parse(input)
  } catch {
    throw new Error("The model response contained invalid JSON.")
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid model response.")
  return data as Envelope
}

async function consume(
  response: Response,
  apiKey: string,
  onText: (chunk: string) => void,
  onThinking: () => void,
  toolsEnabled: boolean,
): Promise<Completion> {
  const calls = new Map<number, ToolCall>()
  const result: Completion = { content: "", reasoning: "", toolCalls: [], finish: "", toolsEnabled }
  let thinking = false
  let responseSize = 0
  let done = false
  const ingest = (data: string) => {
    responseSize += data.length
    if (responseSize > 8 * 1024 * 1024) throw new Error("Model stream exceeded the response limit.")
    const envelope = parseEnvelope(data)
    if (envelope.error) {
      const detail = typeof envelope.error === "string" ? envelope.error : envelope.error.message
      throw new Error("Model stream error: " + (errorDetail(detail, apiKey) || "unknown error"))
    }
    if (envelope.usage) {
      const input = tokenCount(envelope.usage.prompt_tokens)
      const output = tokenCount(envelope.usage.completion_tokens)
      const total = tokenCount(envelope.usage.total_tokens) ??
        (input !== undefined && output !== undefined ? input + output : undefined)
      if (input !== undefined || output !== undefined || total !== undefined) result.usage = { input, output, total }
    }
    const choice = envelope.choices?.[0]
    if (!choice) return
    if (typeof choice.finish_reason === "string") result.finish = choice.finish_reason
    const delta = choice.delta ?? choice.message
    const reasoning = textOf(delta?.reasoning_content) || textOf(delta?.reasoning) || textOf(delta?.thinking)
    if (reasoning) {
      result.reasoning += reasoning
      if (!thinking) onThinking()
      thinking = true
    }
    const text = textOf(delta?.content) || textOf(delta?.refusal) || textOf(choice.text)
    if (text) {
      result.content += text
      onText(text)
    }
    if (!Array.isArray(delta?.tool_calls)) return
    for (const [position, call] of delta.tool_calls.entries()) {
      if (!call || typeof call !== "object") continue
      const index = Number.isSafeInteger(call.index) ? call.index! : position
      if (index < 0 || index >= 128) throw new Error("Invalid tool call index.")
      const current = calls.get(index) ?? { id: "", name: "", arguments: "" }
      if (typeof call.id === "string" && call.id) current.id = call.id
      if (typeof call.function?.name === "string" && call.function.name !== current.name) {
        current.name += call.function.name
      }
      if (typeof call.function?.arguments === "string") current.arguments += call.function.arguments
      calls.set(index, current)
    }
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (!response.body) throw new Error("The provider returned an empty response.")
  if (contentType.includes("application/json") && !contentType.includes("jsonl")) {
    ingest(await response.text())
    done = true
  } else if (contentType.includes("ndjson") || contentType.includes("jsonl")) {
    for await (const line of readJsonLines(response.body)) ingest(line)
  } else {
    for await (const { data, event } of readServerSentEvents(response.body)) {
      if (data.trim() === "[DONE]") {
        done = true
        break
      }
      if (event !== "ping" && data.trim()) ingest(data)
    }
  }

  if (!done && !result.finish) throw new Error("Model stream ended before completion. No pending tools were executed.")
  const ids = new Set<string>()
  for (const [, call] of [...calls].sort(([left], [right]) => left - right)) {
    if (!call.name) throw new Error("The model returned an incomplete tool call.")
    if (!call.id || ids.has(call.id)) call.id = "call-" + randomUUID()
    ids.add(call.id)
    result.toolCalls.push({ ...call, arguments: call.arguments || "{}" })
  }
  if (!result.content && result.toolCalls.length === 0 && result.finish !== "length") {
    throw new Error("The model returned neither a response nor a tool call.")
  }
  return result
}

type Catalog =
  | { status: "ok"; models: string[] }
  | { status: "unauthorized" | "unavailable" }

export async function fetchModelIds(baseUrl: string, apiKey: string, signal: AbortSignal): Promise<Catalog> {
  try {
    const response = await fetch(baseUrl + "/models", {
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" },
    })
    if (!response.ok) {
      await response.body?.cancel()
      return { status: response.status === 401 ? "unauthorized" : "unavailable" }
    }
    const payload = await response.json() as { data?: Array<{ id?: unknown } | null> } | null
    if (!Array.isArray(payload?.data)) return { status: "unavailable" }
    const ids = new Set<string>()
    for (const model of payload.data) {
      if (typeof model?.id !== "string") continue
      const id = model.id.trim()
      if (id && id.length <= 256 && !/[\r\n]/.test(id)) ids.add(id)
    }
    return { status: "ok", models: [...ids].sort((left, right) => left.localeCompare(right)) }
  } catch {
    signal.throwIfAborted()
    return { status: "unavailable" }
  }
}

export async function complete(options: {
  config: ModelConfig
  apiKey: string
  messages: ModelMessage[]
  tools: ToolDefinition[]
  outputLimit: number
  effort?: Effort
  onEffortUnavailable?: () => void
  signal: AbortSignal
  onText: (chunk: string) => void
  onThinking: () => void
  onNotice: (notice: string) => void
}): Promise<Completion> {
  const { config, apiKey, signal, messages, tools } = options
  const host = new URL(config.baseUrl).hostname
  let effort = options.effort ?? "auto"
  let outputField = host === "api.openai.com" ? "max_completion_tokens" : "max_tokens"
  let outputLimit: number | undefined = options.outputLimit
  let triedAlternate = false
  let includeUsage = true
  let includeTools = tools.length > 0
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const timeout = AbortSignal.timeout(180_000)
    const requestSignal = AbortSignal.any([signal, timeout])
    const body = {
      model: config.model,
      messages,
      stream: true,
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      ...(outputLimit ? { [outputField]: outputLimit } : {}),
      ...(effort === "auto" ? {} : host === "openrouter.ai"
        ? { reasoning: { effort } } : { reasoning_effort: effort }),
      ...(includeTools ? { tools, tool_choice: "auto" } : {}),
    }
    try {
      const response = await fetch(config.baseUrl + "/chat/completions", {
        method: "POST",
        redirect: "error",
        signal: requestSignal,
        headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
      })
      if (response.ok) {
        return await consume(response, apiKey, options.onText, options.onThinking, includeTools).finally(async () => {
          await response.body?.cancel().catch(() => {})
        })
      }
      const detail = providerErrorText(await response.text(), apiKey)
      if (response.status === 400 || response.status === 422) {
        const unsupported = /not support|unsupported|unknown|unrecognized|unexpected|not allowed|extra (?:field|input)|only supports|not permitted/i.test(detail)
        if (effort !== "auto" && /\breasoning(?:_effort)?\b/i.test(detail) &&
            (unsupported || /invalid|must be|only allows/i.test(detail))) {
          effort = "auto"
          options.onEffortUnavailable?.()
          options.onNotice("The provider rejected the requested effort. Retrying with its default.")
          continue
        }
        if (unsupported && includeUsage && /stream.options|include_usage/i.test(detail)) {
          includeUsage = false
          continue
        }
        if (unsupported && outputLimit && detail.includes(outputField)) {
          if (triedAlternate) outputLimit = undefined
          outputField = outputField === "max_tokens" ? "max_completion_tokens" : "max_tokens"
          triedAlternate = true
          continue
        }
        if (unsupported && includeTools && /\btools?\b|tool_choice|function call/i.test(detail)) {
          includeTools = false
          options.onNotice("Provider rejected tool calling. Continuing with a text response.")
          continue
        }
      }
      throw new Error("Provider HTTP " + response.status + (detail ? ": " + detail : "."))
    } catch (error) {
      signal.throwIfAborted()
      if (timeout.aborted) throw new Error("Model request timed out.")
      if (error instanceof TypeError && error.message === "fetch failed") {
        throw new Error("Failed to connect to the provider. Check the base URL, network, and redirects.")
      }
      throw error
    }
  }
  throw new Error("The provider rejected compatible request options.")
}
