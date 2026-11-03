import { KeyedMutex } from "../util/mutex.js"
import { errorMessage, errorType } from "../util/redact.js"
import { newMessageID, newStepID } from "../util/ids.js"
import { buildGraph, resolveTransition, validOutcomes, type WorkflowGraph } from "../workflow/graph.js"
import type { NodeResult } from "../workflow/schema.js"
import { buildNodePrompt, buildReportCorrectionPrompt, type PromptPreviousResult } from "./prompts.js"
import { addUsage, auditFromMessages, latestIdle, usageFromSession, zeroUsage } from "./results.js"
import { RevisionConflictError, type WorkflowStore } from "../state/store.js"
import {
  type RunRecord,
  type RunStatus,
  type StepRecord,
  type StepSummary,
  type ToolAudit,
  type UsageEstimate,
  type Blocker,
  type FailureInfo,
  type PermissionSummary,
} from "../state/types.js"
import { ProjectBusyError, type ProjectLock, type ProjectLockManager } from "../state/concurrency.js"
import type { NativeRuntime, SessionSnapshot } from "./native-agents.js"
import type { InvocationRegistry } from "./report-tool.js"
import { checkBeforeNextNode } from "./limits.js"
import { repeatedTransitionCount } from "./transitions.js"

export type RunUpdatedPayload = {
  projectID: string
  projectCanonical: string
  directory: string
  runID: string
  workflowID: string
  status: RunStatus
  currentNode: string | null
  revision: number
  timestamp: number
  blocker?: { type: Blocker["type"]; message: string }
}

export type RunnerOptions = {
  pollIntervalMs: number
  recoveryGraceMs: number
}

export type RunnerDeps = {
  store: WorkflowStore
  native: NativeRuntime
  locks: ProjectLockManager
  invocations: InvocationRegistry
  emit: (payload: RunUpdatedPayload) => Promise<void>
  now?: () => number
  options?: Partial<RunnerOptions>
}

export class RunNotFoundError extends Error {
  constructor(readonly runID: string) {
    super(`workflow run not found: ${runID}`)
    this.name = "RunNotFoundError"
  }
}

export class NotResumableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NotResumableError"
  }
}

export class AmbiguousResumeError extends Error {
  constructor() {
    super("the active node is ambiguous; resume requires confirmRetry=true")
    this.name = "AmbiguousResumeError"
  }
}

export class PermissionPendingError extends Error {
  constructor(readonly permissions: PermissionSummary[]) {
    super("the active node is waiting for a native permission decision")
    this.name = "PermissionPendingError"
  }
}

type ActiveRun = {
  projectID: string
  controller: AbortController
  promise: Promise<void>
  restart?: boolean
}

type WaitResult =
  | { type: "completed"; result: NodeResult; session: SessionSnapshot; audit: ToolAudit }
  | { type: "failed"; failure: FailureInfo }
  | { type: "blocked"; blocker: Blocker }
  | { type: "cancelled" }

const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"])

export class WorkflowRunner {
  private readonly store: WorkflowStore
  private readonly native: NativeRuntime
  private readonly locks: ProjectLockManager
  private readonly invocations: InvocationRegistry
  private readonly emit: (payload: RunUpdatedPayload) => Promise<void>
  private readonly now: () => number
  private readonly options: RunnerOptions
  private readonly active = new Map<string, ActiveRun>()
  private readonly heldLocks = new Map<string, ProjectLock>()
  private readonly blockedWatchers = new Set<string>()
  private readonly controlMutex = new KeyedMutex()
  private shuttingDown = false

  constructor(deps: RunnerDeps) {
    this.store = deps.store
    this.native = deps.native
    this.locks = deps.locks
    this.invocations = deps.invocations
    this.emit = deps.emit
    this.now = deps.now ?? Date.now
    this.options = {
      pollIntervalMs: deps.options?.pollIntervalMs ?? 1_000,
      recoveryGraceMs: deps.options?.recoveryGraceMs ?? 5_000,
    }
  }

  private async requireRun(projectID: string, runID: string): Promise<RunRecord> {
    const run = await this.store.getRun(projectID, runID)
    if (!run) throw new RunNotFoundError(runID)
    return run
  }

  private graph(run: RunRecord): WorkflowGraph {
    return buildGraph(run.workflowSnapshot)
  }

  private async emitRun(run: RunRecord): Promise<void> {
    const payload: RunUpdatedPayload = {
      projectID: run.project.id,
      projectCanonical: run.project.canonical,
      directory: run.project.directory,
      runID: run.runID,
      workflowID: run.workflowID,
      status: run.status,
      currentNode: run.currentNode,
      revision: run.revision,
      timestamp: this.now(),
      ...(run.blocker === null ? {} : { blocker: { type: run.blocker.type, message: run.blocker.message } }),
    }
    await this.emit(payload).catch(() => undefined)
  }

  private async acquire(projectID: string, run: RunRecord): Promise<void> {
    if (this.heldLocks.has(run.runID)) return
    const lock = await this.locks.acquire(projectID, run.project.canonical)
    this.heldLocks.set(run.runID, lock)
    await this.store
      .setLease(projectID, {
        ownerInstanceID: run.owner.instanceID,
        runID: run.runID,
        hostname: run.owner.hostname,
        pid: run.owner.pid,
        expiresAt: this.now() + 120_000,
      })
      .catch(() => undefined)
  }

