// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import { randomUUID } from "node:crypto"
import { link, rename, rm, writeFile, type FileHandle } from "node:fs/promises"
import path from "node:path"

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "") + "\n[Truncated]"
}

export function terminalText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (character) =>
    "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
  )
}

export function redact(text: string, secret: string): string {
  return secret ? text.replaceAll(secret, "[REDACTED]") : text
}

export function subprocessEnvironment(apiKey?: string): NodeJS.ProcessEnv {
  const keys = [apiKey, process.env.STRINGCODE_API_KEY?.trim(), process.env.STRINGCODE_SEARCH_API_KEY?.trim(),
    process.env.ANYSEARCH_API_KEY?.trim()].filter(Boolean)
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    !/^(?:STRINGCODE_(?:SEARCH_)?API_KEY|ANYSEARCH_API_KEY)$/i.test(name) && (value === undefined || !keys.includes(value.trim())),
  ))
}

export async function readBounded(handle: FileHandle, limit: number): Promise<Buffer> {
  const info = await handle.stat()
  if (!info.isFile()) throw new Error("Expected a regular file.")
  if (info.size > limit) throw new Error("File exceeds the " + limit + "-byte limit.")
  const buffer = Buffer.allocUnsafe(info.size + 1)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset !== info.size) throw new Error("File changed while being read. Try again after it settles.")
  return buffer.subarray(0, offset)
}

export async function writeAtomic(
  target: string,
  data: string | Uint8Array,
  options: { beforeCommit?: () => Promise<void>; mode?: number; create?: boolean } = {},
) {
  const temporary = path.join(path.dirname(target), ".stringcode-" + randomUUID() + ".tmp")
  try {
    await writeFile(temporary, data, { flag: "wx", mode: options.mode ?? 0o600 })
    await options.beforeCommit?.()
    if (options.create) {
      await link(temporary, target)
    } else {
      await rename(temporary, target)
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}
