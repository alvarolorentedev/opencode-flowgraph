#!/usr/bin/env node
import { randomUUID } from "node:crypto"
import { promises as fs, realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { buildRunGraph } from "./execution/run-graph.js"
import { blockersOf } from "./execution/checkpoint.js"
import {
  HarnessCapabilitiesSchema,
  type HarnessAdapter,
} from "./execution/harness.js"
import {
  AmbiguousResumeError,
  InvalidHumanResponseError,
  NotResumableError,
  PermissionPendingError,
  RunNotFoundError,
  type HumanDecision,
} from "./execution/runner.js"
import { createFlowgraphRuntime, type FlowgraphRuntime, type HarnessAdapterContext } from "./runtime/create.js"
import { InvalidWorkflowError, WorkflowNotFoundError, validateWorkflowTree } from "./service.js"
import { FileSystemStoragePort, StorageKeyError } from "./storage/index.js"
import {
  RevisionConflictError,
  StateCorruptionError,
  WorkflowStore,
} from "./state/store.js"
import { summaryOf, type ProjectIdentity, type RunRecord, type RunStatus } from "./state/types.js"
import { errorMessage } from "./util/redact.js"
import { sha256 } from "./util/hash.js"
import { PLUGIN_VERSION } from "./version.js"
import { WorkflowFileError, WorkflowRepository } from "./workflow/loader.js"
import { isInside, resolvePhysicalPath } from "./workflow/root.js"
import type { Diagnostic } from "./workflow/graph.js"
import { objectiveLabel } from "./server-command.js"
import { harnessId } from "./ui/harness.js"

const HELP = `Usage: flowgraph [options] <command> [args]

Commands:
  list                             List workflows
  validate <workflow-id>           Validate a workflow
  show <workflow-id>               Print a workflow's YAML
  run <workflow-id> "<objective>"  Run a workflow in the foreground
  runs                             List runs in CLI state
  graph <run-id>                   Describe a run graph
  pause <run-id>                   Pause a run
  resume <run-id>                  Resume a run
  cancel <run-id>                  Cancel a run
  respond <run-id> --outcome <outcome>  Answer a human step

Options:
  --project <directory>        Project directory (default: cwd)
  --workflow-dir <directory>   Explicit workflow directory inside the project
  --state-dir <directory>      Runtime state directory inside the project (default ".flowgraph/state"; must be a subdirectory)
  --adapter-module <path>      Trusted local module exporting createHarnessAdapter
  --json                       Machine-readable output
  --confirm-retry              Resume an ambiguous node after confirming it stopped
  --node <id>                  Human step to answer when several are waiting
  --feedback <text>            Feedback for a human decision
  -h, --help                   Show this help
  -v, --version                Show the version

Exit codes: 0 ok/blocked/cancelled, 1 invalid/not-found/rejected, 2 usage, 3 adapter.
Inspection works without an adapter. Execution commands require --adapter-module.`

const TERMINAL = new Set<RunStatus>(["completed", "failed", "cancelled", "blocked", "paused"])
const POLL_MS = 50

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export class AdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AdapterError"
  }
}

class CliRunNotFoundError extends RunNotFoundError {
  constructor(runID: string) {
    super(runID)
    this.message =
      `workflow run not found in CLI state: ${runID}. ` +
      "Runs started by another harness are not visible to the CLI; use /flowgraph runs or RPC."
  }
}

export type CliIO = {
  stdout: (text: string) => void
  stderr: (text: string) => void
  isTTY: boolean
}

export type CliOptions = {
  cwd?: string
  io?: Partial<CliIO>
  handleSignals?: boolean
  abortSignal?: AbortSignal
}

type Flags = {
  project?: string
  workflowDir?: string
  stateDir?: string
  adapterModule?: string
  outcome?: string
  node?: string
  feedback?: string
  json: boolean
  confirmRetry: boolean
  help: boolean
  version: boolean
}

type Parsed = {
  command?: string
  positionals: string[]
  flags: Flags
}

type Context = {
  io: CliIO
  cwd: string
  command?: string
  positionals: string[]
  flags: Flags
  project: ProjectIdentity
  stateDir: string
  repo: WorkflowRepository
  interrupts: Interrupts
}

type CliWorkflow = {
  id: string
  name?: string
  description?: string
  valid: boolean
  errors: Diagnostic[]
  warnings: string[]
  hash?: string
}

type Interrupts = {
  attach: (shutdown: () => Promise<void>) => void
  signal: () => NodeJS.Signals | undefined
  settle: () => Promise<void>
  dispose: () => void
}

const VALUE_FLAGS = new Set(["project", "workflow-dir", "state-dir", "adapter-module", "outcome", "node", "feedback"])
const BOOLEAN_FLAGS = new Set(["json", "confirm-retry", "help", "version"])

function flagName(raw: string): string {
  return raw.replace(/^--/u, "")
}