  private async release(projectID: string, runID: string): Promise<void> {
    const lock = this.heldLocks.get(runID)
    if (!lock) return
    this.heldLocks.delete(runID)
    await lock.release().catch(() => undefined)
    await this.store.removeLease(projectID).catch(() => undefined)
  }

  hasProjectLock(canonical: string): boolean {
    for (const lock of this.heldLocks.values()) {
      if (lock.canonical === canonical) return true
    }
    return false
  }

  async start(projectID: string, runID: string, options: { recovery?: boolean } = {}): Promise<void> {
    const existing = this.active.get(runID)
    if (existing) {
      existing.restart = true
      return
    }
    const run = await this.requireRun(projectID, runID)
    if (run.status === "paused" || TERMINAL.has(run.status)) {
      await this.release(projectID, runID)
      return
    }
    await this.acquire(projectID, run)
    const controller = new AbortController()
    const entry: ActiveRun = { projectID, controller, promise: Promise.resolve() }
    this.active.set(runID, entry)
    entry.promise = this.runLoop(projectID, runID, controller.signal, options.recovery === true)
      .catch(async (error) => {
        await this.failRun(projectID, runID, {
          code: "internal_error",
          message: errorMessage(error),
          ...(errorType(error) === undefined ? {} : { nativeErrorType: errorType(error) }),
        }).catch(() => undefined)
      })
      .finally(async () => {
        this.active.delete(runID)
        const final = await this.store.getRun(projectID, runID).catch(() => undefined)
        if (entry.restart && final?.status === "running") {
          await this.start(projectID, runID).catch(() => undefined)
          return
        }
        if (!final || final.status === "paused" || TERMINAL.has(final.status)) {
          await this.release(projectID, runID)
        }
      })
    void entry.promise
  }

  private async runLoop(projectID: string, runID: string, signal: AbortSignal, recovery: boolean): Promise<void> {
    let run = await this.requireRun(projectID, runID)

    if (!run.runSessionID) {
      const session = await this.native.createRootSession({
        title: `Workflow ${run.workflowID} ${run.runID}`,
        metadata: {
          plugin: "flowgraph",
          kind: "workflow-run",
          runID: run.runID,
          workflowID: run.workflowID,
        },
      })
      run = await this.store.mutateRun(projectID, runID, null, (draft) => {
        draft.runSessionID = session.id
      })
      await this.emitRun(run)
    }

    let first = true
    while (!signal.aborted) {
      run = await this.requireRun(projectID, runID)
      if (run.status === "paused" || TERMINAL.has(run.status)) return
      if (run.status === "blocked") return
      if (run.status === "cancelled") {
        if (run.activeStep) await this.native.interrupt(run.activeStep.sessionID).catch(() => false)
        return
      }

      if (run.activeStep) {
        const prePrompt = ["prepared", "session_created", "prompting"].includes(run.activeStep.phase)
        if (prePrompt) {
          const repaired = await this.repairPreparedStep(projectID, run, recovery && first)
          first = false
          if (repaired) continue
          return
        }
        if (recovery && first) {
          run = await this.bumpRecovery(projectID, run)
          if (run.status === "failed") return
        }
        first = false
        const waited = await this.waitForNode(projectID, run, recovery)
        if (waited.type === "cancelled") return
        if (waited.type === "completed") {
          const next = await this.completeStep(projectID, run, waited)
          if (next === "return") return
          continue
        }
        if (waited.type === "failed") {
          await this.failActiveStep(projectID, run, waited.failure)
          return
        }
        await this.blockActiveStep(projectID, run, waited.blocker)
        return
      }

      first = false
      if (run.status === "pausing") {
        await this.setPaused(projectID, run, "user")
        return
      }

      const target = run.nextNode ?? run.currentNode ?? run.workflowSnapshot.entry
      if (target === "complete") {
        await this.completeRun(projectID, run)
        return
      }
      if (target === "pause") {
        await this.pauseForRoute(projectID, run)
        return
      }
      const limit = checkBeforeNextNode(run, target, this.now())
      if (limit) {
        await this.failRun(projectID, run.runID, { code: limit.code, message: limit.message })
        return
      }
      const started = await this.startStep(projectID, run, target)
      if (!started) {
        const after = await this.requireRun(projectID, runID)
        if (after.status === "pausing" && after.activeStep === null) await this.setPaused(projectID, after, "user")
        return
      }
    }
    return
  }

