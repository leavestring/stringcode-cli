// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import { open, lstat, mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { createTwoFilesPatch } from "diff"
import { z } from "zod"
import { executeShell } from "./shell.js"
import type { Approval, Mode, ToolDefinition } from "./types.js"
import { clip, isMissing, readBounded, writeAtomic } from "./util.js"
import type { WebSearch } from "./web-search.js"
import type { Workspace } from "./workspace.js"

const fileLimit = 4 * 1024 * 1024
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const filePath = z.string().min(1).max(2000)
const rootPath = filePath.optional()
const count = (max: number) => z.number().int().min(1).max(max).optional()
const fileText = z.string().max(fileLimit)

export interface ToolContext {
  workspace: Workspace
  signal: AbortSignal
  apiKey: string
  webSearch?: WebSearch
}

interface PreparedTool {
  approval?: Approval
  execute: () => Promise<string>
}

interface Tool {
  definition: ToolDefinition
  access: "read" | "write" | "shell" | "plan"
  prepare: (args: unknown, context: ToolContext) => Promise<PreparedTool>
}

function tool<T extends z.ZodType>(
  name: string,
  description: string,
  schema: T,
  access: Tool["access"],
  prepare: (args: z.infer<T>, context: ToolContext) => Promise<PreparedTool>,
): Tool {
  return {
    definition: { type: "function", function: { name, description, parameters: z.toJSONSchema(schema) } },
    access,
    prepare(args, context) {
      const parsed = schema.safeParse(args)
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; "))
      }
      return prepare(parsed.data, context)
    },
  }
}

function decode(buffer: Buffer): string {
  if (buffer.includes(0)) throw new Error("Expected a UTF-8 text file.")
  try {
    return decoder.decode(buffer)
  } catch {
    throw new Error("Expected a UTF-8 text file.")
  }
}

async function readBytes(target: string): Promise<{ bytes: Buffer; mode: number }> {
  const handle = await open(target, "r")
  try {
    const info = await handle.stat()
    return { bytes: await readBounded(handle, fileLimit), mode: info.mode & 0o777 }
  } finally {
    await handle.close()
  }
}

async function beforeWrite(context: ToolContext, requested: string, target: string, before?: Buffer) {
  context.signal.throwIfAborted()
  if (await context.workspace.resolve(requested, true) !== target) throw new Error("Target changed.")
  const info = await lstat(target).catch((error: unknown) => {
    if (!isMissing(error)) throw error
    return undefined
  })
  if (info?.isSymbolicLink() || (info && !info.isFile()) || Boolean(info) !== Boolean(before) ||
      (before && !(await readBytes(target)).bytes.equals(before))) {
    throw new Error("File changed since preview. Read it again before editing.")
  }
}

async function prepareWrite(requested: string, transform: (existing: string | undefined) => string, context: ToolContext): Promise<PreparedTool> {
  const target = await context.workspace.resolve(requested, true)
  const previous = await readBytes(target).catch((error: unknown) => {
    if (!isMissing(error)) throw error
    return undefined
  })
  const existing = previous ? decode(previous.bytes) : undefined
  const content = transform(existing)
  const bytes = Buffer.from(content, "utf8")
  if (bytes.length > fileLimit || bytes.includes(0)) throw new Error("Expected UTF-8 text within the 4 MiB tool limit.")
  const label = context.workspace.relative(target)
  if (existing === content) return { execute: async () => "No changes to " + label }
  const oldName = previous ? label : "/dev/null"
  const previewDiff = () => (existing?.length ?? 0) + content.length > 120_000
    ? "Large edit. Before (" + (previous?.bytes.length ?? 0) + " bytes):\n" +
      clip(existing ?? "", 4_000) + "\nAfter (" + bytes.length + " bytes):\n" + clip(content, 4_000)
    : clip(createTwoFilesPatch(oldName, label, existing ?? "", content, "", "", {
      context: 3, timeout: 200,
    }) || "Diff preview exceeded time limit. New content excerpt:\n" + clip(content, 4_000), 16_000)
  return {
    get approval(): Approval {
      return { title: (previous ? "Modify " : "Create ") + label, detail: previewDiff(), kind: "diff" }
    },
    async execute() {
      await context.workspace.withWriteLock(target, async () => {
        const verify = () => beforeWrite(context, requested, target, previous?.bytes)
        await verify()
        await mkdir(path.dirname(target), { recursive: true })
        try {
          await writeAtomic(target, bytes, {
            mode: previous?.mode ?? 0o644,
            beforeCommit: verify,
            create: !previous,
          })
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
            throw new Error("File appeared since preview. Read it again before editing.")
          }
          throw error
        }
      })
      return "Saved " + label + " (" + bytes.length + " bytes)."
    },
  }
}