export function parseArgs(argv: string[]): Parsed {
  const flags: Flags = { json: false, confirmRetry: false, help: false, version: false }
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === "--") {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (argument === "-h") {
      flags.help = true
      continue
    }
    if (argument === "-v") {
      flags.version = true
      continue
    }
    if (!argument.startsWith("--")) {
      if (argument.startsWith("-") && argument.length > 1) {
        throw new UsageError(`unknown option ${argument}`)
      }
      positionals.push(argument)
      continue
    }

    const [head, inline] = argument.split(/=(.*)/su, 2)
    const name = flagName(head!)
    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} does not take a value`)
      if (name === "json") flags.json = true
      else if (name === "confirm-retry") flags.confirmRetry = true
      else if (name === "help") flags.help = true
      else flags.version = true
      continue
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown option --${name}`)
    const value = inline ?? argv[index + 1]
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      throw new UsageError(`--${name} needs a value`)
    }
    if (inline === undefined) index += 1
    if (name === "project") flags.project = value
    else if (name === "workflow-dir") flags.workflowDir = value
    else if (name === "state-dir") flags.stateDir = value
    else if (name === "adapter-module") flags.adapterModule = value
    else if (name === "outcome") flags.outcome = value
    else if (name === "node") flags.node = value
    else if (name === "feedback") flags.feedback = value
  }
  const [command, ...rest] = positionals
  return {
    ...(command === undefined ? {} : { command }),
    positionals: rest,
    flags,
  }
}

function createInterrupts(options: CliOptions): Interrupts {
  let named: NodeJS.Signals | undefined
  let shutdown: (() => Promise<void>) | undefined
  let pending: Promise<void> | undefined

  const fire = (signal: NodeJS.Signals) => {
    if (named !== undefined) return
    named = signal
    if (shutdown) pending = shutdown().catch(() => undefined)
  }
  const onInt = () => {
    fire("SIGINT")
    // Read-only commands and adapter loading never attach a shutdown; without
    // this the installed handler would swallow the signal and leave the CLI
    // running. A run/control command attaches as soon as its runtime exists.
    if (!shutdown) process.exit(130)
  }
  const onTerm = () => {
    fire("SIGTERM")
    if (!shutdown) process.exit(143)
  }
  const onAbort = () => fire("SIGINT")

  if (options.handleSignals !== false) {
    process.once("SIGINT", onInt)
    process.once("SIGTERM", onTerm)
  }
  if (options.abortSignal) {
    if (options.abortSignal.aborted) fire("SIGINT")
    else options.abortSignal.addEventListener("abort", onAbort, { once: true })
  }

  return {
    attach(fn) {
      shutdown = fn
      if (named !== undefined) pending = fn().catch(() => undefined)
    },
    signal: () => named,
    async settle() {
      if (pending) await pending
    },
    dispose() {
      process.off("SIGINT", onInt)
      process.off("SIGTERM", onTerm)
      options.abortSignal?.removeEventListener("abort", onAbort)
    },
  }
}

async function createContext(parsed: Parsed, options: CliOptions, interrupts: Interrupts, io: CliIO): Promise<Context> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const rawProject = parsed.flags.project ?? "."
  const projectDirectory = await fs.realpath(path.resolve(cwd, rawProject)).catch(() => {
    throw new UsageError(`project directory not found: ${path.resolve(cwd, rawProject)}`)
  })
  const info = await fs.stat(projectDirectory)
  if (!info.isDirectory()) throw new UsageError(`project is not a directory: ${projectDirectory}`)

  // Resolve symlinked ancestors before opening storage so a `.flowgraph` or
  // `--state-dir` symlink cannot move state outside the project.
  const stateDir = await resolvePhysicalPath(
    path.resolve(projectDirectory, parsed.flags.stateDir ?? path.join(".flowgraph", "state")),
  )
  if (!isInside(projectDirectory, stateDir)) {
    throw new UsageError(`State directory resolves outside the project: ${stateDir}`)
  }
  if (stateDir === projectDirectory) {
    throw new UsageError("State directory must be a subdirectory of the project, not the project root")
  }
  // A dangling symlink anywhere in the chain must fail closed as an unsafe
  // directory rather than creating state through the broken link.
  for (let probe = stateDir; probe !== projectDirectory; probe = path.dirname(probe)) {
    const info = await fs.lstat(probe).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    })
    if (info !== undefined && info.isSymbolicLink()) {
      throw new UsageError(`State directory is not usable: dangling symlink at ${probe}`)
    }
  }

  const repo = new WorkflowRepository(
    projectDirectory,
    parsed.flags.workflowDir === undefined ? {} : { root: parsed.flags.workflowDir },
  )
  const project: ProjectIdentity = {
    id: `cli_${sha256(projectDirectory).slice(0, 32)}`,
    canonical: projectDirectory,
    directory: projectDirectory,
  }

  return {
    io,
    cwd,
    ...(parsed.command === undefined ? {} : { command: parsed.command }),
    positionals: parsed.positionals,
    flags: parsed.flags,
    project,
    stateDir,
    repo,
    interrupts,
  }
}

