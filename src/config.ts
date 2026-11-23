// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import { randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import lockfile from "proper-lockfile"
import { z } from "zod"
import type { ModelConfig } from "./types.js"
import { isMissing, writeAtomic } from "./util.js"

export function dataDirectory(): string {
  return path.resolve(process.env.STRINGCODE_HOME ||
    path.join(process.env.LOCALAPPDATA || homedir(), "StringCodeCLI"))
}

export function normalizeBaseUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error("Provide an absolute HTTP(S) API base URL.")
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) API base URL without credentials, query parameters, or fragments.")
  }
  const suffix = url.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|models)$/i, "")
  return url.origin + suffix
}

const configSchema = z.strictObject({
  baseUrl: z.string().trim().min(1).max(2048),
  model: z.string().trim().min(1).max(256),
  contextWindow: z.number().int().min(1024).max(10_000_000).optional(),
})

export interface Provider extends ModelConfig {
  id: string
  name: string
}

const profileSchema = configSchema.extend({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(80),
})
const registrySchema = z.strictObject({
  version: z.literal(1),
  activeId: z.string(),
  providers: z.array(profileSchema).min(1),
})

interface ProviderRegistry {
  version: 1
  activeId: string
  providers: Provider[]
}

export function newProvider(value: unknown, name?: string): Provider {
  const parsed = configSchema.safeParse(value)
  if (!parsed.success) throw new Error("Provide a base URL, model ID, and an optional context window from 1024 to 10000000.")
  const baseUrl = normalizeBaseUrl(parsed.data.baseUrl)
  return { ...parsed.data, baseUrl, id: randomUUID(), name: name?.trim().slice(0, 80) || new URL(baseUrl).hostname }
}

export class ProviderStore {
  private readonly file: string

  constructor(private readonly dataDir: string) {
    this.file = path.join(dataDir, "config.json")
  }

  private async read(): Promise<ProviderRegistry | undefined> {
    const text = await readFile(this.file, "utf8").catch((error: unknown) => {
      if (isMissing(error)) return undefined
      throw error
    })
    if (text === undefined) return
    try {
      const value: unknown = JSON.parse(text)
      const legacy = configSchema.safeParse(value)
      if (legacy.success) {
        const baseUrl = normalizeBaseUrl(legacy.data.baseUrl)
        return {
          version: 1, activeId: "legacy",
          providers: [{ ...legacy.data, baseUrl, id: "legacy", name: new URL(baseUrl).hostname }],
        }
      }
      const registry = registrySchema.parse(value)
      if (new Set(registry.providers.map(({ id }) => id)).size !== registry.providers.length ||
          !registry.providers.some(({ id }) => id === registry.activeId)) throw new Error()
      return { ...registry, providers: registry.providers.map((profile) => ({
        ...profile, baseUrl: normalizeBaseUrl(profile.baseUrl),
      })) }
    } catch {
      throw new Error("Invalid config.json. Check the provider settings file.")
    }
  }

  async list(): Promise<Provider[]> {
    return (await this.read())?.providers ?? []
  }

  async current(): Promise<Provider | undefined> {
    const registry = await this.read()
    return registry?.providers.find(({ id }) => id === registry.activeId)
  }

  async select(profile: Provider): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    const release = await lockfile.lock(this.file, { realpath: false, retries: 3 })
    try {
      const registry = await this.read()
      const providers = [...(registry?.providers ?? [])]
      const index = providers.findIndex(({ id }) => id === profile.id)
      if (index < 0) providers.push(profile)
      else providers[index] = profile
      await writeAtomic(this.file, JSON.stringify({ version: 1, activeId: profile.id, providers }, null, 2) + "\n")
    } finally {
      await release()
    }
  }
}
