import { hostname } from "node:os"
import path from "node:path"
import { HARD_LIMITS } from "./workflow/schema.js"
import type { WorkflowDefinition } from "./workflow/schema.js"
import { WorkflowFileError, WorkflowRepository, parseWorkflowSource } from "./workflow/loader.js"
import { validateWorkflow, type AgentResolution, type WorkflowValidation } from "./workflow/validator.js"
import { renderMermaid } from "./workflow/mermaid.js"
import { buildRunGraph } from "./execution/run-graph.js"
import { buildGraph, type Diagnostic, type WorkflowGraph } from "./workflow/graph.js"
import { WorkflowStore, RevisionConflictError } from "./state/store.js"
import { StorageKeys } from "./state/keys.js"
import { RunOwnershipError } from "./state/concurrency.js"
import { KeyedMutex } from "./util/mutex.js"
import { activeSteps, blockersOf } from "./execution/checkpoint.js"
import { newRunID } from "./util/ids.js"
import { sha256 } from "./util/hash.js"
import { errorMessage } from "./util/redact.js"
import { zeroUsage } from "./execution/results.js"
import type { NativeRuntime } from "./execution/native-agents.js"
import { RunNotFoundError, type RunUpdatedPayload, type WorkflowRunner } from "./execution/runner.js"
import {
  RunRecordSchema,
  summaryOf,
  type ProjectIdentity,
  type RunDetail,
  type RunRecord,
  type RunStatus,
  type RunSummary,
  type StepRecord,
} from "./state/types.js"

export class WorkflowNotFoundError extends Error {
  constructor(readonly workflowID: string) {
    super(`workflow not found: ${workflowID}`)
    this.name = "WorkflowNotFoundError"
  }
}

export class InvalidWorkflowError extends Error {
  constructor(
    message: string,
    readonly diagnostics: Diagnostic[],
  ) {
    super(message)
    this.name = "InvalidWorkflowError"
  }
}

export class TooManyRunsError extends Error {
  constructor() {
    super(`project already has ${HARD_LIMITS.maxRuns} workflow runs; cancel or remove old runs before starting a new one`)
    this.name = "TooManyRunsError"
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("requestID was already used for a different workflow or objective")
    this.name = "IdempotencyConflictError"
  }
}

export class StaleWorkflowError extends Error {
  constructor() {
    super("workflow changed since it was read")
    this.name = "StaleWorkflowError"
  }
}

export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidStateError"
  }
}

export type WorkflowSummary = {
  id: string
  name?: string
  description?: string
  valid: boolean
  errors: Diagnostic[]
  warnings: string[]
  hash?: string
}

export type WorkflowView = {
  id: string
  hash: string
  source: string
  valid: boolean
  errors: Diagnostic[]
  warnings: string[]
  definition?: WorkflowDefinition
  graph?: WorkflowGraph
  mermaid?: string
  agents?: AgentResolution[]
}

export type ValidationView = {
  valid: boolean
  errors: Diagnostic[]
  warnings: string[]
  definition?: WorkflowDefinition
  graph?: WorkflowGraph
  mermaid?: string
  agents?: AgentResolution[]
}

export type ServiceDeps = {
  project: ProjectIdentity
  store: WorkflowStore
  runner: WorkflowRunner
  native: NativeRuntime
  repo: WorkflowRepository
  instanceID: string
  emit: (payload: RunUpdatedPayload) => Promise<void>
  now?: () => number
}

const admission = new KeyedMutex()

export class WorkflowService {
  readonly project: ProjectIdentity
  private readonly store: WorkflowStore
  private readonly runner: WorkflowRunner
  private readonly native: NativeRuntime
  private readonly repo: WorkflowRepository
  private readonly instanceID: string
  private readonly now: () => number

  constructor(deps: ServiceDeps) {
    this.project = deps.project
    this.store = deps.store
    this.runner = deps.runner
    this.native = deps.native
    this.repo = deps.repo
    this.instanceID = deps.instanceID
    this.now = deps.now ?? Date.now
  }

  private async validationContext() {
    const [agents, defaultModel] = await Promise.all([
      this.native.listAgents(),
      this.native.getDefaultModel().catch(() => undefined),
    ])
    return { agents, hasDefaultModel: defaultModel !== undefined }
  }

