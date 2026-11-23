// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

export function estimateTokens(text: string): number {
  if (!text) return 0

  const cjkMatches = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
  const cjkChars = cjkMatches?.length ?? 0
  const nonCjkChars = Math.max(0, text.length - cjkChars)
  const estimate = cjkChars * 1.05 + nonCjkChars / 3.7
  return Math.max(1, Math.ceil(estimate))
}

export function estimateMessageTokens(content: string): number {
  return estimateTokens(content) + 4
}