async function loadHarnessAdapter(
  modulePath: string,
  cwd: string,
  context: HarnessAdapterContext,
): Promise<HarnessAdapter> {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(modulePath)) {
    throw new AdapterError(`Adapter module rejected: remote modules are not supported: ${modulePath}`)
  }
  const resolved = path.resolve(cwd, modulePath)
  let info
  try {
    info = await fs.lstat(resolved)
  } catch {
    throw new AdapterError(`Adapter module rejected: module not found: ${resolved}`)
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new AdapterError(`Adapter module rejected: not a regular file: ${resolved}`)
  }

  let imported: unknown
  try {
    imported = await import(pathToFileURL(resolved).href)
  } catch (error) {
    throw new AdapterError(`Adapter module rejected: ${errorMessage(error, "import failed")}`)
  }
  const factory = (imported as { createHarnessAdapter?: unknown }).createHarnessAdapter
  if (typeof factory !== "function") {
    throw new AdapterError("Adapter module rejected: no createHarnessAdapter(context) export")
  }

  let adapter: HarnessAdapter
  try {
    adapter = await factory(context) as HarnessAdapter
  } catch (error) {
    throw new AdapterError(`Adapter module rejected: ${errorMessage(error, "factory failed")}`)
  }
  if (adapter === null || typeof adapter !== "object") {
    throw new AdapterError("Adapter module rejected: factory did not return an adapter")
  }
  const capabilities = HarnessCapabilitiesSchema.safeParse(adapter.capabilities)
  if (!capabilities.success) {
    throw new AdapterError(`Adapter module rejected: invalid capabilities: ${capabilities.error.issues[0]?.message ?? "schema error"}`)
  }
  for (const method of ["listAgents", "resolveAgent", "createSession", "submit", "inspect", "pendingPermissions", "cancel"]) {
    if (typeof (adapter as unknown as Record<string, unknown>)[method] !== "function") {
      throw new AdapterError(`Adapter module rejected: missing ${method}()`)
    }
  }
  return adapter
}

async function openRuntime(context: Context): Promise<FlowgraphRuntime> {
  if (context.flags.adapterModule === undefined) {
    throw new AdapterError(
      `No execution adapter configured: ${context.command ?? "this command"} needs --adapter-module <path> ` +
        "exporting createHarnessAdapter(context). Inspection commands work without an adapter.",
    )
  }
  const modulePath = context.flags.adapterModule
  return createFlowgraphRuntime({
    project: context.project,
    storage: new FileSystemStoragePort({ directory: context.stateDir }),
    ...(context.flags.workflowDir === undefined ? {} : { workflowRoot: context.flags.workflowDir }),
    harness: (deps) => loadHarnessAdapter(modulePath, context.cwd, deps),
    options: { recoverOnStart: false, pollIntervalMs: POLL_MS },
  })
}

function write(context: Context, text: string): void {
  context.io.stdout(`${text}\n`)
}

function writeError(context: Context, text: string): void {
  context.io.stderr(`${text}\n`)
}

function jsonLine(context: Context, value: unknown): void {
  write(context, JSON.stringify(value))
}

function errorDiagnostics(error: unknown): Diagnostic[] | undefined {
  const diagnostics = (error as { diagnostics?: unknown } | null)?.diagnostics
  return Array.isArray(diagnostics) ? diagnostics as Diagnostic[] : undefined
}

/** CLI-facing wording for control errors that would otherwise use RPC names. */
function cliResumeMessages(error: unknown): string | undefined {
  if (error instanceof AmbiguousResumeError) {
    return "pass --confirm-retry to resume the ambiguous node"
  }
  if (error instanceof PermissionPendingError) {
    return "permission requests are pending; resolve them before resuming"
  }
  if (error instanceof NotResumableError) {
    if (error.message.includes("predates harness identity")) {
      return "the run was started by another harness and cannot be resumed by this one"
    }
    if (error.message.includes("the run is waiting for a human decision")) {
      return "the run is waiting for a human decision; use `flowgraph respond`"
    }
    if (error.message.includes("cannot confirm whether a permission request is pending")) {
      return "cannot confirm whether a permission request is pending; resolve it before resuming"
    }
  }
  return undefined
}