  private async validate(
    workflow: WorkflowDefinition,
    context: Awaited<ReturnType<WorkflowService["validationContext"]>>,
    bytes: number,
  ): Promise<WorkflowValidation & { dependencies: NonNullable<RunRecord["workflowDependencies"]> }> {
    const options = { hasDefaultModel: context.hasDefaultModel }
    const root = validateWorkflow(workflow, context.agents, options)
    const dependencies: NonNullable<RunRecord["workflowDependencies"]> = {}
    const stack = new Set([workflow.name])
    const visited = new Set<string>()

    const visit = async (definition: WorkflowDefinition): Promise<void> => {
      for (const [id, node] of Object.entries(definition.nodes)) {
        if (!("workflow" in node)) continue
        const path = `workflows.${definition.name}.nodes.${id}.workflow`
        const name = node.workflow
        if (stack.has(name)) {
          root.errors.push({ path, message: `recursive workflow call to "${name}"`, code: "recursive_workflow" })
          continue
        }
        if (visited.has(name)) continue
        visited.add(name)
        try {
          const file = await this.repo.read(name)
          bytes += file.size
          if (bytes > HARD_LIMITS.maxWorkflowBytes || visited.size >= HARD_LIMITS.maxWorkflows) {
            root.errors.push({ path, message: "combined workflow sources exceed the workflow size or count limit", code: "workflow_dependency_limit" })
            return
          }
          if (!file.workflow) {
            root.errors.push(...file.errors.map((error) => ({ ...error, path: `workflows.${name}.${error.path}` })))
            continue
          }
          const child = validateWorkflow(file.workflow, context.agents, options)
          root.errors.push(...child.errors.map((error) => ({ ...error, path: `workflows.${name}.${error.path}` })))
          root.warnings.push(...[...file.warnings, ...child.warnings].map((warning) => `${name}: ${warning}`))
          for (const agent of child.agents) {
            if (!root.agents.some((existing) => existing.agentID === agent.agentID)) root.agents.push(agent)
          }
          dependencies[name] = { definition: file.workflow, hash: file.hash }
          stack.add(name)
          await visit(file.workflow)
          stack.delete(name)
        } catch (error) {
          root.errors.push({ path, message: errorMessage(error), code: "invalid_workflow_reference" })
        }
      }
    }
    await visit(workflow)
    return { ...root, valid: root.errors.length === 0, dependencies }
  }

  async listWorkflows(): Promise<{ workflows: WorkflowSummary[]; directory: string }> {
    const context = await this.validationContext()
    const ids = await this.repo.listIDs()
    const workflows: WorkflowSummary[] = []
    for (const id of ids) {
      try {
        const file = await this.repo.read(id)
        if (!file.workflow) {
          workflows.push({
            id,
            valid: false,
            errors: file.errors,
            warnings: file.warnings,
            hash: file.hash,
          })
          continue
        }
        const validation = await this.validate(file.workflow, context, file.size)
        workflows.push({
          id,
          name: file.workflow.name,
          ...(file.workflow.description === undefined ? {} : { description: file.workflow.description }),
          valid: validation.valid,
          errors: validation.errors,
          warnings: [...file.warnings, ...validation.warnings],
          hash: file.hash,
        })
      } catch (error) {
        workflows.push({
          id,
          valid: false,
          errors: [{ path: id, message: errorMessage(error), code: error instanceof WorkflowFileError ? error.code : "read_error" }],
          warnings: [],
        })
      }
    }
    return { workflows, directory: path.join(".opencode", "workflows") }
  }

  async getWorkflow(workflowID: string): Promise<WorkflowView> {
    const file = await this.repo.read(workflowID)
    if (!file.workflow) {
      return {
        id: workflowID,
        hash: file.hash,
        source: file.source,
        valid: false,
        errors: file.errors,
        warnings: file.warnings,
      }
    }
    const validation = await this.validate(file.workflow, await this.validationContext(), file.size)
    return {
      id: workflowID,
      hash: file.hash,
      source: file.source,
      valid: validation.valid,
      errors: [...file.errors, ...validation.errors],
      warnings: [...file.warnings, ...validation.warnings],
      definition: file.workflow,
      graph: validation.graph,
      mermaid: renderMermaid(validation.graph),
      agents: validation.agents,
    }
  }

