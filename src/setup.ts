// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import { stdin, stdout } from "node:process"
import { normalizeBaseUrl, newProvider, type Provider } from "./config.js"
import { fetchModelIds } from "./model.js"
import type { Terminal } from "./terminal.js"
import { messageOf } from "./util.js"

export function canRunSetup(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY)
}

export function checkConfigForKey(config: { baseUrl?: string; model?: string }, key: string | undefined): void {
  if (!key) return
  const url = URL.parse(config.baseUrl?.trim() ?? "")
  const pathContainsKey = key.length >= 8 && url?.pathname.split("/").some((part) => {
    if (part === key) return true
    try {
      return decodeURIComponent(part) === key
    } catch {
      return false
    }
  })
  if (config.baseUrl?.trim() === key || pathContainsKey) {
    throw new Error("The API key is in the Base URL. Use the provider's address without the key.")
  }
  if (config.model?.trim() === key || (key.length >= 8 && config.model?.includes(key))) {
    throw new Error("The API key is in the model ID. Enter the model ID from your provider.")
  }
}

async function field(
  terminal: Terminal, label: string, signal: AbortSignal, validate: (value: string) => string,
): Promise<string | undefined> {
  while (!signal.aborted) {
    const answer = await terminal.ask(label, signal)
    if (answer === undefined) return
    try {
      return validate(answer.trim())
    } catch (error) {
      terminal.notice(messageOf(error))
    }
  }
}

function validKey(value: string): string {
  if (!value) throw new Error("API key is required.")
  if (/^https?:\/\//i.test(value)) throw new Error("That looks like a URL. Enter the API key from your provider.")
  return value
}

export async function promptKey(terminal: Terminal, baseUrl: string, signal: AbortSignal): Promise<string | undefined> {
  while (!signal.aborted) {
    const answer = await terminal.ask("API key (visible): ", signal, true)
    if (answer === undefined) return
    try {
      const apiKey = validKey(answer.trim())
      checkConfigForKey({ baseUrl }, apiKey)
      return apiKey
    } catch (error) {
      terminal.notice(messageOf(error))
    }
  }
}

export async function pickModel(
  terminal: Terminal, name: string, models: string[], credentials: { baseUrl: string; apiKey: string },
  current: string | undefined, signal: AbortSignal,
): Promise<string | undefined> {
  const ids = models.filter((model) => model !== credentials.apiKey &&
    (credentials.apiKey.length < 8 || !model.includes(credentials.apiKey)))
  if (current && !ids.includes(current)) ids.unshift(current)
  if (ids.length) {
    const options = ids.map((label, index) => ({
      id: String(index), label, detail: label === current ? "current" : undefined,
    }))
    const active = current !== undefined ? String(ids.indexOf(current)) : undefined
    const selected = await terminal.pick("Models / " + name,
      [...options, { id: "manual", label: "Enter a model ID…" }], active, signal)
    if (selected === undefined) return
    if (selected !== "manual") return ids[Number(selected)]
  } else {
    terminal.notice("The provider did not return a model list. Enter its model ID manually.")
  }
  return field(terminal, "Model ID: ", signal, (model) => {
    if (!model || model.length > 256) throw new Error("Enter a model ID of 1–256 characters.")
    checkConfigForKey({ baseUrl: credentials.baseUrl, model }, credentials.apiKey)
    return model
  })
}

export async function promptProvider(
  terminal: Terminal, signal: AbortSignal, options: { apiKey?: string; label?: boolean } = {},
): Promise<{ profile: Provider; apiKey: string; entered: boolean } | undefined> {
  const baseUrl = await field(terminal, "Base URL (e.g. https://provider.example/v1): ", signal, (value) => {
    if (value.length > 2048) throw new Error("Base URL must be 2048 characters or fewer.")
    return normalizeBaseUrl(value)
  })
  if (!baseUrl) return
  const hostname = new URL(baseUrl).hostname
  const name = options.label ? await field(terminal, "Provider name [" + hostname + "]: ", signal, (value) => {
    if (value.length > 80) throw new Error("Provider name must be 80 characters or fewer.")
    return value || hostname
  }) : hostname
  if (!name) return

  let apiKey = options.apiKey
  let entered = false
  while (!signal.aborted) {
    if (apiKey) {
      try {
        checkConfigForKey({ baseUrl }, validKey(apiKey))
      } catch (error) {
        terminal.notice(messageOf(error))
        apiKey = undefined
      }
    }
    if (!apiKey) {
      apiKey = await promptKey(terminal, baseUrl, signal)
      if (!apiKey) return
      entered = true
    }
    terminal.notice("Fetching available models…")
    const catalog = await fetchModelIds(baseUrl, apiKey, signal)
    if (catalog.status === "unauthorized") {
      terminal.notice("The provider rejected the API key. Enter another key, or press Ctrl+C to cancel.")
      apiKey = undefined
      continue
    }
    const model = await pickModel(terminal, name, catalog.status === "ok" ? catalog.models : [], { baseUrl, apiKey }, undefined, signal)
    if (model) return { profile: newProvider({ baseUrl, model }, name), apiKey, entered }
    return
  }
}