const tools = [
  tool("ReadFile", "Read numbered lines from a UTF-8 file. Start line is 1-based.", z.strictObject({
    path: filePath, start_line: count(5_000_000), line_count: count(1000),
  }), "read", async (args, { workspace }) => ({
    async execute() {
      const target = await workspace.resolve(args.path)
      const raw = decode((await readBytes(target)).bytes)
      const lines = raw.split(/\r?\n/)
      const start = (args.start_line ?? 1) - 1
      if (start >= lines.length) return "Start line is past the end of the file."
      const end = start + (args.line_count ?? 200)
      const text = lines.slice(start, end).map((line, index) => String(start + index + 1) + ": " + clip(line, 4_000)).join("\n")
      return (raw.includes("\r\n") ? "[Contains CRLF line endings]\n" : "") +
        clip(text, 20_000) + (end < lines.length ? "\n[More lines available]" : "")
    },
  })),
  tool("Glob", "Find workspace files matching a glob. Pattern is relative to path. Use forward slashes.", z.strictObject({
    pattern: z.string().min(1).max(256), path: rootPath, limit: count(500),
  }), "read", async (args, { workspace, signal }) => ({
    async execute() {
      const base = await workspace.resolve(args.path ?? ".")
      if (!(await stat(base)).isDirectory()) throw new Error("Glob path must be a directory.")
      const matches: string[] = []
      const limit = args.limit ?? 100
      for await (const file of workspace.files(base, signal)) {
        const relative = path.relative(base, file).split(path.sep).join("/")
        if (path.posix.matchesGlob(relative, args.pattern)) matches.push(workspace.relative(file))
        if (matches.length > limit) break
      }
      return clip(matches.slice(0, limit).sort().join("\n"), 20_000) +
        (matches.length > limit ? "\n[More files matched]" : "") || "No matching files."
    },
  })),
  tool("Grep", "Search for literal text in UTF-8 files. Returns workspace-relative paths and line numbers.", z.strictObject({
    query: z.string().min(1).max(500).refine((value) => !/[\r\n]/.test(value), "Use a single-line query."),
    path: rootPath, glob: z.string().min(1).max(256).optional(), ignore_case: z.boolean().optional(), limit: count(250),
  }), "read", async (args, { workspace, signal }) => ({
    async execute() {
      const query = args.ignore_case ? args.query.toLowerCase() : args.query
      const limit = args.limit ?? 100
      const matches: string[] = []
      let bytes = 0
      for await (const file of workspace.files(args.path ?? ".", signal)) {
        const label = workspace.relative(file)
        if (args.glob && !path.posix.matchesGlob(label, args.glob)) continue
        let text: string
        try {
          const result = await readBytes(await workspace.resolve(file))
          bytes += result.bytes.length
          text = decode(result.bytes)
        } catch (error) {
          if (!isMissing(error) && !(error instanceof Error && /^(?:File exceeds|Expected a UTF-8|Expected a regular file)/.test(error.message))) throw error
          continue
        }
        if (bytes > 32 * 1024 * 1024) {
          return clip(matches.join("\n"), 20_000) + "\n[Search budget reached. Narrow the path or glob.]"
        }
        const lines = text.split(/\r?\n/)
        for (let i = 0; i < lines.length; i += 1) {
          if (!(args.ignore_case ? lines[i].toLowerCase() : lines[i]).includes(query)) continue
          matches.push(label + ":" + (i + 1) + ": " + clip(lines[i], 1_000))
          if (matches.length > limit) return clip(matches.slice(0, limit).join("\n"), 20_000) + "\n[More lines matched]"
        }
      }
      return clip(matches.join("\n"), 20_000) || "No matching text."
    },
  })),
  tool("WriteFile", "Create or overwrite a UTF-8 file. Prefer EditFile for a targeted update.", z.strictObject({
    path: filePath, content: fileText,
  }), "write", async (args, context) => prepareWrite(args.path, () => args.content, context)),
  tool("EditFile", "Replace one exact, unique occurrence of old_text in a UTF-8 file. Match its line endings.", z.strictObject({
    path: filePath, old_text: fileText.min(1), new_text: fileText,
  }), "write", async (args, context) => prepareWrite(args.path, (previous) => {
    if (previous === undefined) throw new Error("EditFile requires an existing file.")
    const start = previous.indexOf(args.old_text)
    if (start < 0) throw new Error("The exact old_text was not found. Read the file and retry.")
    if (previous.indexOf(args.old_text, start + 1) >= 0) throw new Error("old_text matches more than once. Use a larger excerpt.")
    return previous.slice(0, start) + args.new_text + previous.slice(start + args.old_text.length)
  }, context)),
  tool("Shell", "Run a non-interactive PowerShell command. Use a workspace directory.", z.strictObject({
    command: z.string().min(1).max(3500).refine((value) => value.trim() !== "" && !value.includes("\0"), "Enter a PowerShell command."),
    cwd: rootPath, timeout_ms: z.number().int().min(100).max(300_000).optional(),
  }), "shell", async (args, context) => {
    const requested = args.cwd ?? "."
    const cwd = await context.workspace.resolve(requested)
    if (!(await stat(cwd)).isDirectory()) throw new Error("Shell cwd must be a directory.")
    return {
      approval: { title: "Run PowerShell", detail: "Directory: " + cwd + "\nCommand:\n" + args.command, kind: "command" },
      async execute() {
        if (await context.workspace.resolve(requested) !== cwd) throw new Error("Shell directory changed.")
        return executeShell(args.command, cwd, context.workspace.root, context.signal, args.timeout_ms ?? 120_000, context.apiKey)
      },
    }
  }),
  tool("SubmitPlan", "Request approval for a concrete plan in plan mode.", z.strictObject({
    plan: z.string().trim().min(1).max(12_000),
  }), "plan", async ({ plan }) => ({
    approval: { title: "Approve this turn's plan", detail: plan, kind: "plan" },
    execute: async () => "The plan is approved. File writes are permitted for this turn. Shell still requires approval.",
  })),
]

const webSearchTool = tool("WebSearch",
  "Search public web pages for current information or sources. Send a focused query of up to 128 characters. Cite relevant result URLs in your answer.",
  z.strictObject({ query: z.string().trim().min(1).max(256).refine((value) => [...value].length <= 128, "Use at most 128 characters.") }),
  "read", async ({ query }, { webSearch, signal }) => {
    if (!webSearch) throw new Error("Web search is off. Use /search on.")
    return { execute: () => webSearch(query, signal) }
  })

export function availableTools(mode: Mode, approved: boolean, webSearchEnabled = false): Tool[] {
  return (webSearchEnabled ? [...tools, webSearchTool] : tools).filter((entry) => {
    if (entry.access === "plan") return mode === "plan" && !approved
    if (mode === "plan" && !approved) return entry.access === "read"
    return true
  })
}
