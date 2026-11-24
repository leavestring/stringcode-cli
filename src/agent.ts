// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import { randomUUID } from "node:crypto"
import { buildContext } from "./context.js"
import type { Effort } from "./commands.js"
import { complete, type ModelCompatibility } from "./model.js"
import type { Session } from "./sessions.js"
import { availableTools } from "./tools.js"
import type { Approval, Mode, ModelConfig, Snapshot, ToolCall, Usage } from "./types.js"
import { messageOf, redact } from "./util.js"
import { webSearchStatus, type WebSearch } from "./web-search.js"
import type { Workspace } from "./workspace.js"

export interface AgentUI {
  text(chunk: string): void
  thinking(): void
  request?(finalizing?: boolean): void
  usage?(usage: Usage): void
  notice(notice: string): void
  tool(name: string, state: "start" | "result", detail: string): void
  context(snapshot: Snapshot): void
  approve(prompt: Approval, signal: AbortSignal): Promise<boolean>
}

export interface AgentOptions {
  session: Session
  workspace: Workspace
  config: ModelConfig
  apiKey: string
  mode: Mode
  effort?: Effort
  webSearch?: WebSearch
  compatibility?: ModelCompatibility
  onEffortUnavailable?: () => void
}

const stepLimit = 24
const finalInstruction = "The tool step limit has been reached. Give the user a concise final status based on the recorded tool results. " +
  "State what completed, what failed or remains unverified, and what is still needed. No further tools are available."

export function sessionContext(options: Omit<AgentOptions, "apiKey">, approved = false, finalizing = false) {
  const { config, mode, session, workspace, webSearch } = options
  const tools = finalizing ? [] : availableTools(mode, approved, Boolean(webSearch)).map((tool) => tool.definition)
  return buildContext({
    events: session.events, workspace: workspace.root, mode, planApproved: approved,
    skills: session.skills, tools, contextWindow: config.contextWindow,
    reasoningModel: new URL(config.baseUrl).hostname === "api.deepseek.com" ? config.model : undefined,
    searchStatus: webSearchStatus(webSearch),
    finalInstruction: finalizing ? finalInstruction : undefined,
  })
}

function streamingText(secret: string, emit: (text: string) => void) {
  let carry = ""
  return {
    push(chunk: string) {
      let text = redact(carry + chunk, secret)
      let held = Math.min(secret.length - 1, text.length)
      while (held > 0 && !text.endsWith(secret.slice(0, held))) held -= 1
      carry = held > 0 ? text.slice(-held) : ""
      if (held > 0) text = text.slice(0, -held)
      if (text) emit(text)
    },
    finish() {
      if (carry) emit(carry)
    },
  }
}

function parseCall(call: ToolCall, apiKey: string): { args?: Record<string, unknown>; error?: string } {
  try {
    const value: unknown = JSON.parse(call.arguments)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    const rawKey = JSON.stringify(apiKey).slice(1, -1)
    if (apiKey && (call.arguments.includes(apiKey) || JSON.stringify(value).includes(rawKey))) {
      return { error: "The tool arguments contain the active API key." }
    }
    return { args: value as Record<string, unknown> }
  } catch {
    return { error: "Tool arguments must be a valid JSON object." }
  }
}

function toolTarget(args: Record<string, unknown> | undefined): string {
  const candidate = args?.command ?? args?.path ?? args?.cwd ?? args?.pattern ?? args?.query
  return typeof candidate === "string" ? candidate : ""
}