function classify(error: unknown): { exitCode: number; code: string; message: string; diagnostics?: Diagnostic[] } {
  const message = cliResumeMessages(error) ?? errorMessage(error, "command failed")
  const name = error instanceof Error ? error.name : ""
  if (error instanceof UsageError) return { exitCode: 2, code: "usage", message }
  if (error instanceof AdapterError) return { exitCode: 3, code: "adapter", message }
  if (error instanceof StorageKeyError) return { exitCode: 2, code: "invalid_key", message }
  if (error instanceof WorkflowFileError) {
    return error.code === "unsafe_path"
      ? { exitCode: 2, code: "unsafe_directory", message }
      : { exitCode: 1, code: error.code, message }
  }
  if (error instanceof InvalidWorkflowError) {
    return { exitCode: 1, code: "invalid_workflow", message, diagnostics: error.diagnostics }
  }
  if (error instanceof WorkflowNotFoundError || error instanceof RunNotFoundError) {
    return { exitCode: 1, code: "not_found", message }
  }
  if (error instanceof RevisionConflictError) return { exitCode: 1, code: "conflict", message }
  if (
    error instanceof NotResumableError ||
    error instanceof AmbiguousResumeError ||
    error instanceof InvalidHumanResponseError ||
    error instanceof PermissionPendingError
  ) {
    return { exitCode: 1, code: "rejected", message }
  }
  if (error instanceof StateCorruptionError) return { exitCode: 1, code: "corrupt_state", message }
  const diagnostics = errorDiagnostics(error)
  return {
    exitCode: 1,
    code: name === "Error" ? "error" : name.replace(/Error$/u, "").toLowerCase() || "error",
    message,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  }
}

function reportError(context: Context, error: unknown): number {
  const result = classify(error)
  if (context.flags.json) {
    jsonLine(context, {
      error: {
        code: result.code,
        message: result.message,
        ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
      },
    })
  } else {
    writeError(context, `flowgraph: ${result.message}`)
    for (const diagnostic of result.diagnostics ?? []) {
      writeError(context, `  ${diagnostic.path}: ${diagnostic.message}`)
    }
  }
  return result.exitCode
}

function cliSummary(run: RunRecord) {
  const summary = summaryOf(run)
  return {
    runID: summary.runID,
    workflowID: summary.workflowID,
    status: summary.status,
    revision: summary.revision,
    currentNode: summary.currentNode,
    nextNode: summary.nextNode,
    stepCount: summary.stepCount,
    maxSteps: summary.maxSteps,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    ...(summary.completedAt === undefined ? {} : { completedAt: summary.completedAt }),
    objective: summary.objective,
    blocker: summary.blocker,
    failure: summary.failure,
    usage: summary.usage,
  }
}

function cliGraph(graph: ReturnType<typeof buildRunGraph>) {
  return {
    runID: graph.runID,
    workflowID: graph.workflowID,
    revision: graph.revision,
    status: graph.status,
    activeNode: graph.activeNode,
    currentNode: graph.currentNode,
    nodes: graph.nodes.map((node) => ({
      nodeID: node.nodeID,
      label: node.label,
      state: node.state,
      ...(node.agent === undefined ? {} : { agent: node.agent }),
      ...(node.human === undefined ? {} : { human: true }),
      ...(node.workflow === undefined ? {} : { workflow: node.workflow }),
      ...(node.join === undefined ? {} : { join: node.join }),
      ...(node.routedBack === undefined ? {} : { routedBack: node.routedBack }),
      stepCount: node.stepCount,
    })),
    edges: graph.edges,
    blocker: graph.blocker,
    failure: graph.failure,
    mermaid: graph.mermaid,
    ...(graph.harness === undefined ? {} : { harness: graph.harness }),
    ...(graph.readOnly === undefined ? {} : { readOnly: graph.readOnly }),
  }
}

function graphLines(graph: ReturnType<typeof buildRunGraph>): string[] {
  const done = graph.nodes.filter((node) => node.state === "completed").length
  const lines = [
    `Workflow ${graph.workflowID} · ${graph.status} · ${done}/${graph.nodes.length} nodes`,
    `Run ${graph.runID} · revision ${graph.revision}`,
  ]
  if (graph.activeNode) lines.push(`Active node: ${graph.activeNode}`)
  if (graph.harness) lines.push(`Harness: ${harnessId(graph.harness.id)}`)
  else if (graph.readOnly) lines.push("Run is read-only in the CLI (harness identity unavailable).")
  if (graph.blocker) lines.push(`Blocked: ${graph.blocker.message}`)
  if (graph.failure) lines.push(`Failed: ${graph.failure.code} — ${graph.failure.message}`)
  if (graph.pendingPermissions.length > 0) {
    lines.push(`Waiting for ${graph.pendingPermissions.length} native permission request(s)`)
  }
  return lines
}

function workflowLabel(id: string, description: string | undefined, state: string): string {
  return `- ${id}${description === undefined ? "" : ` — ${description}`} (${state})`
}

