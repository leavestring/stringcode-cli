// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import { stdout } from "node:process"
import { terminalText } from "./util.js"

export const brandName = "String Code"

const palette: Readonly<Partial<Record<string, string>>> = {
  d: "53;66;58",
  t: "80;94;82",
  l: "110;125;109",
  s: "139;88;44",
  b: "214;148;75",
  g: "242;174;91",
  w: "255;232;178",
  f: "133;77;36",
  h: "80;46;26",
  a: "46;29;20",
  r: "42;31;24",
}

// Each terminal cell renders two pixel rows. Keep the field transparent around the mark.
const markPixels = [
  "",
  "   ll   rr   rr   ll",
  " ltttl r       r ltttl",
  " ttdd r         r ddtt",
  " tl  r           r  lt",
  "ltl  r   aaaaa   r  ltl",
  "bbbs    ahhfhha    sbbb",
  "tlsbbbbbbggwggbbbbbbslt",
  " tl     ahfgfha     lt",
  " ttll    ahhha    lltt",
  " dtttl    aaa    ltttd",
  "  ddt             tdd",
  "      r         r",
  "       rr     rr",
  "         rrrrr",
  "",
]
const markWidth = Math.max(...markPixels.map((row) => row.length))
const decorativePixels = new Set(["a", "h", "f", "r"])

function renderMark(color: boolean): string[] {
  const rows: string[] = []
  for (let y = 0; y < markPixels.length; y += 2) {
    const width = Math.max(markPixels[y].length, markPixels[y + 1].length)
    let row = ""
    for (let x = 0; x < width; x++) {
      const upper = markPixels[y][x]
      const lower = markPixels[y + 1][x]
      const top = color || !decorativePixels.has(upper) ? palette[upper] : undefined
      const bottom = color || !decorativePixels.has(lower) ? palette[lower] : undefined
      if (!top && !bottom) {
        row += " "
        continue
      }
      const glyph = top && bottom && (top === bottom || !color) ? "█" : top ? "▀" : "▄"
      if (!color) {
        row += glyph
      } else {
        const colors = "38;2;" + (top ?? bottom) +
          (top && bottom && top !== bottom ? ";48;2;" + bottom : "")
        row += "\x1b[" + colors + "m" + glyph + "\x1b[0m"
      }
    }
    rows.push(row)
  }
  return rows
}

export function terminalUsesColor(): boolean {
  return Boolean(stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb")
}

export function renderBrand(details: string[], columns: number | undefined, color: boolean): string {
  const heading = color ? "\x1b[1m" + brandName + "\x1b[0m" : brandName
  const lines = [heading, ...details.map(terminalText)]
  if (!columns || columns <= markWidth) return lines.join("\n")

  const mark = renderMark(color)
  const gap = 4
  // Reserve two cells for characters that can be wide in workspace and model names.
  const detailWidth = (text: string) => [...text].reduce((width, char) => width + (char.charCodeAt(0) < 128 ? 1 : 2), 0)
  const labelsWidth = Math.max(...[brandName, ...lines.slice(1)].map(detailWidth))
  if (markWidth + gap + labelsWidth + 1 > columns || mark.length < lines.length) {
    return [...mark, "", ...lines].join("\n")
  }

  const inset = Math.floor((mark.length - lines.length) / 2)
  return mark.map((row, index) => {
    const label = lines[index - inset]
    if (!label) return row
    const occupied = Math.max(markPixels[index * 2].length, markPixels[index * 2 + 1].length)
    return row + " ".repeat(markWidth - occupied + gap) + label
  }).join("\n")
}
