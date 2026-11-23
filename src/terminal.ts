// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import { stdin, stdout } from "node:process"
import { emitKeypressEvents, type Key } from "node:readline"
import { createInterface, type Interface } from "node:readline/promises"
import { PassThrough, Writable } from "node:stream"
import stringWidth from "string-width"
import wrapAnsi from "wrap-ansi"
import type { AgentUI } from "./agent.js"
import { renderBrand, terminalUsesColor } from "./brand.js"
import { suggest, type Effort } from "./commands.js"
import { composeFrame, fit, tinted, type ComposerStatus } from "./composer.js"
import { updateFrame, type TerminalFrame } from "./terminal-frame.js"
import { approvalPreview, formatReplyLine, toolName, toolPreview, toolSummary } from "./transcript.js"
import type { Approval, Mode, Usage } from "./types.js"
import { terminalText } from "./util.js"

export const cycleMode = Symbol("cycle mode")
type Input = string | typeof cycleMode

interface Composer {
  status: ComposerStatus
  selected: number
  dismissed: boolean
}

export interface PickOption {
  id: string
  label: string
  detail?: string
}

interface Picker {
  title: string
  options: PickOption[]
  selected: number
  query: string
  rows: number
  finish: (id?: string) => void
}

interface TurnProgress {
  started: number
  effort: Effort
  phase?: string
  preview?: string
  outputTokens?: number
}

const spinner = ["·", "•", "●", "•"]
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function elapsed(started: number): string {
  const seconds = Math.floor((Date.now() - started) / 1000)
  return seconds >= 60 ? Math.floor(seconds / 60) + "m " + seconds % 60 + "s" : seconds + "s"
}

function wrap(text: string, width: number): string[] {
  const rows = [""]
  let cells = 0
  for (const { segment } of graphemes.segment(text)) {
    const size = stringWidth(segment)
    if (cells + size > width) {
      rows.push("")
      cells = 0
    }
    rows[rows.length - 1] += segment
    cells += size
  }
  return rows
}

export class Terminal implements AgentUI {
  private readonly input: Interface
  private readonly enhanced = Boolean(stdin.isTTY && stdout.isTTY && process.env.TERM !== "dumb")
  private readonly colors = terminalUsesColor()
  private readonly closeSignal = new AbortController()
  private readonly wasRaw = stdin.isTTY ? stdin.isRaw : false
  private readonly queue: Input[] = []
  private receiver?: (input?: Input) => void
  private pendingQuestion = false
  private paste: string | undefined
  private inline = false
  private partial = ""
  private frame?: TerminalFrame
  private frameTimer?: ReturnType<typeof setTimeout>
  private replyFirst = true
  private replyFence = false
  private toolTarget = ""
  private toolActivity = false
  private controller?: AbortController
  private composer?: Composer
  private picker?: Picker
  private progress?: TurnProgress
  private timer?: ReturnType<typeof setInterval>