async function listWorkflows(context: Context): Promise<number> {
  if (context.flags.adapterModule === undefined) {
    const ids = await context.repo.listIDs()
    const workflows: CliWorkflow[] = []
    for (const id of ids) {
      try {
        const file = await context.repo.read(id)
        if (!file.workflow) {
          workflows.push({ id, valid: false, errors: file.errors, warnings: file.warnings, hash: file.hash })
          continue
        }
        const validation = await validateWorkflowTree(context.repo, file.workflow, file.size)
        workflows.push({
          id,
          name: file.workflow.name,
          ...(file.workflow.description === undefined ? {} : { description: file.workflow.description }),
          valid: validation.valid,
          errors: [...file.errors, ...validation.errors],
          warnings: [...file.warnings, ...validation.warnings],
          hash: file.hash,
        })
      } catch (error) {
        workflows.push({
          id,
          valid: false,
          errors: [{ path: id, message: errorMessage(error), code: "read_error" }],
          warnings: [],
        })
      }
    }
    if (context.flags.json) {
      jsonLine(context, { workflows, directory: context.repo.relativeRoot, agentsChecked: false })
      return 0
    }
    if (workflows.length === 0) {
      write(context, `No workflows found in ${context.repo.relativeRoot}.`)
      return 0
    }
    write(context, `Workflows (${workflows.length}) — ${context.repo.relativeRoot}`)
    for (const workflow of workflows) {
      const state = workflow.valid ? "structurally valid; agents unchecked" : `invalid: ${workflow.errors[0]?.message ?? "see validate"}`
      write(context, workflowLabel(workflow.id, workflow.description, state))
    }
    return 0
  }

  const runtime = await openRuntime(context)
  try {
    const result = await runtime.service.listWorkflows()
    if (context.flags.json) {
      jsonLine(context, { ...result, agentsChecked: true })
      return 0
    }
    if (result.workflows.length === 0) {
      write(context, `No workflows found in ${result.directory}.`)
      return 0
    }
    write(context, `Workflows (${result.workflows.length}) — ${result.directory}`)
    for (const workflow of result.workflows) {
      const state = workflow.valid ? "valid" : `invalid: ${workflow.errors[0]?.message ?? "see validate"}`
      write(context, workflowLabel(workflow.id, workflow.description, state))
    }
    return 0
  } finally {
    await runtime.shutdown()
  }
}

async function validateWorkflow(context: Context): Promise<number> {
  const workflowID = context.positionals[0]
  if (workflowID === undefined) throw new UsageError("validate needs a workflow ID")
  const repo = context.repo

  if (context.flags.adapterModule === undefined) {
    const file = await repo.read(workflowID)
    if (!file.workflow) {
      const result = { valid: false, agentsChecked: false, errors: file.errors, warnings: file.warnings }
      if (context.flags.json) jsonLine(context, result)
      else {
        write(context, `Invalid workflow "${workflowID}":`)
        for (const error of file.errors) write(context, `${error.path}: ${error.message}`)
        for (const warning of file.warnings) writeError(context, `flowgraph: warning: ${warning}`)
      }
      return 1
    }
    const validation = await validateWorkflowTree(context.repo, file.workflow, file.size)
    const errors = [...file.errors, ...validation.errors]
    const warnings = [...file.warnings, ...validation.warnings]
    if (context.flags.json) {
      jsonLine(context, { valid: validation.valid, agentsChecked: false, errors, warnings })
      return validation.valid ? 0 : 1
    }
    for (const warning of warnings) writeError(context, `flowgraph: warning: ${warning}`)
    if (!validation.valid) {
      write(context, `Invalid workflow "${workflowID}":`)
      for (const error of errors) write(context, `${error.path}: ${error.message}`)
      return 1
    }
    write(context, "Structurally valid; agent compatibility not checked (no execution adapter).")
    return 0
  }

  const runtime = await openRuntime(context)
  try {
    const view = await runtime.service.getWorkflow(workflowID)
    if (context.flags.json) {
      jsonLine(context, {
        valid: view.valid,
        agentsChecked: true,
        errors: view.errors,
        warnings: view.warnings,
        agents: view.agents ?? [],
      })
      return view.valid ? 0 : 1
    }
    for (const warning of view.warnings) writeError(context, `flowgraph: warning: ${warning}`)
    if (!view.valid) {
      write(context, `Invalid workflow "${workflowID}":`)
      for (const error of view.errors) write(context, `${error.path}: ${error.message}`)
      return 1
    }
    const resolved = view.agents?.filter((agent) => agent.resolved).length ?? 0
    write(context, `Valid; agents resolved (${resolved}).`)
    return 0
  } finally {
    await runtime.shutdown()
  }
}

async function showWorkflow(context: Context): Promise<number> {
  const workflowID = context.positionals[0]
  if (workflowID === undefined) throw new UsageError("show needs a workflow ID")
  const file = await context.repo.read(workflowID)
  if (context.flags.json) {
    jsonLine(context, { id: file.id, hash: file.hash, source: file.source })
    return 0
  }
  write(context, file.source.replace(/\n$/u, ""))
  for (const warning of file.warnings) writeError(context, `flowgraph: warning: ${warning}`)
  for (const error of file.errors) writeError(context, `flowgraph: ${error.path}: ${error.message}`)
  return 0
}

