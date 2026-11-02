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
import { ProjectBusyError } from "./state/concurrency.js"
import { newRunID } from "./util/ids.js"
import { sha256 } from "./util/hash.js"
import { errorMessage } from "./util/redact.js"
import { zeroUsage } from "./execution/results.js"
import type { NativeRuntime } from "./execution/native-agents.js"
import { RunNotFoundError, type RunUpdatedPayload, type WorkflowRunner } from "./execution/runner.js"
import { PermissionPendingError } from "./execution/runner.js"
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

  private async agents() {
    return this.native.listAgents()
  }

  private validate(workflow: WorkflowDefinition, agents: Awaited<ReturnType<NativeRuntime["listAgents"]>>): WorkflowValidation {
    return validateWorkflow(workflow, agents)
  }

  async listWorkflows(): Promise<{ workflows: WorkflowSummary[]; directory: string }> {
    const agents = await this.agents()
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
        const validation = this.validate(file.workflow, agents)
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
    const validation = this.validate(file.workflow, await this.agents())
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
    const validation = this.validate(parsed.workflow, await this.agents())
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
    const existingID = await this.store.getIdempotency(this.project.id, idemHash)
    if (existingID) {
      const existing = await this.store.getRun(this.project.id, existingID)
      if (existing) {
        if (existing.project.canonical !== this.project.canonical) throw new RunNotFoundError(existing.runID)
        if (existing.requestHash !== requestHash) throw new IdempotencyConflictError()
        return summaryOf(existing)
      }
    }
    // Recover an idempotent start that crashed between run creation and idempotency-key write.
    const byRequest = (await this.store.listRuns(this.project.id)).find(
      (run) => run.requestID === requestID && run.requestHash === requestHash,
    )
    if (byRequest) {
      if (byRequest.project.canonical !== this.project.canonical) throw new RunNotFoundError(byRequest.runID)
      await this.store.setIdempotency(this.project.id, idemHash, byRequest.runID)
      return summaryOf(byRequest)
    }

    const workflow = await this.repo.read(workflowID)
    if (!workflow.workflow) throw new InvalidWorkflowError("workflow validation failed", workflow.errors)
    const validation = this.validate(workflow.workflow, await this.agents())
    if (!validation.valid) throw new InvalidWorkflowError("workflow validation failed", validation.errors)

    const all = await this.store.listRuns(this.project.id)
    if (all.length >= HARD_LIMITS.maxRuns) throw new TooManyRunsError()
    if (this.runner.hasProjectLock(this.project.canonical)) {
      throw new ProjectBusyError()
    }

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
      workflowSnapshot: workflow.workflow,
      sourceYamlKey: StorageKeys.source(this.project.id, runID),
      objective,
      status: "running",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      deadlineAt: now + workflow.workflow.limits.timeout_seconds * 1_000,
      runSessionID: null,
      currentNode: null,
      nextNode: workflow.workflow.entry,
      stepCount: 0,
      maxSteps: workflow.workflow.limits.max_steps,
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

    const created = await this.store.createRun(RunRecordSchema.parse(run))
    await this.store.putSource(this.project.id, runID, workflow.source)
    await this.store.setIdempotency(this.project.id, idemHash, runID)
    try {
      await this.runner.start(this.project.id, runID)
    } catch (error) {
      if (error instanceof ProjectBusyError) {
        await this.store.mutateRun(this.project.id, runID, null, (draft) => {
          draft.status = "failed"
          draft.failure = { code: "project_busy", message: "another workflow is active for this project" }
          draft.completedAt = this.now()
        })
        await this.store.removeIdempotency(this.project.id, idemHash)
        throw error
      }
      await this.store.mutateRun(this.project.id, runID, null, (draft) => {
        draft.status = "failed"
        draft.failure = { code: "start_failed", message: errorMessage(error) }
        draft.completedAt = this.now()
      }).catch(() => undefined)
      throw error
    }
    return summaryOf(created)
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
    const currentStep =
      run.activeStep === null ? null : await this.store.getStep(this.project.id, run.runID, run.activeStep.stepID)
    let pendingPermissions = run.pendingPermissions
    if (run.activeStep) {
      pendingPermissions = await this.native.listPermissions(run.activeStep.sessionID).catch(() => run.pendingPermissions)
    }
    return {
      run,
      currentStep: currentStep ?? null,
      pendingPermissions,
      mermaid: renderMermaid(buildGraph(run.workflowSnapshot)),
      resumable: isResumable(run),
    }
  }

  async getRunGraph(runID: string): Promise<ReturnType<typeof buildRunGraph>> {
    const run = await this.requireRun(runID)
    const pending = run.activeStep
      ? await this.native.listPermissions(run.activeStep.sessionID).catch(() => run.pendingPermissions)
      : run.pendingPermissions
    return buildRunGraph(run, pending)
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
    if (run.activeStep) {
      const live = await this.native.listPermissions(run.activeStep.sessionID).catch(() => run.pendingPermissions)
      if (live.length > 0) throw new PermissionPendingError(live)
    }
    const updated = await this.runner.resume(this.project.id, run.runID, expectedRevision, requestID, confirmRetry)
    return summaryOf(updated)
  }

  async cancelRun(runID: string, requestID: string, expectedRevision: number): Promise<RunSummary> {
    const run = await this.requireRun(runID)
    const updated = await this.runner.cancel(this.project.id, run.runID, expectedRevision, requestID)
    return summaryOf(updated)
  }

  async recover(): Promise<void> {
    await this.runner.recoverProject(this.project.id)
  }

  private async requireRun(runID: string): Promise<RunRecord> {
    const run = await this.store.getRun(this.project.id, runID)
    if (!run) throw new WorkflowNotFoundError(runID)
    this.ensureProject(run)
    return run
  }
}

function isResumable(run: RunRecord): boolean {
  if (run.status === "paused") return run.nextNode !== null && run.pause?.reason !== "route"
  if (run.status === "blocked") return run.blocker?.type === "permission" || run.activeStep !== null
  return false
}

export { RevisionConflictError }