export async function runTurn(
  options: AgentOptions,
  prompt: string,
  signal: AbortSignal,
  ui: AgentUI,
): Promise<"complete" | "canceled" | "limit"> {
  const { apiKey, mode, session, workspace, webSearch } = options
  const compatibility = options.compatibility ?? {}
  let approved = false
  let effort = options.effort ?? "auto"
  let reason: "complete" | "canceled" | "error" | "limit" = "error"
  await session.append({ type: "user/message", content: redact(prompt, apiKey) })
  try {
    for (let step = 0; ; step += 1) {
      signal.throwIfAborted()
      const finalizing = step === stepLimit
      if (finalizing) {
        reason = "limit"
        ui.notice("Step limit reached after " + stepLimit + " model requests. Summarizing recorded results.")
      }
      const requestedTools = finalizing ? [] : availableTools(mode, approved, Boolean(webSearch))
      const packed = sessionContext(options, approved, finalizing)
      ui.context(packed.snapshot)
      if (packed.snapshot.overBudget) {
        throw new Error("This turn exceeds the estimated input budget. Shorten the prompt or select a larger context window.")
      }
      if (packed.checkpoint) {
        await session.append({ type: "context/compact", checkpoint: packed.checkpoint })
        ui.notice("Compacted earlier turns. Full history remains in the session log.")
      }

      const stream = streamingText(apiKey, (text) => ui.text(text))
      const requestSignal = finalizing ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : signal
      ui.request?.(finalizing)
      const model = await complete({
        config: options.config, apiKey, messages: packed.messages, signal: requestSignal,
        tools: requestedTools.map((entry) => entry.definition),
        outputLimit: packed.snapshot.outputReserve,
        compatibility,
        effort,
        onEffortUnavailable: () => {
          effort = "auto"
          options.onEffortUnavailable?.()
        },
        onText: (text) => { if (!finalizing) stream.push(text) },
        onThinking: () => { if (!finalizing) ui.thinking() },
        onNotice: (notice) => ui.notice(notice),
      })
      requestSignal.throwIfAborted()
      stream.finish()
      if (model.usage) ui.usage?.(model.usage)
      const safeToRun = !model.finish || model.finish === "stop" || model.finish === "tool_calls"
      if (finalizing && (model.toolCalls.length || !model.content.trim() || (model.finish && model.finish !== "stop"))) {
        throw new Error("The provider did not return a complete text summary.")
      }
      const calls = safeToRun ? model.toolCalls : []
      const parsedCalls = calls.map((call) => {
        const parsed = parseCall(call, apiKey)
        const stored = {
          id: apiKey && call.id.includes(apiKey) ? "call-" + randomUUID() : call.id,
          name: redact(call.name, apiKey),
          arguments: parsed.error ? "{}" : redact(call.arguments, apiKey),
        }
        return { parsed, stored }
      })
      await session.append({
        type: "assistant/message", content: redact(model.content, apiKey), reasoning: redact(model.reasoning, apiKey),
        toolCalls: parsedCalls.map(({ stored }) => stored), usage: model.usage, model: options.config.model,
      })
      if (finalizing) {
        ui.text(redact(model.content, apiKey))
        return "limit"
      }
      if (!safeToRun) throw new Error("Model stopped (" + redact(model.finish, apiKey) + "). Pending tools were skipped.")
      if (calls.length === 0) {
        if (!model.content.trim()) throw new Error("The model finished without a reply.")
        if (mode === "plan" && !approved) ui.notice("No plan was submitted in this turn.")
        reason = "complete"
        return reason
      }

      for (const { stored, parsed } of parsedCalls) {
        signal.throwIfAborted()
        const selected = model.toolsEnabled && requestedTools.find((item) => item.definition.function.name === stored.name)
        ui.tool(stored.name, "start", redact(toolTarget(parsed.args), apiKey))
        let result: string
        try {
          if (parsed.error) throw new Error(parsed.error)
          if (!selected) throw new Error("Tool is unknown or unavailable in the current mode.")
          const prepared = await selected.prepare(parsed.args, { workspace, signal, apiKey, webSearch })
          const approval = mode !== "auto" && (selected.access !== "write" || !approved)
            ? prepared.approval : undefined
          if (approval) {
            const allow = await ui.approve({
              ...approval, title: redact(approval.title, apiKey), detail: redact(approval.detail, apiKey),
            }, signal)
            if (!allow) throw new Error("User denied the operation. Respect this decision.")
          }
          signal.throwIfAborted()
          result = await prepared.execute()
          if (selected.access === "plan") approved = true
        } catch (error) {
          signal.throwIfAborted()
          result = "Tool error: " + messageOf(error)
        }
        const content = redact(result, apiKey)
        await session.append({ type: "tool/result", callId: stored.id, content })
        ui.tool(stored.name, "result", content)
      }
    }
  } catch (error) {
    if (signal.aborted) {
      reason = "canceled"
      return reason
    }
    if (reason === "limit") {
      ui.notice("Final summary unavailable. Use /tools to review recorded results before continuing.\n" +
        redact(messageOf(error), apiKey))
      return reason
    }
    throw error
  } finally {
    await session.append({ type: "turn/end", reason })
  }
}

export function latestUsage(session: Session): { model: string; usage: Usage } | undefined {
  for (const { data } of session.events.toReversed()) {
    if (data.type === "user/message") return
    if (data.type === "assistant/message" && data.usage) return { model: data.model, usage: data.usage }
  }
}
