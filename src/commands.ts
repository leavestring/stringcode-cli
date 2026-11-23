// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

export const efforts = ["auto", "low", "medium", "high"] as const
export type Effort = typeof efforts[number]

export const slashCommands = [
  ["/help", "/help", "Show available commands"],
  ["/model", "/model [id]", "Browse models from the current provider"],
  ["/provider", "/provider", "Switch or add a provider"],
  ["/provider add", "/provider add", "Configure a new provider"],
  ["/provider key", "/provider key", "Replace the current provider's API key"],
  ["/search", "/search", "Show web search status"],
  ["/search key", "/search key", "Configure an optional AnySearch key"],
  ["/search off", "/search off", "Disable web search and remove its saved key"],
  ["/search on", "/search on", "Enable AnySearch web search"],
  ["/effort", "/effort [auto|low|medium|high]", "Set model reasoning effort"],
  ["/ask", "/ask", "Approve workspace writes individually"],
  ["/plan", "/plan", "Review a plan before writing"],
  ["/auto", "/auto", "Run available tools without individual approval"],
  ["/tokens", "/tokens", "Show context and provider token usage"],
  ["/tools", "/tools", "Inspect tool results from the last turn"],
  ["/compact", "/compact", "Compact earlier turns"],
  ["/skills", "/skills", "List mounted skills"],
  ["/skills add", "/skills add <path>", "Mount a workspace SKILL.md"],
  ["/skills remove", "/skills remove <name>", "Remove a mounted skill"],
  ["/new", "/new", "Start a new session"],
  ["/sessions", "/sessions", "List workspace sessions"],
  ["/resume", "/resume <id>", "Resume a saved session"],
  ["/exit", "/exit", "Close String Code"],
] as const

export interface Suggestion {
  text: string
  description: string
  trailingSpace?: boolean
}

export function suggest(line: string): Suggestion[] {
  if (/^\/effort +[^ ]*$/.test(line)) {
    const fragment = line.slice("/effort".length).trim().toLowerCase()
    return efforts.filter((effort) => effort.startsWith(fragment)).map((effort) => ({
      text: "/effort " + effort,
      description: effort === "auto" ? "Use the provider's default" : "Request " + effort + " effort",
    }))
  }
  if (!/^\/[^ ]*$/.test(line) && !/^\/(?:skills|provider|search) +[^ ]*$/.test(line)) return []
  return slashCommands.filter(([name]) => name.startsWith(line.toLowerCase())).map(([name, usage, description]) => ({
    text: name, description, trailingSpace: usage.includes(" <") || name === "/effort",
  }))
}

export function helpText(): string {
  return slashCommands.map(([, usage, description]) => usage.padEnd(35) + description).join("\n") +
    "\n\nType / to browse commands. Use ↑/↓ to select and Tab to complete.\nShift+Tab cycles modes. Ctrl+C cancels the current turn or clears the prompt."
}