  private async repairPreparedStep(projectID: string, run: RunRecord, recovery: boolean): Promise<boolean> {
    const active = run.activeStep
    if (!active) return true
    let hasPrompt = false
    try {
      const messages = await this.native.getContext(active.sessionID)
      hasPrompt = messages.some((message) => message.type === "user" && message.id === active.promptMessageID)
    } catch {
      hasPrompt = false
    }
    if (hasPrompt) {
      await this.store.mutateRun(projectID, run.runID, null, (draft) => {
        if (draft.activeStep?.stepID === active.stepID) {
          draft.activeStep.phase = "prompted"
          draft.activeStep.promptedAt ??= this.now()
        }
      })
      return true
    }
    if (!recovery) {
      // A live loop should never leave a prepared step. Fail closed rather than prompt twice.
      const blocked = await this.store.mutateRun(projectID, run.runID, null, (draft) => {
        if (draft.activeStep?.stepID === active.stepID) draft.activeStep.phase = "ambiguous"
        draft.status = "blocked"
        draft.blocker = {
          type: "ambiguous_node",
          message: `node "${active.nodeID}" was left before prompt admission; recovery is required`,
          since: this.now(),
          nodeID: active.nodeID,
          stepID: active.stepID,
        }
      })
      await this.emitRun(blocked)
      return false
    }
    this.invocations.unregister(active.sessionID)
    const existing = await this.store.getStep(projectID, run.runID, active.stepID).catch(() => undefined)
    if (existing) {
      await this.store.putStep(projectID, { ...existing, status: "abandoned", completedAt: this.now() })
    }
    const updated = await this.store.mutateRun(projectID, run.runID, null, (draft) => {
      draft.activeStep = null
      draft.recovery.attempts += 1
      draft.recovery.lastAttemptAt = this.now()
      draft.recovery.reason = "retrying before prompt admission"
    })
    await this.emitRun(updated)
    return true
  }

  private async startStep(projectID: string, run: RunRecord, target: string): Promise<boolean> {
    const node = run.workflowSnapshot.nodes[target]
    if (!node) {
      await this.failRun(projectID, run.runID, { code: "invalid_target", message: `node "${target}" is missing from the snapshot`, nodeID: target })
      return false
    }
    const agent = await this.native.getAgent(node.agent)
    if (!agent) {
      await this.failRun(projectID, run.runID, {
        code: "agent_unavailable",
        message: `agent "${node.agent}" is no longer available`,
        nodeID: target,
      })
      return false
    }
    if (agent.hidden || agent.mode === "subagent") {
      await this.failRun(projectID, run.runID, {
        code: "agent_unavailable",
        message: `agent "${node.agent}" is not selectable by workflows (hidden or subagent-only)`,
        nodeID: target,
      })
      return false
    }
    if (!agent.model) {
      const fallback = await this.native.getDefaultModel().catch(() => undefined)
      if (!fallback) {
        await this.failRun(projectID, run.runID, {
          code: "agent_unavailable",
          message: `agent "${node.agent}" has no model and no default model is configured`,
          nodeID: target,
        })
        return false
      }
    }
    if (!run.runSessionID) {
      await this.failRun(projectID, run.runID, { code: "internal_error", message: "workflow run session is missing", nodeID: target })
      return false
    }

    const graph = this.graph(run)
    const stepIndex = run.stepCount + 1
    const previousSteps = await this.store.listSteps(projectID, run.runID).catch(() => [])
    const attempt =
      previousSteps.filter((step) => step.seq === stepIndex).length + 1
    const stepID = newStepID(stepIndex, attempt)
    const promptMessageID = newMessageID(this.now())
    const previous: PromptPreviousResult[] = previousSteps.slice(-3).map((step) => ({
      nodeID: step.nodeID,
      ...(step.result === undefined ? {} : { outcome: step.result.outcome }),
      summary: step.result?.summary ?? step.error?.message ?? "no result",
      feedback: step.result?.feedback ?? "",
    }))
    let sessionID: string
    let prompt: string
    try {
      const session = await this.native.createSession({
        parentID: run.runSessionID,
        agent: node.agent,
        title: `Workflow ${run.workflowID} / ${target} / step ${stepIndex}`,
        metadata: {
          plugin: "flowgraph",
          kind: "workflow-node",
          runID: run.runID,
          workflowID: run.workflowID,
          nodeID: target,
          stepID,
        },
      })
      sessionID = session.id
      prompt = buildNodePrompt({
        workflow: run.workflowSnapshot,
        graph,
        runID: run.runID,
        nodeID: target,
        stepIndex,
        maxSteps: run.maxSteps,
        objective: run.objective,
        runSessionID: run.runSessionID,
        nodeSessionID: sessionID,
        previousSessions: previousSteps.map((step) => step.sessionID).slice(-3),
        previous,
      })
    } catch (error) {
      await this.failRun(projectID, run.runID, {
        code: "session_create_failed",
        message: errorMessage(error),
        nodeID: target,
        ...(errorType(error) === undefined ? {} : { nativeErrorType: errorType(error) }),
      })
      return false
    }

    const step: StepRecord = {
      schemaVersion: 1,
      runID: run.runID,
      stepID,
      seq: stepIndex,
      nodeID: target,
      agentID: node.agent,
      sessionID,
      promptMessageID,
      attempt,
      status: "running",
      audit: { toolCalls: [], mutatingToolCalls: 0 },
      usage: zeroUsage(),
      startedAt: this.now(),
    }
    await this.store.putStep(projectID, step)

    this.invocations.register({
      runID: run.runID,
      projectID,
      stepID,
      sessionID,
      nodeID: target,
      allowedOutcomes: validOutcomes(graph, target),
      attempt,
      reported: 0,
    })

    let started = true
    const updated = await this.store.mutateRun(projectID, run.runID, null, (draft) => {
      if (draft.status !== "running") {
        started = false
        return
      }
      draft.currentNode = target
      draft.nextNode = null
      draft.activeStep = {
        stepID,
        stepIndex,
        attempt,
        nodeID: target,
        agentID: node.agent,
        sessionID,
        promptMessageID,
        phase: "session_created",
        startedAt: step.startedAt,
        resultAttempts: 0,
      }
    })
    await this.emitRun(updated)
    if (!started) {
      this.invocations.unregister(sessionID)
      await this.store.putStep(projectID, { ...step, status: "abandoned", completedAt: this.now() })
      return false
    }

    try {
      await this.native.prompt({ sessionID, messageID: promptMessageID, text: prompt, metadata: { runID: run.runID, stepID, nodeID: target } })
    } catch (error) {
      this.invocations.unregister(sessionID)
      await this.store.putStep(projectID, {
        ...step,
        status: "failed",
        error: { code: "prompt_failed", message: errorMessage(error), nodeID: target, stepID },
        completedAt: this.now(),
      })
      await this.failRun(projectID, run.runID, {
        code: "prompt_failed",
        message: errorMessage(error),
        nodeID: target,
        stepID,
        ...(errorType(error) === undefined ? {} : { nativeErrorType: errorType(error) }),
      })
      return false
    }

    const prompted = await this.store.mutateRun(projectID, run.runID, null, (draft) => {
      if (draft.status === "cancelled") return
      draft.stepCount = Math.max(draft.stepCount, stepIndex)
      if (draft.activeStep?.stepID === stepID) {
        draft.activeStep.phase = "prompted"
        draft.activeStep.promptedAt = this.now()
      }
    })
    await this.emitRun(prompted)
    return true
  }