function storeFor(context: Context): WorkflowStore {
  return new WorkflowStore(new FileSystemStoragePort({ directory: context.stateDir }))
}

async function listRuns(context: Context): Promise<number> {
  const store = storeFor(context)
  const runs = (await store.listRuns(context.project.id))
    .filter((run) => run.project.canonical === context.project.canonical)
  if (context.flags.json) {
    jsonLine(context, { runs: runs.map(cliSummary) })
    return 0
  }
  if (runs.length === 0) {
    write(context, "No workflow runs in CLI state. Runs started in OpenCode are managed by the plugin; use /flowgraph runs or RPC.")
    return 0
  }
  write(context, `Runs (${runs.length}):`)
  for (const run of runs) {
    const owner = await store.getRunHarness(context.project.id, run.runID)
    const suffix = owner === undefined ? " · [read-only]" : ` · [${harnessId(owner.id)}]`
    write(context, `- ${run.runID} · ${run.workflowID} · ${run.status}${suffix} · ${objectiveLabel(run.objective)}`)
  }
  return 0
}

async function runGraph(context: Context): Promise<number> {
  const runID = context.positionals[0]
  if (runID === undefined) throw new UsageError("graph needs a run ID")
  const store = storeFor(context)
  const run = await store.getRun(context.project.id, runID)
  if (!run) throw new CliRunNotFoundError(runID)
  const owner = await store.getRunHarness(context.project.id, runID)
  // CLI state only holds runs started by the CLI; the harness is shown for
  // inspection but is not a foreign/read-only run.
  const graph = buildRunGraph(run, run.pendingPermissions, owner, false)
  if (context.flags.json) {
    jsonLine(context, cliGraph(graph))
    return 0
  }
  for (const line of graphLines(graph)) write(context, line)
  return 0
}

type Foreground = {
  announce: boolean
}

function adapterFlag(context: Context): string {
  if (context.flags.adapterModule === undefined) return ""
  const value = /\s/u.test(context.flags.adapterModule) ? JSON.stringify(context.flags.adapterModule) : context.flags.adapterModule
  return ` --adapter-module ${value}`
}

/** A fork can hold several branches with different blockers at once. */
function blockerGuidance(run: RunRecord) {
  const blockers = blockersOf(run)
  const permission = blockers.some((blocker) => blocker.type === "permission") || run.pendingPermissions.length > 0
  const humans = blockers.filter((blocker) => blocker.type === "human_input")
  return {
    permission,
    humans,
    retry: blockers.some((blocker) => blocker.type !== "permission" && blocker.type !== "human_input") || (!permission && humans.length === 0),
  }
}

/**
 * A native permission can appear only after the pause drain observes the
 * session. The drain cannot finish and a headless CLI cannot answer it, so stop
 * waiting with a nonzero exit and leave the run pausing for a later resume.
 */
function pauseDrainStopped(context: Context, run: RunRecord): number {
  const exitCode = 1
  if (context.flags.json) {
    jsonLine(context, { type: "result", run: cliSummary(run), exitCode })
    return exitCode
  }
  const blocker = blockersOf(run).find((item) => item.type === "permission")
  const at = blocker?.nodeID === undefined ? "" : ` at ${blocker.nodeID}`
  write(context, `Pause stopped${at}: ${blocker?.message ?? "a branch is waiting for a native permission decision"}`)
  write(context, `Resolve the pending native permission, then: flowgraph resume ${run.runID}${adapterFlag(context)}`)
  return exitCode
}

async function finishRun(context: Context, run: RunRecord): Promise<number> {
  const exitCode = run.status === "failed" ? 1 : 0
  if (context.flags.json) {
    jsonLine(context, { type: "result", run: cliSummary(run), exitCode })
    return exitCode
  }
  if (run.status === "completed") {
    write(context, `Run ${run.runID} completed.`)
  } else if (run.status === "cancelled") {
    write(context, `Run ${run.runID} cancelled.`)
  } else if (run.status === "paused" || run.status === "pausing") {
    write(context, `Run ${run.runID} paused.`)
  } else if (run.status === "failed") {
    write(context, `Run ${run.runID} failed: ${run.failure?.code ?? "error"} — ${run.failure?.message ?? "unknown error"}`)
  } else if (run.status === "blocked") {
    const blockers = blockersOf(run)
    const node = blockers[0]?.nodeID ?? run.currentNode ?? run.activeStep?.nodeID ?? "workflow"
    write(context, `Blocked at ${node}: ${blockers[0]?.message ?? "run is blocked"}`)
    const adapter = adapterFlag(context)
    const guidance = blockerGuidance(run)
    if (guidance.permission) {
      write(context, `Resolve the pending native permission, then: flowgraph resume ${run.runID}${adapter}`)
    }
    if (guidance.humans.length > 0) {
      for (const nodeID of new Set(guidance.humans.map((blocker) => blocker.nodeID))) {
        const nodeFlag = nodeID ? ` --node ${nodeID}` : ""
        write(context, `Answer: flowgraph respond ${run.runID} --outcome <outcome>${nodeFlag}${adapter}`)
      }
    }
    if (guidance.retry) {
      write(context, `Resume: flowgraph resume ${run.runID} --confirm-retry${adapter}`)
    }
  } else {
    write(context, `Run ${run.runID} ${run.status}.`)
  }
  return exitCode
}

