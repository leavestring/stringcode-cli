// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import { open } from "node:fs/promises"
import path from "node:path"
import { parse } from "yaml"
import type { Skill } from "./types.js"
import { readBounded } from "./util.js"
import type { Workspace } from "./workspace.js"

export async function loadSkill(workspace: Workspace, requested: string): Promise<Skill> {
  const target = await workspace.resolve(requested)
  if (path.basename(target).toUpperCase() !== "SKILL.MD") throw new Error("Choose a workspace SKILL.md file.")
  const handle = await open(target, "r")
  let markdown: string
  try {
    const buffer = await readBounded(handle, 64_000)
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/\r\n/g, "\n")
  } finally {
    await handle.close()
  }

  let name = path.basename(path.dirname(target))
  let description = ""
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  const content = markdown.slice(frontmatter?.[0].length ?? 0).trim()
  if (frontmatter) {
    const data: unknown = parse(frontmatter[1], { maxAliasCount: 0 })
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid SKILL.md frontmatter.")
    if ("name" in data && typeof data.name === "string" && data.name.trim()) name = data.name.trim()
    if ("description" in data && typeof data.description === "string") description = data.description.trim()
  }
  if (!content) throw new Error("SKILL.md must contain instructions.")
  if (name.length > 100 || /[\r\n]/.test(name)) throw new Error("Invalid skill name.")
  return { name, description: description.slice(0, 300), path: workspace.relative(target), content }
}