  private async waitForNode(projectID: string, run: RunRecord, recovery: boolean): Promise<WaitResult> {
    const active = run.activeStep
    if (!active) return { type: "failed", failure: { code: "internal_error", message: "active step is missing" } }
    let startedAt = active.promptedAt ?? active.startedAt
    let currentActive = active
    const limits = run.workflowSnapshot.limits
    const nodeLimit = limits.node_timeout_seconds ?? Math.min(900, limits.timeout_seconds)
    const stepDeadline = Math.min(run.deadlineAt, startedAt + nodeLimit * 1_000)
    const graph = this.graph(run)
    let current = run

    while (true) {
      if (this.shuttingDown) {
        return {
          type: "blocked",
          blocker: {
            type: "host_unloaded",
            message: "the plugin was unloaded while the node was active",
            since: this.now(),
            nodeID: active.nodeID,
            stepID: active.stepID,
          },
        }
      }
      current = await this.requireRun(projectID, run.runID)
      if (current.activeStep) currentActive = current.activeStep
      if (current.status === "cancelled") {
        await this.native.interrupt(active.sessionID).catch(() => false)
        return { type: "cancelled" }
      }
      if (TERMINAL.has(current.status)) return { type: "cancelled" }
      if (this.now() >= current.deadlineAt || this.now() >= stepDeadline) {
        await this.native.interrupt(active.sessionID).catch(() => false)
        return {
          type: "failed",
          failure: {
            code: this.now() >= current.deadlineAt ? "run_timeout" : "node_timeout",
            message:
              this.now() >= current.deadlineAt
                ? `workflow exceeded its ${limits.timeout_seconds}s run timeout`
                : `node "${active.nodeID}" exceeded its ${nodeLimit}s timeout`,
            nodeID: active.nodeID,
            stepID: active.stepID,
          },
        }
      }

      current = await this.refreshPermissions(projectID, current, active.sessionID)

      const waitController = new AbortController()
      const timer = setTimeout(() => waitController.abort(), this.options.pollIntervalMs)
      try {
        await this.native.wait(active.sessionID, waitController.signal)
      } catch {
        // Experimental wait may return early or be unavailable. Polling below is authoritative.
      } finally {
        clearTimeout(timer)
      }

      let session: SessionSnapshot
      try {
        session = await this.native.getSession(active.sessionID)
      } catch (error) {
        return {
          type: "failed",
          failure: {
            code: "session_unavailable",
            message: errorMessage(error),
            nodeID: active.nodeID,
            stepID: active.stepID,
            ...(errorType(error) === undefined ? {} : { nativeErrorType: errorType(error) }),
          },
        }
      }

      if (session.time.idle !== undefined && session.time.idle >= startedAt) {
        if (session.outcome === "succeeded") {
          const report = await this.store.getReport(projectID, run.runID, active.stepID)
          if (report) {
            const audit = await this.audit(active.sessionID)
            return { type: "completed", result: report.result, session, audit }
          }
          if (recovery) {
            return {
              type: "blocked",
              blocker: {
                type: "missing_report",
                message:
                  `node "${currentActive.nodeID}" finished after restart without a structured report. ` +
                  `Resume with confirmRetry=true to retry it, or cancel the run.`,
                since: this.now(),
                nodeID: currentActive.nodeID,
                stepID: currentActive.stepID,
              },
            }
          }
          if (currentActive.resultAttempts >= limits.max_result_retries) {
            return {
              type: "failed",
              failure: {
                code: "missing_structured_result",
                message:
                  `node "${currentActive.nodeID}" finished without calling flowgraph_report after ` +
                  `${currentActive.resultAttempts} correction attempt(s)`,
                nodeID: active.nodeID,
                stepID: active.stepID,
              },
            }
          }
          const correctionID = newMessageID(this.now())
          const correction = await this.store.mutateRun(projectID, run.runID, null, (draft) => {
            if (draft.activeStep?.stepID === currentActive.stepID) {
              draft.activeStep.resultAttempts += 1
              draft.activeStep.phase = "prompting"
              draft.activeStep.promptMessageID = correctionID
            }
          })
          await this.emitRun(correction)
          try {
            await this.native.prompt({
              sessionID: active.sessionID,
              messageID: correctionID,
              text: buildReportCorrectionPrompt(graph, active.nodeID),
              metadata: { runID: run.runID, stepID: active.stepID, nodeID: active.nodeID, correction: "true" },
            })
          } catch (error) {
            return {
              type: "failed",
              failure: {
                code: "prompt_failed",
                message: errorMessage(error),
                nodeID: active.nodeID,
                stepID: active.stepID,
              },
            }
          }
          const promptedAt = this.now()
          const prompted = await this.store.mutateRun(projectID, run.runID, null, (draft) => {
            if (draft.activeStep?.stepID === currentActive.stepID) {
              draft.activeStep.phase = "prompted"
              draft.activeStep.promptedAt = promptedAt
            }
          })
          startedAt = promptedAt
          currentActive = prompted.activeStep ?? currentActive
          await this.emitRun(prompted)
          continue
        }
        if (session.outcome === "failed") {
          const context = await this.native.getContext(active.sessionID).catch(() => [])
          const idle = latestIdle(context)
          return {
            type: "failed",
            failure: {
              code: "native_failure",
              message: failedMessage(idle, "native agent execution failed"),
              nodeID: active.nodeID,
              stepID: active.stepID,
              ...(idle?.error?.type === undefined ? {} : { nativeErrorType: idle.error.type }),
            },
          }
        }
        if (session.outcome === "interrupted") {
          return {
            type: "blocked",
            blocker: {
              type: "node_interrupted",
              message: `node "${active.nodeID}" was interrupted; resume with confirmRetry=true to retry it`,
              since: this.now(),
              nodeID: active.nodeID,
              stepID: active.stepID,
            },
          }
        }
        return {
          type: "blocked",
          blocker: {
            type: "ambiguous_node",
            message: `node "${active.nodeID}" is idle without a terminal outcome`,
            since: this.now(),
            nodeID: active.nodeID,
            stepID: active.stepID,
          },
        }
      }

      if (current.status === "blocked" && current.blocker?.type === "permission" && current.pendingPermissions.length > 0) {
        await this.sleep(this.options.pollIntervalMs)
        continue
      }

      if (recovery && this.now() - startedAt >= this.options.recoveryGraceMs) {
        return {
          type: "blocked",
          blocker: {
            type: "ambiguous_node",
            message:
              `node "${active.nodeID}" did not report a terminal outcome after restart. ` +
              `Resume with confirmRetry=true to retry it, or cancel the run.`,
            since: this.now(),
            nodeID: active.nodeID,
            stepID: active.stepID,
          },
        }
      }

      await this.sleep(this.options.pollIntervalMs)
    }
  }

