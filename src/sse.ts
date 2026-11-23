// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

export interface ServerSentEvent {
  event: string
  data: string
}

function findBoundary(buffer: string): {
  index: number
  length: number
} | null {
  const lf = buffer.indexOf("\n\n")
  const crlf = buffer.indexOf("\r\n\r\n")

  if (lf === -1 && crlf === -1) return null
  if (crlf === -1 || (lf !== -1 && lf < crlf)) {
    return { index: lf, length: 2 }
  }
  return { index: crlf, length: 4 }
}

export function parseServerSentEvent(block: string): ServerSentEvent | null {
  const normalized = block.replace(/^\uFEFF/, "")
  let event = "message"
  const data: string[] = []

  for (const line of normalized.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue
    const separator = line.indexOf(":")
    const field = separator === -1 ? line : line.slice(0, separator)
    let value = separator === -1 ? "" : line.slice(separator + 1)
    if (value.startsWith(" ")) value = value.slice(1)

    if (field === "event") event = value
    if (field === "data") data.push(value)
  }

  if (data.length === 0) return null
  return { event, data: data.join("\n") }
}

export async function* readServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > 8 * 1024 * 1024) throw new Error("Model stream frame exceeded the response limit.")

      let boundary = findBoundary(buffer)
      while (boundary) {
        const block = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        const parsed = parseServerSentEvent(block)
        if (parsed) yield parsed
        boundary = findBoundary(buffer)
      }
    }

    buffer += decoder.decode()
    const parsed = parseServerSentEvent(buffer)
    if (parsed) yield parsed
  } finally {
    reader.releaseLock()
  }
}

export async function* readJsonLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > 8 * 1024 * 1024) throw new Error("Model stream frame exceeded the response limit.")

      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "").trim()
        buffer = buffer.slice(newline + 1)
        if (line) yield line
        newline = buffer.indexOf("\n")
      }
    }

    buffer += decoder.decode()
    if (buffer.trim()) yield buffer.trim()
  } finally {
    reader.releaseLock()
  }
}