async function interruptedResult(
  context: Context,
  runID: string | undefined,
  signal: NodeJS.Signals,
  phase: "running" | "run-start" | "control" = "running",
): Promise<number> {
  await context.interrupts.settle()
  const exitCode = signal === "SIGTERM" ? 143 : 130
  if (context.flags.json) {
    jsonLine(context, { type: "interrupted", ...(runID === undefined ? {} : { runID }), signal, exitCode })
  } else if (phase === "run-start") {
    write(context, "Interrupted before the run started; no checkpoint was saved.")
  } else if (phase === "control") {
    write(context, "Interrupted before the action was applied; the run was not changed.")
  } else {
    write(context, "Interrupted; checkpoint saved.")
    if (runID !== undefined) write(context, `Resume with flowgraph resume ${runID}.`)
  }
  return exitCode
}

async function foreground(context: Context, runtime: FlowgraphRuntime, initial: RunRecord, options: Foreground): Promise<number> {
  let revision = -1
  for (;;) {
    const interrupted = context.interrupts.signal()
    if (interrupted !== undefined) return interruptedResult(context, initial.runID, interrupted)

    const run = await runtime.store.getRun(runtime.project.id, initial.runID)
    if (!run) throw new RunNotFoundError(initial.runID)
    if (run.revision !== revision) {
      revision = run.revision
      if (context.flags.json) {
        jsonLine(context, {
          type: "status",
          runID: run.runID,
          status: run.status,
          revision: run.revision,
          currentNode: run.currentNode,
        })
      } else if (context.io.isTTY && options.announce) {
        const node = run.currentNode ?? run.nextNode
        write(context, `Node ${node ?? "—"} · ${run.status}`)
      }
    }
    // The pause drain is done when every branch is inactive; a "pausing" run
    // with no active step is not waiting for anything else to finish.
    const drained = run.status === "pausing" && !run.execution?.branches.some((branch) => branch.active)
    if (run.status === "pausing" && !drained && blockerGuidance(run).permission) {
      return pauseDrainStopped(context, run)
    }
    if (TERMINAL.has(run.status) || drained) return finishRun(context, run)
    await sleep(POLL_MS)
  }
}

async function startRun(context: Context): Promise<number> {
  const workflowID = context.positionals[0]
  const objective = context.positionals.slice(1).join(" ").trim()
  if (workflowID === undefined || objective.length === 0) {
    throw new UsageError('run needs a workflow ID and an objective: flowgraph run <workflow-id> "<objective>"')
  }
  const runtime = await openRuntime(context)
  context.interrupts.attach(() => runtime.shutdown())
  try {
    const early = context.interrupts.signal()
    if (early !== undefined) return interruptedResult(context, undefined, early, "run-start")
    await runtime.start()
    const started = await runtime.service.startRun(workflowID, objective, randomUUID())
    if (context.flags.json) {
      jsonLine(context, {
        type: "started",
        runID: started.runID,
        workflowID: started.workflowID,
        status: started.status,
        revision: started.revision,
      })
    } else {
      write(context, `Run ${started.runID} started · ${started.workflowID} · ${started.status}`)
    }
    return await foreground(context, runtime, await currentRun(runtime, started.runID), { announce: true })
  } finally {
    await runtime.shutdown()
  }
}

async function currentRun(runtime: FlowgraphRuntime, runID: string, control = false): Promise<RunRecord> {
  const run = await runtime.store.getRun(runtime.project.id, runID)
  if (!run) throw control ? new CliRunNotFoundError(runID) : new RunNotFoundError(runID)
  return run
}