  private async audit(sessionID: string): Promise<ToolAudit> {
    try {
      return auditFromMessages(await this.native.getContext(sessionID))
    } catch {
      return { toolCalls: [], mutatingToolCalls: 0 }
    }
  }

  private async refreshPermissions(projectID: string, run: RunRecord, sessionID: string): Promise<RunRecord> {
    let permissions: PermissionSummary[]
    try {
      permissions = await this.native.listPermissions(sessionID)
    } catch {
      return run
    }
    const same =
      permissions.length === run.pendingPermissions.length &&
      permissions.every((permission, index) => permission.requestID === run.pendingPermissions[index]?.requestID)
    if (same) return run
    const updated = await this.store.mutateRun(projectID, run.runID, null, (draft) => {
      draft.pendingPermissions = permissions
      if (draft.status === "cancelled" || TERMINAL.has(draft.status)) return
      if (permissions.length > 0) {
        if (draft.status === "running") draft.status = "blocked"
        draft.blocker = {
          type: "permission",
          message: `node "${draft.activeStep?.nodeID ?? "unknown"}" is waiting for a native permission decision`,
          since: this.now(),
          ...(draft.activeStep === null ? {} : { nodeID: draft.activeStep.nodeID, stepID: draft.activeStep.stepID }),
        }
      } else if (draft.status === "blocked" && draft.blocker?.type === "permission") {
        draft.status = "running"
        draft.blocker = null
      }
    })
    await this.emitRun(updated)
    return updated
  }

