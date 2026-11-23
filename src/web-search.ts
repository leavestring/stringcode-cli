// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import { z } from "zod"
import { clip, redact } from "./util.js"

const baseUrl = "https://api.anysearch.com"
const resultLimit = 5
const responseSchema = z.object({
  code: z.literal(0),
  data: z.object({
    results: z.array(z.object({
      title: z.string(), url: z.string(), snippet: z.string().nullish(), content: z.string().nullish(),
    })),
  }),
})

export const searchCredential = { id: "web-search:anysearch", baseUrl }
export type WebSearch = (query: string, signal: AbortSignal) => Promise<string>

function responseError(status: number, authenticated: boolean): string {
  switch (status) {
    case 401:
    case 403: return authenticated ? "AnySearch rejected the API key. Check /search key or ANYSEARCH_API_KEY."
      : "AnySearch denied anonymous access. Use /search key to configure an AnySearch API key."
    case 402: return authenticated ? "The AnySearch account has exhausted its search quota."
      : "The AnySearch anonymous quota is exhausted. Use /search key to configure an AnySearch API key."
    case 429: return "AnySearch rate limit reached. Try again later."
    default: return "AnySearch returned HTTP " + status + "."
  }
}

export function createWebSearch(apiKey = "", request: typeof fetch = fetch): WebSearch {
  return async (query, signal) => {
    if (apiKey && query.includes(apiKey)) throw new Error("The search query contains the search API key.")
    const timeout = AbortSignal.timeout(15_000)
    const requestSignal = AbortSignal.any([signal, timeout])
    const text = (value: string, length: number) => clip(redact(value, apiKey).replace(/\s+/gu, " ").trim(), length)
    let response: Response
    try {
      response = await request(baseUrl + "/v1/search", {
        method: "POST", redirect: "error", signal: requestSignal,
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}) },
        body: JSON.stringify({ query, max_results: resultLimit }),
      })
    } catch {
      signal.throwIfAborted()
      if (timeout.aborted) throw new Error("AnySearch timed out.")
      throw new Error("Could not connect to AnySearch.")
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error(responseError(response.status, Boolean(apiKey)))
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      signal.throwIfAborted()
      if (timeout.aborted) throw new Error("AnySearch timed out.")
      throw new Error("AnySearch returned invalid JSON.")
    }
    const parsed = responseSchema.safeParse(payload)
    if (!parsed.success) throw new Error("AnySearch returned an unexpected or unsuccessful response.")
    const results = parsed.data.data.results.slice(0, resultLimit).flatMap((result) => {
      const url = URL.parse(result.url)
      if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password ||
          url.href.length > 2_048 || (apiKey && url.href.includes(apiKey))) return []
      return [[text(result.title, 256) || url.hostname, url.href, text(result.snippet || result.content || "", 800)]
        .filter(Boolean).join("\n")]
    })
    if (!results.length) return "No web results."
    return ["Found " + results.length + (results.length === 1 ? " web result." : " web results."),
      ...results.map((result, index) => (index + 1) + ". " + result)].join("\n\n")
  }
}
