// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

export type Mode = "ask" | "plan" | "auto"

export interface ModelConfig {
  baseUrl: string
  model: string
  contextWindow?: number
}

export interface Skill {
  name: string
  description: string
  path: string
  content: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface Usage {
  input?: number
  output?: number
  total?: number
}

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; reasoning_content?: string; tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }> }
  | { role: "tool"; content: string; tool_call_id: string }

export interface ToolDefinition {
  type: "function"
  function: { name: string; description: string; parameters: unknown }
}

export interface Approval {
  title: string
  detail: string
  kind?: "diff" | "command" | "plan"
}

export interface Snapshot {
  window: number
  assumedWindow: boolean
  inputLimit: number
  outputReserve: number
  inputTokens: number
  retainedTurns: number
  compactedTurns: number
  overBudget: boolean
}