  private async completeStep(projectID: string, run: RunRecord, waited: Extract<WaitResult, { type: "completed" }>): Promise<"continue" | "return"> {
    const active = run.activeStep
    if (!active) return "return"
    const graph = this.graph(run)
    let target: string
    try {
      target = resolveTransition(graph, active.nodeID, waited.result.outcome)
    } catch (error) {
      await this.failActiveStep(projectID, run, {
        code: "invalid_transition",
        message: errorMessage(error),
        nodeID: active.nodeID,
        stepID: active.stepID,
      })
      return "return"
    }

    const usage = usageFromSession(waited.session)
    const step: StepRecord = {
      schemaVersion: 1,
      runID: run.runID,
      stepID: active.stepID,
      seq: active.stepIndex,
      nodeID: active.nodeID,
      agentID: active.agentID,
      sessionID: active.sessionID,
      promptMessageID: active.promptMessageID,
      attempt: active.attempt,
      status: "completed",
      nativeOutcome: waited.session.outcome,
      result: waited.result,
      audit: waited.audit,
      usage,
      startedAt: active.startedAt,
      completedAt: this.now(),
    }
    await this.store.putStep(projectID, step)

    const repeats = repeatedTransitionCount(run.steps, active.nodeID, waited.result.outcome, target)
    const summary: StepSummary = {
      stepID: step.stepID,
      seq: step.seq,
      nodeID: step.nodeID,
      outcome: waited.result.outcome,
      status: "completed",
      sessionID: step.sessionID,
      startedAt: step.startedAt,
      completedAt: step.completedAt!,
    }

    const updated = await this.store.mutateRun(projectID, run.runID, null, (draft) => {
      draft.steps.push(summary)
      draft.lastStep = summary
      draft.activeStep = null
      draft.pendingPermissions = []
      draft.usage = addUsage(draft.usage, waited.session)
      draft.audit = {
        toolCalls: [...draft.audit.toolCalls, ...waited.audit.toolCalls].slice(-200),
        mutatingToolCalls: draft.audit.mutatingToolCalls + waited.audit.mutatingToolCalls,
      }
      if (draft.status === "cancelled") return
      if (repeats > draft.workflowSnapshot.limits.max_repeat_transitions) {
        draft.status = "failed"
        draft.failure = {
          code: "no_progress",
          message: `the same transition repeated ${repeats} times`,
          nodeID: active.nodeID,
          stepID: active.stepID,
        }
        draft.completedAt = this.now()
        return
      }
      if (target === "complete") {
        draft.status = "completed"
        draft.currentNode = null
        draft.nextNode = null
        draft.completedAt = this.now()
        return
      }
      if (target === "pause") {
        draft.status = "paused"
        draft.currentNode = null
        draft.nextNode = null
        draft.pause = { reason: "route", requestedAt: this.now() }
        return
      }
      draft.nextNode = target
      draft.currentNode = target
      if (draft.status === "pausing" || draft.status === "paused") {
        draft.status = "paused"
        draft.pause = { reason: "user", requestedAt: this.now() }
        return
      }
      const limit = checkBeforeNextNode(draft, target, this.now())
      if (limit) {
        draft.status = "failed"
        draft.failure = { code: limit.code, message: limit.message, nodeID: target }
        draft.completedAt = this.now()
        return
      }
      draft.status = "running"
    })
    this.invocations.unregister(active.sessionID)
    await this.emitRun(updated)
    if (updated.status === "paused" || TERMINAL.has(updated.status)) {
      await this.release(projectID, run.runID)
      return "return"
    }
    return "continue"
  }

  private async failActiveStep(projectID: string, run: RunRecord, failure: FailureInfo): Promise<void> {
    const active = run.activeStep
    if (active) {
      const existing = await this.store.getStep(projectID, run.runID, active.stepID).catch(() => undefined)
      if (existing) {
        await this.store.putStep(projectID, {
          ...existing,
          status: failure.code === "missing_structured_result" ? "failed" : "failed",
          error: failure,
          completedAt: this.now(),
        })
      }
      this.invocations.unregister(active.sessionID)
    }
    const updated = await this.store.mutateRun(projectID, run.runID, null, (draft) => {
      if (active && !draft.steps.some((item) => item.stepID === active.stepID)) {
        draft.steps.push({
          stepID: active.stepID,
          seq: active.stepIndex,
          nodeID: active.nodeID,
          status: "failed",
          sessionID: active.sessionID,
          startedAt: active.startedAt,
          completedAt: this.now(),
        })
      }
      draft.activeStep = null
      draft.pendingPermissions = []
      if (draft.status === "cancelled") return
      draft.status = "failed"
      draft.failure = failure
      draft.completedAt = this.now()
    })
    await this.emitRun(updated)
    await this.release(projectID, run.runID)
  }

