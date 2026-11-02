import path from "node:path"
import type { OpenCodePluginContext } from "./native-agents.js"
import type { InvocationRegistry } from "./report-tool.js"

export type ToolHookOptions = {
  allowBackgroundWork: boolean
  protectedPaths?: string[]
}

const DEFAULT_PROTECTED_PATHS = [
  ".opencode",
  "opencode.json",
  "opencode.jsonc",
  "AGENTS.md",
  ".git",
  ".github",
]

const FILE_TOOLS = new Set(["edit", "write", "patch", "apply_patch"])
const PATCH_PATH = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu
const PATCH_MOVE = /^\*\*\* Move to: (.+)$/gmu
const MUTATION =
  /(?:^|[;&|]\s*|\s)(?:rm|rmdir|mv|cp|install|truncate|shred|tee)\b|(?:^|\s)sed\s+-[a-z]*i\b|(?:^|\s)perl\s+-[a-z]*i\b|find\b[^\n]*(?:-delete|-exec\s+rm)\b|git\s+(?:rm|clean|reset\s+--hard|restore|checkout\s+--)\b/iu

function resolve(root: string, candidate: string): string {
  return path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(root, candidate)
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function protectedMatch(root: string, candidate: string, protectedPaths: string[]): string | undefined {
  const absolute = resolve(root, candidate)
  for (const entry of protectedPaths) {
    if (inside(resolve(root, entry), absolute)) return entry
  }
  return undefined
}

function filePaths(tool: string, input: unknown): string[] {
  if (input === null || typeof input !== "object") return []
  const record = input as Record<string, unknown>

  if (tool === "patch" || tool === "apply_patch") {
    const text = typeof record.patchText === "string" ? record.patchText : typeof record.patch === "string" ? record.patch : ""
    return [
      ...Array.from(text.matchAll(PATCH_PATH), (match) => match[1]!.trim()),
      ...Array.from(text.matchAll(PATCH_MOVE), (match) => match[1]!.trim()),
    ]
  }

  const candidate = record.path ?? record.filePath ?? record.file_path
  return typeof candidate === "string" ? [candidate] : []
}

function shellViolation(root: string, input: unknown, protectedPaths: string[]): string | undefined {
  if (input === null || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  const command = typeof record.command === "string" ? record.command : ""
  if (command.length === 0) return undefined

  const workdir = typeof record.workdir === "string" ? resolve(root, record.workdir) : root
  const mentionsProtected = protectedPaths.some((entry) => command.includes(entry))
  const mutates = MUTATION.test(command) || /(?:^|[^>])>{1,2}\s*\S+/u.test(command)
  if (mentionsProtected && mutates) {
    return protectedPaths.find((entry) => command.includes(entry))
  }

  if (/(?:^|[;&|]\s*)git\s+(?:clean|reset\s+--hard|restore\s+\.|checkout\s+--\s+\.)\b/iu.test(command)) {
    return "."
  }
  if (/(?:^|[;&|]\s*)rm\s+-[a-z]*r[a-z]*f[a-z]*\s+\.(?:\s|$)/iu.test(command)) {
    return "."
  }

  if (mutates) {
    return protectedPaths.find((entry) => inside(resolve(root, entry), workdir))
  }
  return undefined
}

export async function registerToolHooks(
  ctx: OpenCodePluginContext,
  invocations: InvocationRegistry,
  options: ToolHookOptions,
): Promise<void> {
  const root = ctx.location.project.directory
  const protectedPaths = [...DEFAULT_PROTECTED_PATHS, ...(options.protectedPaths ?? [])]

  await ctx.tool.hook("execute.before", (event) => {
    if (!invocations.has(event.sessionID)) return

    if (FILE_TOOLS.has(event.tool)) {
      for (const candidate of filePaths(event.tool, event.input)) {
        const protectedPath = protectedMatch(root, candidate, protectedPaths)
        if (protectedPath) {
          throw new Error(
            `workflow nodes cannot modify protected configuration path "${protectedPath}" ` +
              `(tool "${event.tool}", path "${candidate}"). Make the change in a normal session.`,
          )
        }
      }
    }

    if (event.tool === "shell") {
      const protectedPath = shellViolation(root, event.input, protectedPaths)
      if (protectedPath) {
        throw new Error(
          `workflow nodes cannot run a destructive shell command against protected configuration path "${protectedPath}". ` +
            `Make the change in a normal session.`,
        )
      }
    }

    if (options.allowBackgroundWork) return
    if (event.tool !== "subagent" && event.tool !== "shell") return
    const input = event.input as { background?: unknown } | undefined
    if (input?.background === true) {
      throw new Error(
        `background ${event.tool} execution is disabled inside workflow nodes because it would outlive the sequential node. ` +
          `Use foreground execution or set the plugin option allowBackgroundWork=true.`,
      )
    }
  })
}
