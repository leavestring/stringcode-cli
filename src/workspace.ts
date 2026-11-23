// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import { createHash } from "node:crypto"
import { lstat, mkdir, opendir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import lockfile from "proper-lockfile"
import { isMissing } from "./util.js"

const protectedNames = new Set([
  ".git", ".data", ".ssh", ".aws", ".gnupg", "node_modules", "dist", "coverage", "credentials.json",
  "id_rsa", "id_ed25519",
])

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
}

function protectedName(segment: string): boolean {
  const value = segment.toLowerCase()
  return protectedNames.has(value) || value.startsWith(".env") || value.startsWith(".stringcode-")
}

function assertWindowsSegment(segment: string) {
  if (process.platform === "win32" && (
    /[. ]$|:/.test(segment) ||
    /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(segment)
  )) {
    throw new Error("Unsupported Windows path.")
  }
}

export class Workspace {
  private constructor(readonly root: string, private readonly dataDir: string) {}

  static async open(root: string, dataDir: string): Promise<Workspace> {
    const actualRoot = await realpath(root)
    const actualData = await realpath(dataDir)
    if (!(await stat(actualRoot)).isDirectory() || isInside(actualData, actualRoot)) {
      throw new Error("Choose a workspace directory outside the CLI data directory.")
    }
    return new Workspace(actualRoot, actualData)
  }

  relative(target: string): string {
    return path.relative(this.root, target).split(path.sep).join("/") || "."
  }

  async resolve(requested: string, allowMissing = false): Promise<string> {
    if (requested.includes("\0") || (process.platform === "win32" &&
        (/^[\\/]{2}[?.][\\/]/.test(requested) || /^[a-z]:(?![\\/])/i.test(requested)))) {
      throw new Error("Unsupported path.")
    }
    const target = path.resolve(this.root, requested)
    if (!isInside(this.root, target) || isInside(this.dataDir, target)) {
      throw new Error("Path is outside the permitted workspace or belongs to CLI data.")
    }
    const segments = path.relative(this.root, target).split(path.sep).filter(Boolean)
    for (const segment of segments) {
      assertWindowsSegment(segment)
      if (protectedName(segment)) throw new Error("Path is protected.")
    }
    let cursor = this.root
    for (const segment of segments) {
      cursor = path.join(cursor, segment)
      const info = await lstat(cursor).catch((error: unknown) => {
        if (allowMissing && isMissing(error)) return undefined
        throw error
      })
      if (!info) break
      if (info.isSymbolicLink()) throw new Error("Symbolic links and junctions are outside file-tool access.")
      const actual = await realpath(cursor)
      const actualSegments = path.relative(this.root, actual).split(path.sep).filter(Boolean)
      if (!isInside(this.root, actual) || isInside(this.dataDir, actual) ||
          actualSegments.some(protectedName)) {
        throw new Error("Resolved path is protected or outside the workspace.")
      }
    }
    return target
  }

  async withWriteLock(target: string, callback: () => Promise<void>): Promise<void> {
    const identity = process.platform === "win32" ? target.toLowerCase() : target
    const directory = path.join(this.dataDir, "writes")
    await mkdir(directory, { recursive: true })
    const resource = path.join(directory, createHash("sha256").update(identity).digest("hex"))
    const release = await lockfile.lock(resource, { realpath: false, stale: 30_000 })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ELOCKED") throw new Error("Another session is writing this file. Read it again before retrying.")
        throw error
      })
    try {
      await callback()
    } finally {
      await release()
    }
  }

  async *files(start: string, signal: AbortSignal): AsyncGenerator<string> {
    const root = await this.resolve(start)
    if ((await stat(root)).isFile()) {
      yield root
      return
    }
    const directories = [root]
    let visited = 0
    while (directories.length) {
      signal.throwIfAborted()
      const directory = await this.resolve(directories.pop()!)
      const entries = await opendir(directory)
      for await (const entry of entries) {
        signal.throwIfAborted()
        if (++visited > 20_000) throw new Error("Scan limit reached. Narrow the search to a subdirectory.")
        const target = path.join(directory, entry.name)
        if (entry.isSymbolicLink() || protectedName(entry.name) || isInside(this.dataDir, target)) continue
        if (entry.isDirectory()) directories.push(target)
        if (entry.isFile()) yield target
      }
    }
  }
}