  async validateWorkflowSource(source: string, workflowID?: string): Promise<ValidationView> {
    const parsed = parseWorkflowSource(source, workflowID === undefined ? {} : { workflowID })
    if (!parsed.workflow) return { valid: false, errors: parsed.errors, warnings: parsed.warnings }
    const validation = await this.validate(parsed.workflow, await this.validationContext(), Buffer.byteLength(source, "utf8"))
    return {
      valid: validation.valid,
      errors: [...parsed.errors, ...validation.errors],
      warnings: [...parsed.warnings, ...validation.warnings],
      definition: parsed.workflow,
      graph: validation.graph,
      mermaid: renderMermaid(validation.graph),
      agents: validation.agents,
    }
  }

  async saveWorkflow(workflowID: string, source: string, expectedHash: string | null): Promise<{ id: string; hash: string; bytes: number }> {
    const validation = await this.validateWorkflowSource(source, workflowID)
    if (!validation.valid) throw new InvalidWorkflowError("workflow validation failed", validation.errors)
    try {
      return await this.repo.save(workflowID, source, expectedHash, async (previous, hash) => {
        await this.store.putBackup(this.project.id, workflowID, hash, previous)
      })
    } catch (error) {
      if (error instanceof WorkflowFileError && error.code === "stale_revision") throw new StaleWorkflowError()
      throw error
    }
  }

  async deleteWorkflow(workflowID: string, expectedHash: string): Promise<{ deleted: true }> {
    try {
      await this.repo.delete(workflowID, expectedHash, async (previous, hash) => {
        await this.store.putBackup(this.project.id, workflowID, hash, previous)
      })
      return { deleted: true }
    } catch (error) {
      if (error instanceof WorkflowFileError && error.code === "stale_revision") throw new StaleWorkflowError()
      if (error instanceof WorkflowFileError && error.code === "not_found") throw new WorkflowNotFoundError(workflowID)
      throw error
    }
  }

  async startRun(workflowID: string, objective: string, requestID: string): Promise<RunSummary> {
    if (Buffer.byteLength(objective, "utf8") > HARD_LIMITS.maxObjectiveBytes) {
      throw new InvalidStateError(`objective exceeds ${HARD_LIMITS.maxObjectiveBytes} bytes`)
    }
    if (requestID.length === 0 || requestID.length > 128) {
      throw new InvalidStateError("requestID must be between 1 and 128 characters")
    }

    const requestHash = sha256(`${workflowID}\u0000${objective}`)
    const idemHash = sha256(requestID)
    const projectID = this.project.id
    const findExisting = async (runs?: RunRecord[]): Promise<RunRecord | undefined> => {
      const indexedID = await this.store.getIdempotency(projectID, idemHash)
      const indexed = indexedID ? await this.store.getRun(projectID, indexedID) : undefined
      const existing = indexed ?? (runs ?? await this.store.listRuns(projectID)).find((run) => run.requestID === requestID)
      if (existing) {
        this.ensureProject(existing)
        if (existing.requestHash !== requestHash) throw new IdempotencyConflictError()
      }
      return existing
    }
    const prior = await findExisting()
    if (prior) {
      await this.startExisting(prior)
      return summaryOf(prior)
    }

    const workflow = await this.repo.read(workflowID)
    if (!workflow.workflow) throw new InvalidWorkflowError("workflow validation failed", workflow.errors)
    const definition = workflow.workflow
    const validation = await this.validate(definition, await this.validationContext(), workflow.size)
    if (!validation.valid) throw new InvalidWorkflowError("workflow validation failed", validation.errors)

    const { run: created, existing } = await admission.run(projectID, async () => {
      const all = await this.store.listRuns(projectID)
      const existing = await findExisting(all)
      if (existing) return { run: existing, existing: true }
      if (all.length >= HARD_LIMITS.maxRuns) throw new TooManyRunsError()

      const now = this.now()
      const runID = newRunID(now)
      const run: RunRecord = {
        schemaVersion: 1,
        runID,
        workflowID,
        requestID,
        requestHash,
        project: this.project,
        workflowHash: workflow.hash,
        workflowSnapshot: definition,
        ...(Object.keys(validation.dependencies).length === 0 ? {} : { workflowDependencies: validation.dependencies }),
        sourceYamlKey: StorageKeys.source(this.project.id, runID),
        objective,
        status: "running",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        deadlineAt: now + definition.limits.timeout_seconds * 1_000,
        runSessionID: null,
        currentNode: null,
        nextNode: definition.entry,
        stepCount: 0,
        maxSteps: definition.limits.max_steps,
        activeStep: null,
        lastStep: null,
        steps: [],
        blocker: null,
        pendingPermissions: [],
        failure: null,
        pause: null,
        cancel: null,
        usage: zeroUsage(),
        audit: { toolCalls: [], mutatingToolCalls: 0 },
        owner: { instanceID: this.instanceID, hostname: hostname(), pid: process.pid },
        recovery: { attempts: 0 },
        recentControlRequests: {},
      }

      await this.store.putSource(projectID, runID, workflow.source)
      const created = await this.store.createRun(RunRecordSchema.parse(run))
      await this.store.setIdempotency(projectID, idemHash, runID)
      return { run: created, existing: false }
    })

    if (existing) await this.startExisting(created)
    else await this.runner.start(projectID, created.runID)
    return summaryOf(created)
  }

