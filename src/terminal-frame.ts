// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import stringWidth from "string-width"

export interface TerminalFrame {
  lines: string[]
  cursorRow: number
  cursorColumn: number
}

// Move within the retained terminal rows. Only a newline past the old bottom scrolls.
export function updateFrame(previous: TerminalFrame | undefined, next: TerminalFrame): string {
  let row = previous?.cursorRow ?? 0
  let column = previous?.cursorColumn ?? 0
  let bottom = Math.max(0, (previous?.lines.length ?? 1) - 1)
  let output = ""

  function move(target: number) {
    const visibleTarget = Math.min(target, bottom)
    const delta = visibleTarget - row
    if (delta) output += "\x1b[" + Math.abs(delta) + (delta < 0 ? "A" : "B")
    if (target > bottom) {
      output += "\r\n".repeat(target - bottom)
      bottom = target
      column = 0
    }
    row = target
  }

  const count = Math.max(previous?.lines.length ?? 0, next.lines.length)
  for (let index = 0; index < count; index++) {
    const before = previous?.lines[index]
    const after = next.lines[index]
    if (after === before) continue
    move(index)
    if (before && after?.startsWith(before)) {
      output += "\x1b[" + (stringWidth(before) + 1) + "G" + after.slice(before.length)
    } else {
      output += "\r" + (after ?? "") + "\x1b[K"
    }
    column = -1
  }
  move(next.cursorRow)
  if (column !== next.cursorColumn) output += "\x1b[" + (next.cursorColumn + 1) + "G"
  return output
}