  private async blockActiveStep(projectID: string, run: RunRecord, blocker: Blocker): Promise<void> {
    const active = run.activeStep
    if (active) {
      const existing = await this.store.getStep(projectID, run.runID, active.stepID).catch(() => undefined)
      if (existing) {
        await this.store.putStep(projectID, {
          ...existing,
          status: blocker.type === "node_interrupted" ? "interrupted" : "ambiguous",
          completedAt: this.now(),
        })
      }
      this.invocations.unregister(active.sessionID)
    }
    const updated = await this.store.mutateRun(projectID, run.runID, null, (draft) => {
      if (active && !draft.steps.some((item) => item.stepID === active.stepID)) {
        draft.steps.push({
          stepID: active.stepID,
          seq: active.stepIndex,
          nodeID: active.nodeID,
          status: blocker.type === "node_interrupted" ? "interrupted" : "ambiguous",
          sessionID: active.sessionID,
          startedAt: active.startedAt,
          completedAt: this.now(),
        })
      }
      if (draft.status === "cancelled") return
      draft.status = "blocked"
      draft.blocker = blocker
      if (draft.activeStep) draft.activeStep.phase = "ambiguous"
    })
    await this.emitRun(updated)
    // Keep the project lock while blocked to prevent a conflicting run from mutating the same tree.
  }

  private async setPaused(projectID: string, run: RunRecord, reason: "user" | "route" | "no_progress"): Promise<void> {
    const updated = await this.store.mutateRun(projectID, run.runID, null, (draft) => {
      if (draft.status === "cancelled" || TERMINAL.has(draft.status)) return
      draft.status = "paused"
      draft.pause = { reason, requestedAt: this.now() }
      draft.activeStep = null
      draft.pendingPermissions = []
      draft.blocker = null
    })
    await this.emitRun(updated)
    await this.release(projectID, run.runID)
  }

  private async pauseForRoute(projectID: string, run: RunRecord): Promise<void> {
    await this.setPaused(projectID, run, "route")
  }

  private async completeRun(projectID: string, run: RunRecord): Promise<void> {
    const updated = await this.store.mutateRun(projectID, run.runID, null, (draft) => {
      if (draft.status === "cancelled") return
      draft.status = "completed"
      draft.currentNode = null
      draft.nextNode = null
      draft.completedAt = this.now()
      draft.activeStep = null
      draft.blocker = null
    })
    await this.emitRun(updated)
    await this.release(projectID, run.runID)
  }

  private async bumpRecovery(projectID: string, run: RunRecord): Promise<RunRecord> {
    const attempts = run.recovery.attempts + 1
    const updated = await this.store.mutateRun(projectID, run.runID, null, (draft) => {
      draft.recovery.attempts = attempts
      draft.recovery.lastAttemptAt = this.now()
      draft.recovery.reason = "reconciling active node after restart"
      if (attempts > draft.workflowSnapshot.limits.max_recovery_attempts) {
        draft.status = "failed"
        draft.failure = {
          code: "recovery_exhausted",
          message: `workflow exceeded ${draft.workflowSnapshot.limits.max_recovery_attempts} recovery attempts`,
        }
        draft.completedAt = this.now()
        draft.activeStep = null
        draft.blocker = null
      }
    })
    await this.emitRun(updated)
    if (updated.status === "failed") await this.release(projectID, run.runID)
    return updated
  }

  async failRun(projectID: string, runID: string, failure: FailureInfo): Promise<void> {
    const existing = await this.store.getRun(projectID, runID).catch(() => undefined)
    if (existing?.activeStep) {
      await this.native.interrupt(existing.activeStep.sessionID).catch(() => false)
      this.invocations.unregister(existing.activeStep.sessionID)
    }
    const updated = await this.store.mutateRun(projectID, runID, null, (draft) => {
      draft.activeStep = null
      draft.pendingPermissions = []
      if (draft.status === "cancelled") return
      draft.status = "failed"
      draft.failure = failure
      draft.completedAt = this.now()
    })
    await this.emitRun(updated)
    await this.release(projectID, runID)
  }

  async pause(projectID: string, runID: string, expectedRevision: number, requestID: string): Promise<RunRecord> {
    return this.controlMutex.run(runID, async () => {
      const current = await this.requireRun(projectID, runID)
      if (current.recentControlRequests[requestID]) return current
      const updated = await this.store.mutateRun(projectID, runID, expectedRevision, (draft) => {
        if (draft.recentControlRequests[requestID]) return
        draft.recentControlRequests[requestID] = { operation: "pause", at: this.now(), revision: draft.revision + 1 }
        if (TERMINAL.has(draft.status)) return
        if (draft.status === "paused" || draft.status === "blocked") return
        if (draft.activeStep) {
          draft.status = "pausing"
        } else {
          draft.status = "paused"
          draft.pause = { reason: "user", requestedAt: this.now() }
          draft.blocker = null
        }
      })
      await this.emitRun(updated)
      if (updated.status === "paused") await this.release(projectID, runID)
      return updated
    })
  }

