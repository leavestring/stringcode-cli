// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { isMissing, subprocessEnvironment, writeAtomic } from "./util.js"

export interface CredentialOwner {
  id: string
  baseUrl: string
}

const worker = (operation: "Protect" | "Unprotect") => [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())",
  "$output = [Security.Cryptography.ProtectedData]::" + operation + "(" +
    "$bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Write([Convert]::ToBase64String($output))",
].join("\r\n")

function dpapi(data: Buffer, operation: "Protect" | "Unprotect"): Promise<Buffer> {
  const shell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const script = Buffer.from(worker(operation), "utf16le").toString("base64")
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script],
      { windowsHide: true, env: subprocessEnvironment(), stdio: ["pipe", "pipe", "ignore"] })
    const timer = setTimeout(() => child.kill(), 8_000)
    let output = ""
    child.stdout.setEncoding("ascii").on("data", (chunk: string) => { output += chunk })
    child.on("error", () => {
      clearTimeout(timer)
      reject(new Error("Windows credential storage is unavailable."))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(output)) {
        reject(new Error("Windows credential storage is unavailable."))
      } else {
        resolve(Buffer.from(output, "base64"))
      }
    })
    child.stdin.on("error", () => {})
    child.stdin.end(data.toString("base64"), "ascii")
  })
}

export class Credentials {
  private readonly cache = new Map<string, string>()
  private readonly envKey = process.env.STRINGCODE_API_KEY?.trim()
  private envOwner?: string
  private readonly directory: string

  constructor(dataDir: string) {
    this.directory = path.join(dataDir, "credentials")
  }

  private name(owner: CredentialOwner): string {
    return createHash("sha256").update(JSON.stringify([owner.id, owner.baseUrl])).digest("hex")
  }

  useEnvironmentFor(owner: CredentialOwner): void {
    this.envOwner ??= this.name(owner)
  }

  async read(owner: CredentialOwner): Promise<string | undefined> {
    const name = this.name(owner)
    const cached = this.cache.get(name)
    if (cached) return cached
    if (this.envOwner === name && this.envKey) return this.envKey
    if (process.platform !== "win32") return
    const ciphertext = await readFile(path.join(this.directory, name + ".dpapi")).catch((error: unknown) => {
      if (isMissing(error)) return undefined
      throw error
    })
    if (!ciphertext) return
    const plain = await dpapi(ciphertext, "Unprotect")
    try {
      const apiKey = plain.toString("utf8")
      this.cache.set(name, apiKey)
      return apiKey
    } finally {
      plain.fill(0)
    }
  }

  async remember(owner: CredentialOwner, apiKey: string, entered: boolean): Promise<boolean> {
    const name = this.name(owner)
    this.cache.set(name, apiKey)
    if (!entered || process.platform !== "win32") return false
    const keyBytes = Buffer.from(apiKey, "utf8")
    try {
      const ciphertext = await dpapi(keyBytes, "Protect")
      await mkdir(this.directory, { recursive: true })
      await writeAtomic(path.join(this.directory, name + ".dpapi"), ciphertext)
      return true
    } finally {
      keyBytes.fill(0)
    }
  }

  async forget(owner: CredentialOwner): Promise<void> {
    const name = this.name(owner)
    await rm(path.join(this.directory, name + ".dpapi"), { force: true })
    this.cache.delete(name)
  }
}
