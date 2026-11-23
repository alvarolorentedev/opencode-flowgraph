import { promises as fs, statSync } from "node:fs"
import path from "node:path"

export type WorkflowRootSource = "explicit" | "neutral" | "legacy"

export type ResolvedWorkflowRoot = {
  root: string
  relativeRoot: string
  source: WorkflowRootSource
  warning?: string
}

export const NEUTRAL_WORKFLOW_DIR = ".flowgraph/workflows"
export const LEGACY_WORKFLOW_DIR = ".opencode/workflows"

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * Resolve a target through the real path of its nearest existing ancestor and
 * append the missing components. Callers compare the result with the real
 * project directory before reading or creating anything, so a symlinked
 * ancestor cannot redirect writes outside the project.
 */
export async function resolvePhysicalPath(target: string): Promise<string> {
  const missing: string[] = []
  let current = path.resolve(target)
  for (;;) {
    try {
      const real = await fs.realpath(current)
      return path.join(real, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

function relative(projectDirectory: string, target: string): string {
  return (path.relative(projectDirectory, target) || ".").split(path.sep).join("/")
}

/**
 * Precedence: explicit override, existing neutral directory, legacy directory,
 * then the neutral directory for new installs. The two directories are never
 * merged; the legacy one only supplies a warning so users can move files.
 */
export function resolveWorkflowRoot(input: {
  projectDirectory: string
  workflowDir?: string
}): ResolvedWorkflowRoot {
  const projectDirectory = path.resolve(input.projectDirectory)
  if (input.workflowDir !== undefined) {
    const root = path.resolve(projectDirectory, input.workflowDir)
    return { root, relativeRoot: relative(projectDirectory, root), source: "explicit" }
  }

  const neutral = path.join(projectDirectory, NEUTRAL_WORKFLOW_DIR)
  const legacy = path.join(projectDirectory, LEGACY_WORKFLOW_DIR)
  const neutralExists = isDirectory(neutral)
  const legacyExists = isDirectory(legacy)

  if (neutralExists) {
    return {
      root: neutral,
      relativeRoot: NEUTRAL_WORKFLOW_DIR,
      source: "neutral",
      ...(legacyExists
        ? {
            warning:
              "both dirs exist; using .flowgraph/workflows. .opencode/workflows is ignored, not merged.",
          }
        : {}),
    }
  }
  if (legacyExists) {
    return {
      root: legacy,
      relativeRoot: LEGACY_WORKFLOW_DIR,
      source: "legacy",
      warning:
        ".flowgraph/workflows not found; using legacy .opencode/workflows. " +
        "Move workflow files to .flowgraph/workflows to share them (files are not merged).",
    }
  }
  return { root: neutral, relativeRoot: NEUTRAL_WORKFLOW_DIR, source: "neutral" }
}