  private async startExisting(run: RunRecord): Promise<void> {
    if (run.status === "running" || run.status === "pausing" || run.status === "blocked") {
      await this.runner.start(run.project.id, run.runID, { recovery: true }).catch((error) => {
        if (!(error instanceof RunOwnershipError)) throw error
      })
    }
  }

  private ensureProject(run: RunRecord): void {
    if (run.project.id !== this.project.id) throw new RunNotFoundError(run.runID)
    if (run.project.canonical !== this.project.canonical) throw new RunNotFoundError(run.runID)
  }

  async listRuns(status?: RunStatus, limit = 50): Promise<RunSummary[]> {
    const runs = await this.store.listRuns(this.project.id)
    return runs
      .filter((run) => run.project.id === this.project.id && run.project.canonical === this.project.canonical)
      .filter((run) => status === undefined || run.status === status)
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map(summaryOf)
  }

  async getRun(runID: string): Promise<RunDetail> {
    const run = await this.store.getRun(this.project.id, runID)
    if (!run) throw new WorkflowNotFoundError(runID)
    this.ensureProject(run)
    const steps = activeSteps(run)
    const currentSteps = (await Promise.all(steps.map((step) => this.store.getStep(this.project.id, run.runID, step.stepID))))
      .filter((step): step is StepRecord => step !== undefined)
    return {
      run,
      currentStep: currentSteps.find((step) => step.stepID === run.activeStep?.stepID) ?? null,
      currentSteps,
      blockers: blockersOf(run),
      pendingPermissions: await this.runner.livePermissions(run),
      mermaid: renderMermaid(buildGraph(run.workflowSnapshot)),
      resumable: isResumable(run),
    }
  }

  async getRunGraph(runID: string): Promise<ReturnType<typeof buildRunGraph>> {
    const run = await this.requireRun(runID)
    return buildRunGraph(run, await this.runner.livePermissions(run))
  }

  async getRunStep(runID: string, stepID: string): Promise<StepRecord> {
    const run = await this.store.getRun(this.project.id, runID)
    if (!run) throw new WorkflowNotFoundError(runID)
    this.ensureProject(run)
    const step = await this.store.getStep(this.project.id, runID, stepID)
    if (!step) throw new InvalidStateError(`step not found: ${stepID}`)
    return step
  }

  async pauseRun(runID: string, requestID: string, expectedRevision: number): Promise<RunSummary> {
    const run = await this.requireRun(runID)
    const updated = await this.runner.pause(this.project.id, run.runID, expectedRevision, requestID)
    return summaryOf(updated)
  }

  async resumeRun(
    runID: string,
    requestID: string,
    expectedRevision: number,
    confirmRetry = false,
  ): Promise<RunSummary> {
    const run = await this.requireRun(runID)
    const updated = await this.runner.resume(this.project.id, run.runID, expectedRevision, requestID, confirmRetry)
    return summaryOf(updated)
  }

  async cancelRun(runID: string, requestID: string, expectedRevision: number): Promise<RunSummary> {
    const run = await this.requireRun(runID)
    const updated = await this.runner.cancel(this.project.id, run.runID, expectedRevision, requestID)
    return summaryOf(updated)
  }

  async recover(): Promise<void> {
    await this.runner.recoverProject(this.project.id, this.project.canonical)
  }

  private async requireRun(runID: string): Promise<RunRecord> {
    const run = await this.store.getRun(this.project.id, runID)
    if (!run) throw new WorkflowNotFoundError(runID)
    this.ensureProject(run)
    return run
  }
}

function isResumable(run: RunRecord): boolean {
  if (run.status === "paused") return run.pause?.reason !== "route"
  if (run.status === "blocked") return run.blocker?.type === "permission" || run.activeStep !== null
  return run.status === "running" && blockersOf(run).some((blocker) => blocker.type !== "permission")
}

export { RevisionConflictError }
