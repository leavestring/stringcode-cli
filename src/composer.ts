// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import stringWidth from "string-width"
import type { Mode } from "./types.js"
import { terminalText } from "./util.js"
import type { Effort, Suggestion } from "./commands.js"

export interface ComposerStatus {
  model: string
  mode: Mode
  effort: Effort
  effortUnavailable: boolean
}

interface ComposerFrame {
  lines: string[]
  cursorRow: number
  cursorColumn: number
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const modeLabels = { ask: "Ask", plan: "Plan", auto: "Auto" }
const ink = { border: "79;103;93", amber: "225;174;107", jade: "146;194;177", muted: "156;164;158" }

export function tinted(text: string, color: boolean, tone: keyof typeof ink): string {
  return color ? "\x1b[38;2;" + ink[tone] + "m" + text + "\x1b[0m" : text
}

export function fit(text: string, width: number): string {
  if (width <= 0) return ""
  if (stringWidth(text) <= width) return text
  let shown = ""
  let used = 0
  for (const { segment } of segmenter.segment(text)) {
    const size = stringWidth(segment)
    if (used + size >= width) break
    shown += segment
    used += size
  }
  return shown + "…"
}

function draftLayout(text: string, cursor: number, width: number) {
  const rows = [""]
  const available = width - 4
  let row = 0
  let cells = 0
  let location = { row, cells }

  for (const { segment, index } of segmenter.segment(text)) {
    const visible = terminalText(segment.replace(/\t/g, " "))
    const size = stringWidth(visible)
    if (cells + size > available) {
      rows.push("")
      row++
      cells = 0
    }
    if (index <= cursor) location = { row, cells }
    rows[row] += visible
    cells += size
  }
  if (cursor >= text.length) location = { row, cells }
  return { rows, ...location }
}

function footer(status: ComposerStatus, width: number, color: boolean, queued: number): string[] {
  const model = "◊ " + terminalText(status.model)
  const mode = "■ " + modeLabels[status.mode] + " mode" + (status.mode === "auto" ? " / no prompts" : "")
  const effort = "≈ Effort " + (status.effort === "auto" ? "default" : status.effort) +
    (status.effortUnavailable ? " (unsupported)" : "")
  const separator = "   "
  const available = width - stringWidth(mode) - stringWidth(effort) - 2 * separator.length - 2
  const hint = queued ? queued + " queued" : "Shift+Tab mode"
  const showHint = available - hint.length - separator.length >= 10
  const modelWidth = available - (showHint ? hint.length + separator.length : 0)
  const rest = tinted(mode, color, status.mode === "auto" ? "amber" : "jade") + separator + tinted(effort, color, "muted")
  if (modelWidth >= 10) {
    return ["  " + fit(model, modelWidth) + separator + rest + (showHint ? separator + tinted(hint, color, "muted") : "")]
  }
  return ["  " + fit(model, width - 2), "  " + (stringWidth(mode + separator + effort) <= width - 2
    ? rest
    : tinted(fit(mode + " / " + effort, width - 2), color, "muted"))]
}

export function composeFrame(options: {
  text: string
  cursor: number
  status: ComposerStatus
  suggestions: Suggestion[]
  selected: number
  columns: number
  height: number
  color: boolean
  queued?: number
}): ComposerFrame {
  const { text, cursor, status, suggestions, selected, columns, height, color } = options
  const width = columns - 1
  const bar = tinted("─".repeat(width), color, "border")
  const statusLines = footer(status, width, color, options.queued ?? 0)
  const draft = draftLayout(text, cursor, width)
  const room = height - statusLines.length - 3
  const menuRows = Math.max(0, Math.min(5, suggestions.length, room - 2))
  const draftRows = Math.max(1, Math.min(4, room - menuRows - (menuRows ? 1 : 0)))
  const start = Math.max(0, Math.min(draft.row - draftRows + 1, draft.rows.length - draftRows))
  const body = draft.rows.slice(start, start + draftRows).map((line, index) =>
    "  " + (index === 0 ? tinted(start ? "…" : "›", color, "amber") : " ") + " " + line)
  const lines = [bar, ...body, bar, ...statusLines]

  if (menuRows) {
    const offset = Math.max(0, Math.min(selected - menuRows + 1, suggestions.length - menuRows))
    const commandWidth = Math.min(22, Math.max(11, Math.floor(width * 0.38)))
    const descriptionWidth = width - commandWidth - 6
    suggestions.slice(offset, offset + menuRows).forEach(({ text, description }, index) => {
      const active = index + offset === selected
      const command = fit(text, commandWidth)
      const descriptionText = descriptionWidth > 4
        ? "  " + fit(description, descriptionWidth)
        : ""
      const label = "  " + (active ? "› " : "  ") + command.padEnd(commandWidth) + descriptionText
      lines.push(tinted(label, color, active ? "jade" : "muted"))
    })
    lines.push(tinted(fit("  ↑/↓ select   Tab complete   Esc dismiss", width), color, "muted"))
  }
  return { lines, cursorRow: 1 + draft.row - start, cursorColumn: 4 + draft.cells }
}
