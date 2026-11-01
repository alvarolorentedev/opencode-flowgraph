import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { isAlias, isMap, isPair, isSeq, parseAllDocuments, type Document } from "yaml"
import { z } from "zod"
import {
  HARD_LIMITS,
  WorkflowIdSchema,
  WorkflowSchema,
  type WorkflowDefinition,
} from "./schema.js"
import type { Diagnostic } from "./graph.js"

export class WorkflowFileError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message)
    this.name = "WorkflowFileError"
  }
}

export type ParsedWorkflow = {
  workflow?: WorkflowDefinition
  errors: Diagnostic[]
  warnings: string[]
}

export type WorkflowFile = {
  id: string
  hash: string
  source: string
  workflow?: WorkflowDefinition
  errors: Diagnostic[]
  warnings: string[]
  size: number
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function zodDiagnostics(error: z.ZodError): Diagnostic[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message.slice(0, 2_000),
    code: issue.code,
  }))
}

function containsAlias(node: unknown): boolean {
  if (isAlias(node)) return true
  if (isMap(node)) {
    for (const pair of node.items) {
      if (isPair(pair) && containsAlias(pair.key)) return true
      if (isPair(pair) && containsAlias(pair.value)) return true
    }
  }
  if (isSeq(node)) {
    for (const item of node.items) if (containsAlias(item)) return true
  }
  return false
}

function containsMergeKey(node: unknown): boolean {
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isPair(pair)) continue
      if (isAlias(pair.key)) continue
      const key = pair.key as { value?: unknown }
      if (key && key.value === "<<") return true
      if (containsMergeKey(pair.value)) return true
    }
  }
  if (isSeq(node)) {
    for (const item of node.items) if (containsMergeKey(item)) return true
  }
  return false
}

function assertSafeKeys(value: unknown, pathParts: string[] = []): Diagnostic[] {
  const errors: Diagnostic[] = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => errors.push(...assertSafeKeys(item, [...pathParts, String(index)])))
    return errors
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        errors.push({
          path: [...pathParts, key].join(".") || key,
          message: `unsafe object key "${key}"`,
          code: "unsafe_key",
        })
        continue
      }
      errors.push(...assertSafeKeys((value as Record<string, unknown>)[key], [...pathParts, key]))
    }
  }
  return errors
}

function documentErrors(document: Document, id?: string): Diagnostic[] {
  const errors: Diagnostic[] = []
  for (const error of document.errors) {
    errors.push({
      path: id === undefined ? "document" : "document",
      message: error.message.slice(0, 2_000),
      code: "yaml_parse",
    })
  }
  return errors
}

