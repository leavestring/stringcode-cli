// SPDX-License-Identifier: GPL-3.0-only
// See NOTICE for author attribution and GPLv3 section 7 terms.

import { spawn } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { subprocessEnvironment } from "./util.js"
import { isInside } from "./workspace.js"

const outputLimit = 24_000

interface ShellResult {
  code: number | null
  signal: NodeJS.Signals | null
  reason?: "timeout" | "canceled"
  output: string
}

function runPowerShell(executable: string, command: string, cwd: string, signal: AbortSignal, timeoutMs: number, apiKey: string): Promise<ShellResult> {
  signal.throwIfAborted()
  const script = [
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    "$global:LASTEXITCODE = 0",
    "& {",
    command,
    "}",
    "if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }",
    "exit $LASTEXITCODE",
  ].join("\r\n")
  const env = subprocessEnvironment(apiKey)
  const encoded = Buffer.from(script, "utf16le").toString("base64")
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", encoded], {
    cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  })

  return new Promise<ShellResult>((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let truncated = false
    let reason: ShellResult["reason"]
    let grace: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const collect = (chunks: Buffer[], chunk: Buffer) => {
      const available = Math.max(0, outputLimit - bytes)
      if (chunk.length > available) truncated = true
      if (available > 0) chunks.push(chunk.subarray(0, available))
      bytes += Math.min(available, chunk.length)
    }
    const finish = (code: number | null, exitSignal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      signal.removeEventListener("abort", cancel)
      if (error) {
        reject(error)
        return
      }
      const output = [
        Buffer.concat(stdout).toString("utf8").trimEnd(),
        stderr.length ? "[stderr]\n" + Buffer.concat(stderr).toString("utf8").trimEnd() : "",
        truncated ? "[Output truncated]" : "",
      ].filter(Boolean).join("\n")
      resolve({ code, signal: exitSignal, reason, output })
    }
    const stop = (cause: NonNullable<ShellResult["reason"]>) => {
      if (settled || reason) return
      reason = cause
      if (child.pid && process.platform === "win32") {
        const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe")
        const killTree = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], { env, windowsHide: true, stdio: "ignore" })
        killTree.on("error", () => child.kill())
        killTree.on("exit", (code) => { if (code !== 0) child.kill() })
      } else {
        child.kill()
      }
      grace = setTimeout(() => {
        child.kill()
        child.stdout.destroy()
        child.stderr.destroy()
        finish(null, null)
      }, 2_000)
    }
    const cancel = () => stop("canceled")
    const timer = setTimeout(() => stop("timeout"), timeoutMs)
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk))
    child.once("error", (error) => finish(null, null, error))
    child.once("close", (code, exitSignal) => finish(code, exitSignal))
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted) cancel()
  })
}

async function findWindowsShell(workspaceRoot: string): Promise<string> {
  const directories = [
    ...(process.env.ProgramFiles ? [path.join(process.env.ProgramFiles, "PowerShell", "7")] : []),
    ...(process.env.PATH ?? "").split(path.delimiter),
  ]
  for (const entry of directories) {
    const directory = entry.replace(/^"(.*)"$/, "$1")
    if (!path.isAbsolute(directory)) continue
    const executable = await realpath(path.join(directory, "pwsh.exe")).catch(() => undefined)
    if (executable && !isInside(workspaceRoot, executable) &&
        (await stat(executable).catch(() => undefined))?.isFile()) return executable
  }
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

export async function executeShell(
  command: string, cwd: string, workspaceRoot: string, signal: AbortSignal, timeoutMs: number, apiKey: string,
): Promise<string> {
  const executable = process.platform === "win32" ? await findWindowsShell(workspaceRoot) : "pwsh"
  const result = await runPowerShell(executable, command, cwd, signal, timeoutMs, apiKey)
  signal.throwIfAborted()
  const status = result.reason === "timeout" ? "Shell timed out after " + timeoutMs +
    " ms. Check for partial files or checkpoints. If more work is needed, run a smaller sample or batch before retrying the full command."
    : "Exit: " + (result.code ?? result.signal ?? "unknown")
  return result.output ? status + "\n" + result.output : status
}