  constructor() {
    if (this.enhanced) {
      const output = Object.assign(new Writable({
        write: (chunk, _encoding, done) => {
          if (!this.composer) stdout.write(chunk)
          done()
        },
      }), { columns: stdout.columns })
      this.input = createInterface({ input: new PassThrough(), output, terminal: true, historySize: 100 })
      emitKeypressEvents(stdin)
      stdin.setRawMode(true)
      stdin.on("keypress", this.keypress)
      stdin.on("end", this.close)
      stdout.on("resize", this.resize)
      stdin.resume()
    } else {
      this.input = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY && stdout.isTTY), historySize: 100 })
    }
    this.input.on("SIGINT", this.interrupt)
    process.on("SIGINT", this.interrupt)
    this.input.on("close", this.cleanup)
    this.input.on("line", (line) => {
      if (this.composer && line.trim()) this.enqueue(line)
    })
  }

  private readonly resize = () => {
    if (this.picker) this.drawPicker()
    else {
      this.eraseComposer()
      this.redraw()
    }
  }

  private readonly interrupt = () => {
    this.paste = undefined
    if (this.controller) {
      this.controller.abort()
    } else if (this.input.line) {
      this.replaceDraft("")
      this.redraw()
    } else {
      this.close()
    }
  }

  private readonly cleanup = () => {
    this.closeSignal.abort()
    this.controller?.abort()
    this.receiver?.()
    this.picker?.finish()
    clearInterval(this.timer)
    clearTimeout(this.frameTimer)
    this.eraseComposer()
    if (this.partial) stdout.write(this.partial + "\n")
    this.partial = ""
    process.removeListener("SIGINT", this.interrupt)
    if (this.enhanced) {
      if (this.composer) stdout.write("\x1b[?2004l")
      stdin.removeListener("keypress", this.keypress)
      stdin.removeListener("end", this.close)
      stdout.removeListener("resize", this.resize)
      stdin.setRawMode(this.wasRaw)
      stdin.pause()
    }
  }

  private enqueue(input: Input): void {
    if (this.receiver) {
      const receive = this.receiver
      this.receiver = undefined
      receive(input)
    } else {
      this.queue.push(input)
    }
  }

  private replaceDraft(value: string): void {
    this.input.write(null, { name: "end" })
    this.input.write(null, { ctrl: true, name: "u" })
    if (value) this.input.write(value)
  }

  private readonly keypress = (text: string | undefined, key: Key = {}) => {
    if (key.ctrl && key.name === "c") {
      this.interrupt()
      return
    }
    if (this.picker) {
      this.pickerKey(text, key, this.picker)
      return
    }

    const composer = this.composer
    if (!composer && !this.pendingQuestion) return
    if (composer && key.shift && key.name === "tab") {
      if (this.queue.length < 20) this.enqueue(cycleMode)
      return
    }
    if (composer && key.name === "paste-start") {
      this.paste = ""
      return
    }
    if (composer && this.paste !== undefined) {
      if (key.name === "paste-end") {
        const pasted = this.paste.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
        this.paste = undefined
        if (pasted) this.input.write(pasted)
        composer.selected = 0
        composer.dismissed = false
        this.redraw()
      } else if (!key.meta && (text ?? key.sequence)) {
        this.paste += text ?? key.sequence
      }
      return
    }

    const enter = key.name === "return" || key.name === "enter"
    const menu = composer && !composer.dismissed ? suggest(this.input.line) : []
    if (composer && menu.length) {
      if (key.name === "up" || key.name === "down") {
        const delta = key.name === "up" ? -1 : 1
        composer.selected = (composer.selected + delta + menu.length) % menu.length
        this.redraw()
        return
      }
      if (key.name === "escape") {
        composer.dismissed = true
        this.redraw()
        return
      }
      const choice = menu[composer.selected] ?? menu[0]
      if (key.name === "tab" || (enter && this.input.line !== choice.text)) {
        this.replaceDraft(choice.text + (choice.trailingSpace ? " " : ""))
        composer.selected = 0
        composer.dismissed = key.name === "tab" && !choice.trailingSpace
        this.redraw()
        return
      }
    }

    if (enter && composer && this.queue.length >= 20) {
      this.notice("The input queue is full. Your draft is still in the input box.")
      return
    }
    if (enter && !composer) this.pendingQuestion = false
    const previous = this.input.line
    this.input.write(text ?? null, key)
    if (composer && this.input.line !== previous) {
      composer.selected = 0
      composer.dismissed = false
    }
    if (composer) this.redraw()
  }

  private eraseComposer(): void {
    if (!this.frame) return
    const up = this.frame.cursorRow
    stdout.write("\r" + (up ? "\x1b[" + up + "A" : "") + "\x1b[J")
    this.frame = undefined
  }

  private progressText(width: number): string | undefined {
    const progress = this.progress
    if (!progress?.phase || this.inline) return
    const symbol = spinner[Math.floor((Date.now() - progress.started) / 125) % spinner.length]
    const effort = progress.effort === "auto" ? "" : "  ·  " + progress.effort + " effort"
    const status = "  " + symbol + " " + progress.phase + "  ·  " + elapsed(progress.started) + effort
    const preview = fit(progress.preview ?? "", width - stringWidth(status) - 3)
    return tinted(fit(status, width), this.colors, "amber") + (preview ? tinted("   " + preview, this.colors, "muted") : "")
  }

  private readonly redraw = () => this.paintFrame()

  private paintFrame(committed: string[] = []): void {
    clearTimeout(this.frameTimer)
    this.frameTimer = undefined
    const composer = this.composer
    if (!composer || this.closeSignal.signal.aborted) return
    const columns = Math.max(12, stdout.columns)
    const liveStatus = this.progressText(columns - 1)
    const above = this.partial
      ? wrap(this.partial, columns - 5).slice(-2).map((line, index) => this.replyLine(line, false, index > 0))
      : liveStatus ? [liveStatus] : []
    const composerFrame = composeFrame({
      text: this.input.line, cursor: this.input.cursor, status: composer.status,
      suggestions: composer.dismissed ? [] : suggest(this.input.line), selected: composer.selected,
      columns, height: Math.max(6, stdout.rows - above.length), color: this.colors,
      queued: this.queue.length,
    })
    const next = {
      lines: [...above, ...composerFrame.lines],
      cursorRow: composerFrame.cursorRow + above.length,
      cursorColumn: composerFrame.cursorColumn,
    }
    const output = updateFrame(this.frame, {
      ...next, lines: [...committed, ...next.lines], cursorRow: next.cursorRow + committed.length,
    })
    if (output) stdout.write(output)
    this.frame = next
  }

  private scheduleRedraw(): void {
    this.frameTimer ??= setTimeout(this.redraw, 32)
  }

  private writeAbove(text: string): void {
    if (!this.composer || this.closeSignal.signal.aborted) {
      stdout.write(text)
      return
    }
    const width = Math.max(12, stdout.columns) - 1
    const rows = text.replace(/\n$/, "").split("\n").flatMap((line) =>
      wrapAnsi(line, width, { hard: true, wordWrap: false, trim: false }).split("\n"))
    this.paintFrame(rows)
  }

  async modal<T>(action: () => Promise<T>): Promise<T> {
    const composer = this.composer
    if (!composer) return action()
    const draft = this.input.line
    const cursor = this.input.cursor
    this.lineBreak()
    this.eraseComposer()
    this.replaceDraft("")
    this.composer = undefined
    this.paste = undefined
    stdout.write("\x1b[?2004l")
    try {
      return await action()
    } finally {
      if (!this.closeSignal.signal.aborted) {
        this.composer = composer
        this.replaceDraft(draft)
        while (this.input.cursor > cursor) {
          const previous = this.input.cursor
          this.input.write(null, { name: "left" })
          if (this.input.cursor >= previous) break
        }
        stdout.write("\x1b[?2004h")
        this.redraw()
      }
    }
  }

  private pickerMatches(picker: Picker): PickOption[] {
    const query = picker.query.toLowerCase()
    return picker.options.filter(({ label, detail }) => (label + " " + (detail ?? "")).toLowerCase().includes(query))
  }

  private pickerKey(text: string | undefined, key: Key, picker: Picker): void {
    const items = this.pickerMatches(picker)
    if (key.name === "escape") {
      picker.finish()
      return
    }
    if (key.name === "return" || key.name === "enter") {
      if (items[picker.selected]) picker.finish(items[picker.selected].id)
      return
    }
    if (key.name === "up" || key.name === "down") {
      const delta = key.name === "up" ? -1 : 1
      if (items.length) picker.selected = (picker.selected + delta + items.length) % items.length
    } else if (key.name === "backspace") {
      picker.query = [...picker.query].slice(0, -1).join("")
      picker.selected = 0
    } else if (text && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f-\u009f]/.test(text)) {
      picker.query = (picker.query + text).slice(0, 120)
      picker.selected = 0
    } else {
      return
    }
    this.drawPicker()
  }

  private erasePicker(picker: Picker): void {
    if (picker.rows) stdout.write("\r" + (picker.rows > 1 ? "\x1b[" + (picker.rows - 1) + "A" : "") + "\x1b[J")
    picker.rows = 0
  }

  private drawPicker(): void {
    const picker = this.picker
    if (!picker) return
    this.erasePicker(picker)
    const width = stdout.columns - 1
    const items = this.pickerMatches(picker)
    const count = Math.max(1, Math.min(10, stdout.rows - 5, items.length))
    const low = Math.max(0, Math.min(picker.selected - count + 1, items.length - count))
    const lines = [tinted(fit(picker.title, width), this.colors, "amber")]
    lines.push(tinted(fit(picker.query ? "  Filter: " + terminalText(picker.query) : "  Type to filter", width), this.colors, "muted"))
    for (const [index, option] of items.slice(low, low + count).entries()) {
      const active = low + index === picker.selected
      const description = option.detail ? "   " + terminalText(option.detail) : ""
      lines.push(tinted(fit((active ? "  › " : "    ") + terminalText(option.label) + description, width),
        this.colors, active ? "jade" : "muted"))
    }
    if (!items.length) lines.push("    No matches")
    lines.push(tinted(fit("  ↑/↓ move   Enter select   Esc cancel" +
      (items.length > count ? "   " + (low + 1) + "–" + (low + count) + " of " + items.length : ""), width), this.colors, "muted"))
    stdout.write(lines.join("\r\n"))
    picker.rows = lines.length
  }

  async pick(title: string, options: PickOption[], current: string | undefined, signal: AbortSignal): Promise<string | undefined> {
    if (signal.aborted || this.closeSignal.signal.aborted || options.length === 0) return
    if (!this.enhanced) {
      this.notice(title + "\n" + options.map((option, index) => "  " + (index + 1) + "  " + option.label).join("\n"))
      const reply = await this.ask("Select number: ", signal)
      if (reply && /^\d+$/.test(reply)) return options[Number(reply) - 1]?.id
      return
    }
    return new Promise((resolve) => {
      const finish = (id?: string) => {
        signal.removeEventListener("abort", cancel)
        if (this.picker) this.erasePicker(this.picker)
        this.picker = undefined
        resolve(id)
      }
      const cancel = () => finish()
      this.picker = { title, options, selected: Math.max(0, options.findIndex(({ id }) => id === current)), query: "", rows: 0, finish }
      signal.addEventListener("abort", cancel, { once: true })
      this.drawPicker()
    })
  }

  startOperation(): AbortSignal {
    this.controller = new AbortController()
    if (this.closeSignal.signal.aborted) this.controller.abort()
    return this.controller.signal
  }

  finishOperation(): void {
    this.controller = undefined
    this.lineBreak()
  }

  startTurn(effort: Effort): AbortSignal {
    const signal = this.startOperation()
    this.progress = { started: Date.now(), effort, phase: "Waiting for model" }
    if (this.composer) {
      this.timer = setInterval(() => {
        if (this.progress?.phase && !this.picker && !this.pendingQuestion) this.redraw()
      }, 125)
      this.timer.unref()
      this.redraw()
    }
    return signal
  }

  request(finalizing = false): void {
    this.phase(finalizing ? "Summarizing results" : "Waiting for model")
  }

  usage(usage: Usage): void {
    if (this.progress && usage.output !== undefined) {
      this.progress.outputTokens = (this.progress.outputTokens ?? 0) + usage.output
    }
  }

  effortFallback(): void {
    if (this.progress) this.progress.effort = "auto"
  }

  finishTurn(result: "complete" | "limit" | "canceled" | "error", failure?: string): void {
    const progress = this.progress
    clearInterval(this.timer)
    this.timer = undefined
    this.progress = undefined
    this.finishOperation()
    if (!progress) return
    this.toolActivity = false
    const label = { complete: "Reply complete", limit: "Step limit reached", canceled: "Canceled", error: "Turn failed" }[result]
    const usage = progress.outputTokens === undefined ? "" : "  ·  " + progress.outputTokens + " output tokens"
    const icon = result === "complete" ? "●" : "○"
    const summary = tinted("    " + icon + " " + label + " in " + elapsed(progress.started) +
      usage + "  ·  " + clock.format(new Date()), this.colors, result === "complete" ? "jade" : "amber")
    const detail = failure ? "\n    " + terminalText(failure).replace(/\n/g, "\n    ") : ""
    this.writeAbove("\n" + summary + detail + "\n")
  }

  private phase(label?: string, preview?: string): void {
    if (!this.progress) return
    this.progress.phase = label
    this.progress.preview = preview
    this.redraw()
  }

  readonly close = (): void => {
    this.input.close()
  }

  async ask(label: string, signal?: AbortSignal, secret = false): Promise<string | undefined> {
    const lifetime = signal ? AbortSignal.any([this.closeSignal.signal, signal]) : this.closeSignal.signal
    if (lifetime.aborted) return
    this.pendingQuestion = true
    const forget = (history: string[]) => { history.shift() }
    if (secret) this.input.on("history", forget)
    try {
      return await this.input.question(label, { signal: lifetime })
    } catch (error) {
      if (lifetime.aborted) {
        if (!this.closeSignal.signal.aborted && this.input.line) this.replaceDraft("")
        return
      }
      throw error
    } finally {
      if (secret) this.input.removeListener("history", forget)
      this.pendingQuestion = false
    }
  }

  async compose(status: ComposerStatus): Promise<Input | undefined> {
    if (this.closeSignal.signal.aborted) return
    if (!this.composer && (!this.enhanced || stdout.columns < 24 || stdout.rows < 8)) {
      return this.ask(status.mode + " › ")
    }
    if (!this.composer) {
      this.composer = { status, selected: 0, dismissed: false }
      stdout.write("\x1b[?2004h")
    } else {
      this.composer.status = status
    }
    const queued = this.queue.shift()
    this.redraw()
    if (queued !== undefined) return queued
    return new Promise((resolve) => { this.receiver = resolve })
  }

  setupBanner(): void {
    const heading = renderBrand(["Connect an OpenAI-compatible provider."], stdout.columns, this.colors)
    stdout.write("\n" + heading + "\n\n")
  }

  banner(workspace: string, model: string, id: string, showBrand: boolean): void {
    const details = ["Model " + model, workspace, "Session " + id + "   /help"]
    const heading = showBrand
      ? renderBrand(details, stdout.isTTY ? stdout.columns : undefined, this.colors)
      : details.map(terminalText).join("\n")
    stdout.write("\n" + heading + "\n\n")
  }

  setMode(mode: Mode): void {
    if (this.composer) {
      this.composer.status.mode = mode
      this.redraw()
    } else {
      this.notice("Mode: " + mode)
    }
  }

  echoInput(line: string): void {
    if (this.composer) {
      this.writeAbove("\n" + tinted("  ▌ ", this.colors, "amber") + terminalText(line) + "\n\n")
    }
  }

  private replyLine(line: string, commit: boolean, continuation = false): string {
    if (!line.trim()) return ""
    const fence = /^\s*(?:\x60{3,}|~{3,})\s*(.*)$/.exec(line)
    if (fence) {
      const codeLabel = this.replyFence ? "└" : "┌ " + (fence[1] || "Code")
      if (commit) this.replyFence = !this.replyFence
      return tinted("    " + codeLabel, this.colors, "jade")
    }
    const first = this.replyFirst && !continuation
    if (commit) this.replyFirst = false
    const prefix = first ? tinted("  ● ", this.colors, "jade") : "    "
    return prefix + formatReplyLine(line, this.colors, this.replyFence)
  }

  text(chunk: string): void {
    if (this.progress) this.progress.phase = undefined
    const safe = terminalText(chunk.replace(/\r\n/g, "\n")).replace(/\t/g, "    ")
    if (!this.inline) {
      this.endToolActivity()
      this.inline = true
      this.replyFirst = true
      this.replyFence = false
      if (!this.composer) stdout.write(tinted("  ● ", this.colors, "jade"))
    }
    if (!this.composer) {
      stdout.write(safe)
      return
    }
    const received = this.partial + safe
    const lines = received.split("\n")
    const rows = wrap(lines.pop() ?? "", Math.max(12, stdout.columns) - 5)
    this.partial = rows.pop() ?? ""
    const committed = [...lines, ...rows].map((line) => this.replyLine(line, true))
    if (committed.length) this.writeAbove(committed.join("\n") + "\n")
    else this.scheduleRedraw()
  }

  thinking(): void {
    this.phase("Reasoning")
  }

  lineBreak(): void {
    if (!this.inline) return
    const trailing = this.partial
    this.partial = ""
    this.inline = false
    if (trailing && this.composer) this.writeAbove(this.replyLine(trailing, true) + "\n")
    else if (!this.composer) this.writeAbove("\n")
  }

  notice(notice: string): void {
    this.lineBreak()
    this.endToolActivity()
    this.writeAbove(terminalText(notice.replace(/\r\n/g, "\n")) + "\n")
  }

  private endToolActivity(): void {
    if (!this.toolActivity) return
    this.toolActivity = false
    this.writeAbove("\n")
  }

  tool(name: string, state: "start" | "result", detail: string): void {
    if (state === "start") {
      this.lineBreak()
      this.toolTarget = detail
      this.phase("Running " + toolName(name), toolPreview(detail))
    } else {
      if (this.progress) this.progress.phase = undefined
      const heading = this.toolActivity ? "" : "\n" + tinted("    Tool activity", this.colors, "muted") + "\n"
      this.toolActivity = true
      this.writeAbove(heading + toolSummary(name, this.toolTarget, detail, Math.max(12, stdout.columns || 80) - 1, this.colors) + "\n")
      this.toolTarget = ""
    }
  }

  context(): void {
    // Detailed estimates are available on demand through /tokens.
  }

  async approve(prompt: Approval, signal: AbortSignal): Promise<boolean> {
    this.phase(undefined)
    const allowed = await this.modal(async () => {
      if (!stdin.isTTY || !stdout.isTTY) {
        this.notice("Approval requires an interactive terminal. Operation denied.")
        return false
      }
      const preview = approvalPreview(prompt)
      this.notice("\n  ▸ " + prompt.title + "\n" + preview.detail.split("\n").map((line) => "    " + line).join("\n"))
      const ask = "    Approve? [y/N" + (preview.folded ? "/d details" : "") + "] "
      let answer = await this.ask(ask, signal)
      while (preview.folded && /^(?:d|details)$/i.test(answer?.trim() ?? "")) {
        this.notice(prompt.detail)
        answer = await this.ask("    Approve? [y/N] ", signal)
      }
      return /^(?:y|yes)$/i.test(answer?.trim() ?? "")
    })
    if (!signal.aborted && this.progress) this.phase("Running tool")
    return allowed
  }
}