  async resume(
    projectID: string,
    runID: string,
    expectedRevision: number,
    requestID: string,
    confirmRetry: boolean,
  ): Promise<RunRecord> {
    const run = await this.requireRun(projectID, runID)
    if (run.recentControlRequests[requestID]) return run
    if (run.activeStep) {
      const live = await this.native.listPermissions(run.activeStep.sessionID).catch(() => run.pendingPermissions)
      if (live.length > 0) throw new PermissionPendingError(live)
    }
    if (
      run.status === "blocked" &&
      run.activeStep &&
      run.blocker?.type !== "permission" &&
      !confirmRetry
    ) {
      throw new AmbiguousResumeError()
    }
    if (run.status === "paused" && run.pause?.reason === "route") {
      throw new NotResumableError("a workflow paused at a terminal route is not resumable; start a new run")
    }
    if (TERMINAL.has(run.status)) {
      throw new NotResumableError(`a ${run.status} run is not resumable`)
    }

    const updated = await this.controlMutex.run(runID, async () => {
      let stepToAbandon: StepRecord | undefined
      if (run.status === "blocked" && run.activeStep && confirmRetry && run.blocker?.type !== "permission") {
        stepToAbandon = await this.store.getStep(projectID, runID, run.activeStep.stepID).catch(() => undefined)
      }
      const next = await this.store.mutateRun(projectID, runID, expectedRevision, (draft) => {
        if (draft.recentControlRequests[requestID]) return
        draft.recentControlRequests[requestID] = { operation: "resume", at: this.now(), revision: draft.revision + 1 }
        const previousBlockerType = draft.blocker?.type
        draft.status = "running"
        draft.blocker = null
        draft.pause = null
        if (
          draft.activeStep &&
          previousBlockerType !== "permission" &&
          (draft.activeStep.phase === "ambiguous" || confirmRetry)
        ) {
          draft.activeStep = null
        }
      })
      if (stepToAbandon) {
        await this.store.putStep(projectID, { ...stepToAbandon, status: "abandoned", completedAt: this.now() })
      }
      await this.emitRun(next)
      return next
    })
    await this.start(projectID, runID)
    return updated
  }

  async cancel(projectID: string, runID: string, expectedRevision: number, requestID: string): Promise<RunRecord> {
    const run = await this.requireRun(projectID, runID)
    if (run.recentControlRequests[requestID]) return run
    if (run.revision !== expectedRevision) throw new RevisionConflictError(run.revision)
    let accepted = false
    if (run.activeStep) {
      accepted = await this.native.interrupt(run.activeStep.sessionID).catch(() => false)
    }
    const updated = await this.store.mutateRun(projectID, runID, expectedRevision, (draft) => {
      if (draft.recentControlRequests[requestID]) return
      draft.recentControlRequests[requestID] = { operation: "cancel", at: this.now(), revision: draft.revision + 1 }
      if (TERMINAL.has(draft.status)) return
      draft.status = "cancelled"
      draft.cancel = { requestedAt: this.now(), interruptAccepted: accepted }
      draft.completedAt = this.now()
      draft.blocker = null
      draft.pendingPermissions = []
      draft.activeStep = null
    })
    this.active.get(runID)?.controller.abort()
    this.invocations.unregister(run.activeStep?.sessionID ?? "")
    await this.emitRun(updated)
    await this.release(projectID, runID)
    return updated
  }

  private registerRecoveredInvocation(run: RunRecord): void {
    const active = run.activeStep
    if (!active) return
    const graph = this.graph(run)
    this.invocations.register({
      runID: run.runID,
      projectID: run.project.id,
      stepID: active.stepID,
      sessionID: active.sessionID,
      nodeID: active.nodeID,
      allowedOutcomes: validOutcomes(graph, active.nodeID),
      attempt: active.attempt,
      reported: 0,
    })
  }

  async recoverProject(projectID: string): Promise<void> {
    const runs = await this.store.listRuns(projectID).catch(() => [])
    for (const run of runs) {
      if (this.active.has(run.runID) || this.heldLocks.has(run.runID)) continue
      this.registerRecoveredInvocation(run)
      if (run.status === "blocked") {
        try {
          await this.acquire(projectID, run)
          void this.watchBlocked(projectID, run.runID)
        } catch (error) {
          if (!(error instanceof ProjectBusyError)) throw error
        }
        continue
      }
      if (run.status !== "running" && run.status !== "pausing") continue
      try {
        await this.start(projectID, run.runID, { recovery: true })
      } catch (error) {
        if (!(error instanceof ProjectBusyError)) throw error
      }
    }
  }

  private async watchBlocked(projectID: string, runID: string): Promise<void> {
    if (this.blockedWatchers.has(runID)) return
    this.blockedWatchers.add(runID)
    try {
      while (!this.shuttingDown) {
        const run = await this.store.getRun(projectID, runID).catch(() => undefined)
        if (!run || TERMINAL.has(run.status)) {
          await this.release(projectID, runID)
          return
        }
        if (run.status !== "blocked" || this.active.has(runID)) return
        await this.sleep(1_000)
      }
    } finally {
      this.blockedWatchers.delete(runID)
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const entries = Array.from(this.active.entries())
    for (const [runID, entry] of entries) {
      const run = await this.store.getRun(entry.projectID, runID).catch(() => undefined)
      if (run?.activeStep) await this.native.interrupt(run.activeStep.sessionID).catch(() => false)
      entry.controller.abort()
    }
    await Promise.race([
      Promise.allSettled(entries.map(([, entry]) => entry.promise)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])
    await this.locks.releaseAll()
    this.heldLocks.clear()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

function failedMessage(idle: { error?: { message?: string } } | undefined, fallback: string): string {
  return idle?.error?.message ? errorMessage(idle.error.message, fallback) : fallback
}