export function parseWorkflowSource(
  source: string,
  options: { workflowID?: string } = {},
): ParsedWorkflow {
  const bytes = Buffer.byteLength(source, "utf8")
  if (bytes > HARD_LIMITS.maxWorkflowBytes) {
    return {
      errors: [
        {
          path: "(document)",
          message: `workflow file exceeds ${HARD_LIMITS.maxWorkflowBytes} bytes`,
          code: "oversized_document",
        },
      ],
      warnings: [],
    }
  }
  if (source.split(/\r\n|\r|\n/u).length > HARD_LIMITS.maxWorkflowLines) {
    return {
      errors: [
        {
          path: "(document)",
          message: `workflow file exceeds ${HARD_LIMITS.maxWorkflowLines} lines`,
          code: "oversized_document",
        },
      ],
      warnings: [],
    }
  }

  let documents: Document[]
  try {
    documents = parseAllDocuments(source, {
      schema: "core",
      version: "1.2",
      uniqueKeys: true,
      merge: false,
      customTags: [],
    })
  } catch (error) {
    return {
      errors: [
        {
          path: "(document)",
          message: error instanceof Error ? error.message : "invalid YAML",
          code: "yaml_parse",
        },
      ],
      warnings: [],
    }
  }

  if (documents.length !== 1) {
    return {
      errors: [
        {
          path: "(document)",
          message: "workflow YAML must contain exactly one document",
          code: "multi_document",
        },
      ],
      warnings: [],
    }
  }

  const document = documents[0]!
  const yamlErrors = documentErrors(document)
  if (yamlErrors.length > 0) return { errors: yamlErrors, warnings: [] }

  if (containsAlias(document.contents)) {
    return {
      errors: [
        {
          path: "(document)",
          message: "YAML anchors and aliases are not supported in workflow files",
          code: "yaml_alias",
        },
      ],
      warnings: [],
    }
  }
  if (containsMergeKey(document.contents)) {
    return {
      errors: [
        {
          path: "(document)",
          message: "YAML merge keys are not supported in workflow files",
          code: "yaml_merge",
        },
      ],
      warnings: [],
    }
  }

  let value: unknown
  try {
    value = document.toJS({ maxAliasCount: 0 })
  } catch (error) {
    return {
      errors: [
        {
          path: "(document)",
          message: error instanceof Error ? error.message : "invalid YAML value",
          code: "yaml_value",
        },
      ],
      warnings: [],
    }
  }

  const unsafe = assertSafeKeys(value)
  if (unsafe.length > 0) return { errors: unsafe, warnings: [] }

  const parsed = WorkflowSchema.safeParse(value)
  if (!parsed.success) {
    return { errors: zodDiagnostics(parsed.error), warnings: [] }
  }

  if (options.workflowID !== undefined) {
    const id = WorkflowIdSchema.safeParse(options.workflowID)
    if (!id.success) {
      return {
        errors: [
          {
            path: "workflowID",
            message: "workflow ID is not a valid slug",
            code: "invalid_workflow_id",
          },
        ],
        warnings: [],
      }
    }
    if (parsed.data.name !== options.workflowID) {
      return {
        errors: [
          {
            path: "name",
            message: `workflow name "${parsed.data.name}" must match file stem "${options.workflowID}"`,
            code: "name_mismatch",
          },
        ],
        warnings: [],
      }
    }
  }

  const warnings: string[] = []
  const limits = parsed.data.limits
  if (limits.node_timeout_seconds !== undefined && limits.node_timeout_seconds > limits.timeout_seconds) {
    warnings.push("node_timeout_seconds is greater than timeout_seconds; the run timeout will win")
  }
  return { workflow: parsed.data, errors: [], warnings }
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function realOrResolved(target: string): Promise<string> {
  try {
    return await fs.realpath(target)
  } catch {
    return path.resolve(target)
  }
}

export class WorkflowRepository {
  readonly root: string
  private readonly projectDirectory: string

  constructor(projectDirectory: string) {
    this.projectDirectory = path.resolve(projectDirectory)
    this.root = path.join(this.projectDirectory, ".opencode", "workflows")
  }

  private validateId(workflowID: string): string {
    const parsed = WorkflowIdSchema.safeParse(workflowID)
    if (!parsed.success) {
      throw new WorkflowFileError("invalid workflow ID", "invalid_workflow_id")
    }
    return workflowID
  }

  private async ensureRoot(create: boolean): Promise<{ projectReal: string; rootReal: string }> {
    const projectReal = await fs.realpath(this.projectDirectory).catch(() => this.projectDirectory)
    if (create) await fs.mkdir(this.root, { recursive: true })
    const rootReal = await fs.realpath(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new WorkflowFileError("workflow not found", "not_found")
      throw error
    })
    if (!inside(projectReal, rootReal)) {
      throw new WorkflowFileError("workflow directory resolves outside the project", "unsafe_path")
    }
    return { projectReal, rootReal }
  }

  private async safeExistingPath(workflowID: string): Promise<{ file: string; rootReal: string; projectReal: string }> {
    const id = this.validateId(workflowID)
    const { projectReal, rootReal } = await this.ensureRoot(false)
    const file = path.join(rootReal, `${id}.yaml`)
    let info
    try {
      info = await fs.lstat(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new WorkflowFileError("workflow not found", "not_found")
      }
      throw error
    }
    if (info.isSymbolicLink()) {
      throw new WorkflowFileError("workflow files must not be symlinks", "unsafe_path")
    }
    if (!info.isFile()) {
      throw new WorkflowFileError("workflow path is not a regular file", "unsafe_path")
    }
    const real = await fs.realpath(file)
    if (!inside(rootReal, real)) {
      throw new WorkflowFileError("workflow path resolves outside the workflow directory", "unsafe_path")
    }
    return { file, rootReal, projectReal }
  }

  async listIDs(): Promise<string[]> {
    let entries
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const ids: string[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith(".yaml")) continue
      const id = entry.name.slice(0, -".yaml".length)
      if (!WorkflowIdSchema.safeParse(id).success) continue
      ids.push(id)
    }
    ids.sort()
    return ids.slice(0, HARD_LIMITS.maxWorkflows)
  }

  async read(workflowID: string): Promise<WorkflowFile> {
    const { file } = await this.safeExistingPath(workflowID)
    const info = await fs.stat(file)
    if (info.size > HARD_LIMITS.maxWorkflowBytes) {
      throw new WorkflowFileError("workflow file is too large", "oversized_document")
    }
    const source = await fs.readFile(file, "utf8")
    const hash = sha256(source)
    const parsed = parseWorkflowSource(source, { workflowID })
    return {
      id: workflowID,
      hash,
      source,
      workflow: parsed.workflow,
      errors: parsed.errors,
      warnings: parsed.warnings,
      size: info.size,
    }
  }

  async save(
    workflowID: string,
    source: string,
    expectedHash: string | null,
    backup?: (previousSource: string, hash: string) => Promise<void>,
  ): Promise<{ id: string; hash: string; bytes: number }> {
    const parsed = parseWorkflowSource(source, { workflowID })
    if (!parsed.workflow) {
      throw new WorkflowFileError("workflow validation failed", "invalid_workflow", parsed.errors)
    }
    const { file, rootReal } = await this.safeExistingPathOrMissing(workflowID)

    let existing: string | undefined
    try {
      existing = await fs.readFile(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }

    if (expectedHash === null) {
      if (existing !== undefined) {
        throw new WorkflowFileError("workflow already exists; expectedHash must match", "stale_revision")
      }
    } else {
      if (existing === undefined) {
        throw new WorkflowFileError("workflow does not exist; expectedHash must be null", "stale_revision")
      }
      const currentHash = sha256(existing)
      if (currentHash !== expectedHash) {
        throw new WorkflowFileError("workflow changed since it was read", "stale_revision")
      }
      if (backup) await backup(existing, currentHash)
    }

    const hash = sha256(source)
    const temp = path.join(rootReal, `.${workflowID}.${randomUUID()}.tmp`)
    let handle
    try {
      handle = await fs.open(temp, "wx", 0o600)
      await handle.writeFile(source, "utf8")
      await handle.sync()
      await handle.close()
      handle = undefined
      await fs.rename(temp, file)
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      await fs.unlink(temp).catch(() => undefined)
      throw new WorkflowFileError(
        `unable to atomically write workflow: ${error instanceof Error ? error.message : "unknown error"}`,
        "unsafe_platform",
      )
    }
    return { id: workflowID, hash, bytes: Buffer.byteLength(source, "utf8") }
  }

  private async safeExistingPathOrMissing(
    workflowID: string,
  ): Promise<{ file: string; rootReal: string; projectReal: string }> {
    const id = this.validateId(workflowID)
    const { projectReal, rootReal } = await this.ensureRoot(true)
    const file = path.join(rootReal, `${id}.yaml`)
    try {
      const info = await fs.lstat(file)
      if (info.isSymbolicLink()) {
        throw new WorkflowFileError("workflow files must not be symlinks", "unsafe_path")
      }
      if (!info.isFile()) {
        throw new WorkflowFileError("workflow path is not a regular file", "unsafe_path")
      }
      const real = await fs.realpath(file)
      if (!inside(rootReal, real)) {
        throw new WorkflowFileError("workflow path resolves outside the workflow directory", "unsafe_path")
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return { file, rootReal, projectReal }
  }

  async delete(
    workflowID: string,
    expectedHash: string,
    backup?: (previousSource: string, hash: string) => Promise<void>,
  ): Promise<void> {
    const { file } = await this.safeExistingPath(workflowID)
    const existing = await fs.readFile(file, "utf8")
    const currentHash = sha256(existing)
    if (currentHash !== expectedHash) {
      throw new WorkflowFileError("workflow changed since it was read", "stale_revision")
    }
    if (backup) await backup(existing, currentHash)
    await fs.unlink(file)
  }
}