async function controlRun(context: Context, action: "pause" | "resume" | "cancel" | "respond"): Promise<number> {
  const runID = context.positionals[0]
  if (runID === undefined) throw new UsageError(`${action} needs a run ID`)
  if (action === "respond" && context.flags.outcome === undefined) {
    throw new UsageError("respond needs --outcome <outcome>")
  }
  const runtime = await openRuntime(context)
  context.interrupts.attach(() => runtime.shutdown())
  try {
    const early = context.interrupts.signal()
    if (early !== undefined) return interruptedResult(context, runID, early, "control")
    await runtime.start()
    const current = await currentRun(runtime, runID, true)
    if (action === "pause") {
      // A headless CLI cannot resolve a native permission or answer a human
      // step, so waiting in the drain loop would hang without a way forward.
      const guidance = blockerGuidance(current)
      if (guidance.permission) {
        throw new NotResumableError("a branch is waiting for a native permission decision; resolve it before pausing")
      }
      if (guidance.humans.length > 0) {
        throw new NotResumableError("a branch is waiting for a human decision; answer it instead of pausing")
      }
      const pausing = await runtime.service.pauseRun(runID, randomUUID(), current.revision)
      if (pausing.status === "pausing" && context.io.isTTY) {
        write(context, "Pausing; waiting for active nodes to finish. Press Ctrl-C to stop waiting.")
      }
      // The pause → paused transition is driven by the run loop (checkpoint.ts);
      // start it here in case the earlier start released the run.
      await runtime.runner.start(runtime.project.id, runID).catch(() => undefined)
    } else if (action === "cancel") {
      await runtime.service.cancelRun(runID, randomUUID(), current.revision)
    } else if (action === "resume") {
      await runtime.service.resumeRun(runID, randomUUID(), current.revision, context.flags.confirmRetry)
    } else {
      const decision: HumanDecision = {
        outcome: context.flags.outcome!,
        ...(context.flags.node === undefined ? {} : { nodeID: context.flags.node }),
        ...(context.flags.feedback === undefined ? {} : { feedback: context.flags.feedback }),
      }
      await runtime.service.respondRun(runID, randomUUID(), current.revision, decision)
    }
    return await foreground(context, runtime, await currentRun(runtime, runID, true), { announce: false })
  } finally {
    await runtime.shutdown()
  }
}

async function dispatch(context: Context): Promise<number> {
  const command = context.command
  switch (command) {
    case "list": return listWorkflows(context)
    case "validate": return validateWorkflow(context)
    case "show": return showWorkflow(context)
    case "run": return startRun(context)
    case "runs": return listRuns(context)
    case "graph": return runGraph(context)
    case "pause":
    case "resume":
    case "cancel":
    case "respond":
      return controlRun(context, command)
    default:
      throw new UsageError(command === undefined ? "missing command" : `unknown command ${command}`)
  }
}

function warningFor(context: Context): string | undefined {
  return context.repo.warning
}

function isPipeClosed(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "EPIPE"
}

/** A closed downstream pipe (`flowgraph runs | head`) is normal termination. */
function guardWrite(write: (text: string) => void): (text: string) => void {
  return (text) => {
    try {
      write(text)
    } catch (error) {
      if (!isPipeClosed(error)) throw error
    }
  }
}

export async function main(argv: string[], options: CliOptions = {}): Promise<number> {
  const io: CliIO = {
    stdout: guardWrite(options.io?.stdout ?? ((text) => process.stdout.write(text))),
    stderr: guardWrite(options.io?.stderr ?? ((text) => process.stderr.write(text))),
    isTTY: options.io?.isTTY ?? process.stdout.isTTY === true,
  }
  const parsed = (() => {
    try {
      return parseArgs(argv)
    } catch (error) {
      const json = argv.some((argument) => argument === "--json" || argument === "--json=true")
      const message = errorMessage(error, "invalid arguments")
      if (json) io.stdout(`${JSON.stringify({ error: { code: "usage", message } })}\n`)
      else io.stderr(`flowgraph: ${message}\n`)
      return undefined
    }
  })()
  if (parsed === undefined) return 2

  if (parsed.flags.help || parsed.command === "help") {
    io.stdout(`${HELP}\n`)
    return 0
  }
  if (parsed.flags.version || parsed.command === "version") {
    io.stdout(`${PLUGIN_VERSION}\n`)
    return 0
  }

  const interrupts = createInterrupts(options)
  let context: Context | undefined
  try {
    context = await createContext(parsed, options, interrupts, io)
    const warning = warningFor(context)
    if (warning) io.stderr(`flowgraph: ${warning}\n`)
    return await dispatch(context)
  } catch (error) {
    if (context === undefined) {
      const result = classify(error)
      if (parsed.flags.json) io.stdout(`${JSON.stringify({ error: { code: result.code, message: result.message } })}\n`)
      else io.stderr(`flowgraph: ${result.message}\n`)
      return result.exitCode
    }
    return reportError(context, error)
  } finally {
    interrupts.dispose()
  }
}

function invokedAsScript(): boolean {
  const entry = process.argv[1]
  if (entry === undefined || entry.length === 0) return false
  try {
    // npm bin entries are symlinks; compare real paths so the CLI still runs.
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedAsScript()) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: unknown) => {
      if (!isPipeClosed(error)) throw error
    })
  }
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
