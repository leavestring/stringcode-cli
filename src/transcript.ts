// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import stringWidth from "string-width"
import { fit, tinted } from "./composer.js"
import type { Approval } from "./types.js"
import { terminalText } from "./util.js"

const names: Record<string, string> = {
  ReadFile: "Read", Glob: "Find", Grep: "Search", WriteFile: "Write",
  EditFile: "Edit", SubmitPlan: "Plan", Shell: "PowerShell", WebSearch: "Web search",
}

export function toolName(name: string): string {
  return Object.hasOwn(names, name) ? names[name] : toolPreview(name)
}

export function toolPreview(text: string): string {
  return terminalText(text.replace(/\s+/gu, " ").trim())
}

export function toolSummary(name: string, target: string, result: string, width: number, color: boolean): string {
  const lines = result.split(/\r?\n/).filter((line) => line.trim())
  const failed = /^(?:Tool error:|Shell timed out|Exit: (?!0(?:\s|$)))/.test(lines[0] ?? "")
  const header = fit("    │  " + (failed ? "!" : "✓") + " " + toolName(name), width)
  const preview = toolPreview(target)
  let detail = (lines[0] ?? "").replace(/^Tool error:\s*/i, "")
  const saved = /^Saved .+ \((\d+) bytes\)\.$/.exec(detail)
  if (preview && saved) detail = "Saved · " + saved[1] + " bytes"
  const extra = lines.length - 1
  const suffix = extra > 0 ? "  +" + extra + (extra === 1 ? " line" : " lines") : ""
  const separator = "  ·  "
  const detailText = toolPreview(detail)
  const outcomeRoom = detailText ? separator.length + Math.min(16, stringWidth(detailText)) : 0
  const targetRoom = width - stringWidth(header) - outcomeRoom - 2
  const targetText = fit(preview, Math.min(Math.floor(width * 0.4), targetRoom))
  const base = header + (targetText ? "  " + targetText : "")
  const resultRoom = width - stringWidth(base) - separator.length
  const resultText = fit(detailText, resultRoom)
  const lineCount = stringWidth(detailText + suffix) <= resultRoom ? suffix : ""
  return tinted(base + (resultText ? separator + resultText + lineCount : ""), color, failed ? "amber" : "muted")
}

export function approvalPreview(approval: Approval): { detail: string; folded: boolean } {
  const text = approval.detail.replace(/\r\n/g, "\n")
  const lines = text.split("\n")
  if (approval.kind === "diff") {
    const firstHunk = lines.findIndex((line) => line.startsWith("@@ "))
    const edits = firstHunk < 0 ? [] : lines.slice(firstHunk + 1).filter((line) => /^[+-]/.test(line))
    if (edits.length) {
      const added = edits.filter((line) => line.startsWith("+")).length
      const removed = edits.length - added
      const summary = (text.includes("[Truncated]") ? "Preview: " : "Diff: ") + "+" + added + " / −" + removed + " lines"
      return { detail: [summary, ...edits.slice(0, 4).map((line) => fit(line, 108))].join("\n"), folded: true }
    }
  }
  const folded = lines.length > 5 || lines.some((line) => line.length > 160)
  return { detail: folded ? lines.slice(0, 5).map((line) => fit(line, 160)).join("\n") : text, folded }
}

export function formatReplyLine(line: string, color: boolean, fenced: boolean): string {
  if (fenced) return tinted(line, color, "jade")
  const marker = /^(#{1,6})\s+(.+)$/.exec(line)
  if (marker) return color ? "\x1b[1m" + marker[2] + "\x1b[0m" : marker[2]
  const prose = line.replace(/^(\s*)[-*+]\s+/, "$1• ")
  return prose.replace(/([*]{2})([^*\n]+)\1|\x60([^\x60\n]+)\x60/g,
    (_whole, _bold, strong: string | undefined, code: string | undefined) =>
      code ? tinted(code, color, "jade") : color ? "\x1b[1m" + strong + "\x1b[0m" : strong ?? "")
}
