import { hostname } from "node:os"
import { setTimeout as sleep } from "node:timers/promises"
import { KeyedMutex } from "../util/mutex.js"
import { errorMessage, errorType } from "../util/redact.js"
import { newMessageID, newStepID } from "../util/ids.js"
import { buildGraph, resolveTransition, validOutcomes } from "../workflow/graph.js"
import { buildNodePrompt, buildReportCorrectionPrompt } from "./prompts.js"
import { auditFromMessages, latestIdle, mergeUsage, usageFromSession, zeroUsage } from "./results.js"
import { RevisionConflictError, type WorkflowStore } from "../state/store.js"
import type { ActiveStep, Blocker, Branch, FailureInfo, PermissionSummary, RunRecord, RunStatus, StepRecord, StepSummary } from "../state/types.js"
import { RunOwnershipError, type RunLock, type RunLockManager } from "../state/concurrency.js"
import type { NativeRuntime, SessionSnapshot } from "./native-agents.js"
import type { InvocationRegistry } from "./report-tool.js"
import { checkRunDeadline } from "./limits.js"
import { activeSteps, advance, definitionOf, FrontierLimitError, initialize, projectCheckpoint, RepeatedTransitionError, trackTransition } from "./checkpoint.js"

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
  locks: RunLockManager
  invocations: InvocationRegistry
  emit: (payload: RunUpdatedPayload) => Promise<void>
  now?: () => number
  options?: Partial<RunnerOptions>
  instanceID?: string
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

type OwnedRun = {
  projectID: string
  runID: string
  runner: WorkflowRunner
  lock: RunLock
  controller: AbortController
  promise?: Promise<void>
}

type Observation =
  | { type: "permissions"; permissions: PermissionSummary[] }
  | { type: "admitted"; at: number }
  | { type: "unadmitted" }
  | { type: "correction" }
  | { type: "completed"; step: StepRecord & { result: NonNullable<StepRecord["result"]> } }
  | { type: "failed"; failure: FailureInfo }
  | { type: "blocked"; blocker: Blocker }

const TERMINAL = new Set<RunStatus>(["completed", "failed", "cancelled"])
const owners = new Map<string, OwnedRun>()
const gate = new KeyedMutex()

function ownershipKey(run: RunRecord): string {
  return JSON.stringify([run.project.id, run.project.canonical, run.runID])
}

function stepSummary(step: StepRecord): StepSummary {
  const { stepID, seq, nodeID, workflowID, callPath, status, sessionID, startedAt, completedAt, result } = step
  return { stepID, seq, nodeID, workflowID, callPath, status, sessionID, startedAt, completedAt, ...(result && { outcome: result.outcome }) }
}

function recordStep(run: RunRecord, step: StepRecord): void {
  const summary = stepSummary(step)
  const index = run.steps.findIndex((item) => item.stepID === step.stepID)
  if (index >= 0) run.steps[index] = summary
  else run.steps.push(summary)
  run.lastStep = summary
}

function stepRecord(run: RunRecord, active: ActiveStep): StepRecord {
  const { stepID, stepIndex, nodeID, workflowID, callPath, agentID, sessionID, promptMessageID, attempt, startedAt } = active
  return {
    schemaVersion: 1, runID: run.runID, stepID, seq: stepIndex, nodeID, workflowID, callPath,
    agentID, sessionID, promptMessageID, attempt, startedAt, status: "running",
    audit: { toolCalls: [], mutatingToolCalls: 0 }, usage: zeroUsage(),
  }
}

export class WorkflowRunner {
  private readonly store: WorkflowStore
  private readonly native: NativeRuntime
  private readonly invocations: InvocationRegistry
  private readonly now: () => number
  private readonly options: RunnerOptions
  private readonly shutdownSignal = new AbortController()
  private readonly deferredRecovery = new Set<string>()

  constructor(private readonly deps: RunnerDeps) {
    this.store = deps.store
    this.native = deps.native
    this.invocations = deps.invocations
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

  private async update(run: RunRecord, mutate: (draft: RunRecord) => void): Promise<RunRecord> {
    const updated = await this.store.mutateRun(run.project.id, run.runID, run.revision, mutate)
    await this.deps.emit({
      projectID: updated.project.id,
      projectCanonical: updated.project.canonical,
      directory: updated.project.directory,
      runID: updated.runID,
      workflowID: updated.workflowID,
      status: updated.status,
      currentNode: updated.currentNode,
      revision: updated.revision,
      timestamp: this.now(),
      ...(updated.blocker === null ? {} : { blocker: { type: updated.blocker.type, message: updated.blocker.message } }),
    }).catch(() => undefined)
    return updated
  }

  private async claim(key: string, run: RunRecord): Promise<OwnedRun> {
    const { signal } = this.shutdownSignal
    if (signal.aborted) throw new Error("workflow runner is shutting down")
    const lock = await this.deps.locks.acquire(run.project.id, run.project.canonical, run.runID)
    if (signal.aborted) {
      await lock.release()
      throw new Error("workflow runner is shutting down")
    }
    const owner = { runner: this, projectID: run.project.id, runID: run.runID, lock, controller: new AbortController() }
    owners.set(key, owner)
    return owner
  }

  private async release(key: string, owner: OwnedRun): Promise<void> {
    if (owners.get(key) !== owner) return
    await owner.lock.release().catch(() => undefined)
    owners.delete(key)
  }

  async start(projectID: string, runID: string, options: { recovery?: boolean } = {}): Promise<void> {
    const initial = await this.requireRun(projectID, runID)
    const key = ownershipKey(initial)
    await gate.run(key, async () => {
      if (owners.has(key)) return
      const run = await this.requireRun(projectID, runID)
      if (run.status === "paused" || (TERMINAL.has(run.status) && activeSteps(run).length === 0)) return
      const owner = await this.claim(key, run)
      this.launch(key, owner, run, options.recovery === true)
    })
  }

  private launch(key: string, owner: OwnedRun, run: RunRecord, recovery: boolean): void {
    owner.promise = this.runLoop(key, owner, run, recovery).catch(async (error: unknown) => {
      if (owner.controller.signal.aborted) return
      await gate.run(key, async () => {
        const current = await this.requireRun(run.project.id, run.runID)
        if (TERMINAL.has(current.status)) return
        const failure: FailureInfo = error instanceof FrontierLimitError
          ? this.stepLimit(current)
          : error instanceof RepeatedTransitionError
            ? { code: "no_progress", message: error.message, nodeID: error.nodeID }
            : { code: "internal_error", message: errorMessage(error) }
        await this.fail(current, failure)
      }).catch(() => undefined)
    }).finally(() => gate.run(key, () => this.release(key, owner)))
  }

  private async runLoop(key: string, owner: OwnedRun, initial: RunRecord, recovery: boolean): Promise<void> {
    const { id: projectID } = initial.project
    const { runID } = initial
    const { signal } = owner.controller
    const recoveredAt = Date.now()
    const recovering = new Set(recovery ? activeSteps(initial).map((step) => step.stepID) : [])

    await gate.run(key, async () => {
      if (signal.aborted) return
      let run = await this.requireRun(projectID, runID)
      if (TERMINAL.has(run.status)) {
        await this.cleanup(run)
        return
      }
      if (run.status === "paused") return
      const instanceID = this.deps.instanceID
      if (!run.execution || recovering.size > 0 || (instanceID && run.owner.instanceID !== instanceID)) {
        run = await this.update(run, (draft) => {
          initialize(draft)
          if (instanceID) draft.owner = { instanceID, hostname: hostname(), pid: process.pid }
          projectCheckpoint(draft, this.now())
          if (recovering.size > 0) {
            draft.recovery.attempts += 1
            draft.recovery.lastAttemptAt = this.now()
            draft.recovery.reason = "reconciling active nodes after restart"
          }
        })
        if (run.recovery.attempts > run.workflowSnapshot.limits.max_recovery_attempts) {
          await this.fail(run, { code: "recovery_exhausted", message: "workflow exceeded its recovery attempt limit" })
          return
        }
        for (const branch of run.execution!.branches) {
          if (branch.active && branch.active.phase !== "ambiguous") this.register(run, branch, branch.active)
        }
      }
      if (!run.runSessionID && !checkRunDeadline(run, this.now())) {
        const session = await this.native.createRootSession({
          title: `Workflow ${run.workflowID} ${run.runID}`,
          metadata: { plugin: "flowgraph", kind: "workflow-run", runID, workflowID: run.workflowID },
        })
        await this.update(run, (draft) => { draft.runSessionID = session.id })
      }
    })

    while (!signal.aborted) {
      const run = await gate.run(key, async () => {
        let run = await this.requireRun(projectID, runID)
        if (signal.aborted) return run
        if (TERMINAL.has(run.status) || run.status === "paused") {
          await this.release(key, owner)
          return run
        }
        const timeout = checkRunDeadline(run, this.now())
        if (timeout) return this.fail(run, timeout)

        if (run.status !== "pausing") {
          const ready = run.execution!.branches.filter((branch) => !branch.active)
          if (ready.some((branch) => {
            const node = definitionOf(run, branch.workflowID).nodes[branch.nodeID]
            return !node || !("agent" in node)
          })) {
            run = await this.update(run, (draft) => advance(draft, this.now(), true))
          }
          const branch = run.execution!.branches.find((item) => !item.active)
          if (branch && run.status === "running") run = await this.admit(run, branch)
        }
        if (TERMINAL.has(run.status) || run.status === "paused") await this.release(key, owner)
        return run
      })
      if (signal.aborted || TERMINAL.has(run.status) || run.status === "paused") return
      if (run.status === "running" && run.execution!.branches.some((branch) => !branch.active)) continue

      let changed = false
      await Promise.all(run.execution!.branches.map(async (branch) => {
        const active = branch.active
        if (!active || active.phase === "ambiguous") return
        const observation = await this.observe(run, branch, active, recovering.has(active.stepID), recoveredAt)
        if (!observation || signal.aborted) return
        await gate.run(key, async () => {
          const current = await this.requireRun(projectID, runID)
          if (signal.aborted || TERMINAL.has(current.status) || current.status === "paused") return
          const latest = current.execution!.branches.find((item) => item.id === branch.id)
          if (latest?.active?.stepID !== active.stepID) return
          await this.applyObservation(current, latest, active, observation)
          changed = true
        })
      }))
      if (!changed) await sleep(this.options.pollIntervalMs, undefined, { signal, ref: false }).catch(() => undefined)
    }
  }

  private stepLimit(run: RunRecord, nodeID?: string): FailureInfo {
    return {
      code: "max_steps_exhausted",
      message: `workflow reached max_steps (${run.maxSteps})${nodeID ? ` before executing node "${nodeID}"` : ""}`,
      nodeID,
    }
  }

  private async admit(run: RunRecord, branch: Branch): Promise<RunRecord> {
    const nodeID = branch.nodeID
    const timeout = checkRunDeadline(run, this.now())
    if (timeout) return this.fail(run, timeout)
    if (run.stepCount >= run.maxSteps) return this.fail(run, this.stepLimit(run, nodeID))
    const workflow = definitionOf(run, branch.workflowID)
    const node = workflow.nodes[nodeID]
    if (!node || !("agent" in node) || !run.runSessionID) throw new Error("expected an agent node and a run session")

    const agent = await this.native.getAgent(node.agent)
    if (!agent || agent.hidden || agent.mode === "subagent") {
      return this.fail(run, { code: "agent_unavailable", message: `agent "${node.agent}" is unavailable or not selectable`, nodeID })
    }
    const model = agent.model ?? await this.native.getDefaultModel().catch(() => undefined)
    if (!model) return this.fail(run, { code: "agent_unavailable", message: `agent "${node.agent}" has no model or default model`, nodeID })

    const stepIndex = run.execution!.nextStep
    let attempt = 1
    while (await this.store.getStep(run.project.id, run.runID, newStepID(stepIndex, attempt))) attempt += 1
    const stepID = newStepID(stepIndex, attempt)
    const metadata = { runID: run.runID, workflowID: branch.workflowID, nodeID, stepID }
    const previous = (await Promise.all(branch.previous.map((id) => this.store.getStep(run.project.id, run.runID, id))))
      .filter((step): step is StepRecord => step !== undefined)

    let sessionID: string
    try {
      const session = await this.native.createSession({
        parentID: run.runSessionID,
        agent: node.agent,
        title: `Workflow ${branch.workflowID} / ${nodeID} / step ${stepIndex}`,
        model,
        metadata: { ...metadata, plugin: "flowgraph", kind: "workflow-node" },
      })
      sessionID = session.id
    } catch (error) {
      return this.fail(run, { code: "session_create_failed", message: errorMessage(error), nodeID, nativeErrorType: errorType(error) })
    }

    const active: ActiveStep = {
      stepID, stepIndex, attempt, nodeID, agentID: node.agent, sessionID,
      promptMessageID: newMessageID(this.now()),
      phase: "session_created", startedAt: this.now(), resultAttempts: 0,
      ...(branch.calls.length > 0 && { workflowID: branch.workflowID, callPath: branch.calls.map((frame) => frame.nodeID) }),
    }
    const prompt = buildNodePrompt({
      workflow, graph: buildGraph(workflow), runID: run.runID, nodeID, stepIndex: run.stepCount + 1, maxSteps: run.maxSteps,
      objective: run.objective, runSessionID: run.runSessionID, nodeSessionID: sessionID, joined: branch.joined === true,
      previousSessions: previous.map((step) => step.sessionID),
      previous: previous.map((step) => ({
        nodeID: step.nodeID, summary: step.result?.summary ?? step.error?.message ?? "no result",
        feedback: step.result?.feedback ?? "", ...(step.result && { outcome: step.result.outcome }),
      })),
    })

    run = await this.update(run, (draft) => {
      draft.execution!.nextStep += 1
      draft.execution!.branches.find((item) => item.id === branch.id)!.active = active
      projectCheckpoint(draft, this.now())
    })
    await this.store.putStep(run.project.id, stepRecord(run, active))
    this.register(run, branch, active)
    return this.prompt(run, branch, active, prompt)
  }

  private register(run: RunRecord, branch: Branch, active: ActiveStep): void {
    this.invocations.register({
      runID: run.runID, projectID: run.project.id, stepID: active.stepID, sessionID: active.sessionID,
      nodeID: active.nodeID, allowedOutcomes: validOutcomes(buildGraph(definitionOf(run, branch.workflowID)), active.nodeID),
      attempt: active.attempt, reported: 0,
    })
  }

  private async prompt(run: RunRecord, branch: Branch, active: ActiveStep, text: string): Promise<RunRecord> {
    const at = this.now()
    try {
      await this.native.prompt({
        sessionID: active.sessionID, messageID: active.promptMessageID, text,
        metadata: { runID: run.runID, stepID: active.stepID, nodeID: active.nodeID, workflowID: branch.workflowID,
          ...(active.resultAttempts > 0 && { correction: "true" }) },
      })
    } catch (error) {
      return this.fail(run, { code: "prompt_failed", message: errorMessage(error), nodeID: active.nodeID, stepID: active.stepID,
        nativeErrorType: errorType(error) })
    }
    return this.markAdmitted(run, branch.id, at)
  }

  private async markAdmitted(run: RunRecord, branchID: string, at: number): Promise<RunRecord> {
    return this.update(run, (draft) => {
      const active = draft.execution!.branches.find((branch) => branch.id === branchID)!.active!
      if (active.resultAttempts === 0 && active.phase !== "prompted") draft.stepCount += 1
      active.phase = "prompted"
      active.promptedAt = at
      projectCheckpoint(draft, this.now())
    })
  }

  private async observe(run: RunRecord, branch: Branch, active: ActiveStep, recovering: boolean, recoveredAt: number): Promise<Observation | undefined> {
    const { nodeID, stepID, sessionID } = active
    const blocked = (type: Blocker["type"], message: string): Observation =>
      ({ type: "blocked", blocker: { type, message, since: this.now(), nodeID, stepID } })

    if (recovering) {
      const saved = await this.store.getStep(run.project.id, run.runID, stepID)
      if (saved?.status === "completed" && saved.result && saved.sessionID === sessionID) {
        return { type: "completed", step: { ...saved, result: saved.result } }
      }
    }

    if (active.phase === "prepared" || active.phase === "session_created" || active.phase === "prompting") {
      const messages = await this.native.getContext(sessionID).catch(() => undefined)
      const admitted = messages?.find((message) => message.type === "user" && message.id === active.promptMessageID)
      if (admitted) return { type: "admitted", at: admitted.time?.created || active.startedAt }
      if (messages?.length === 0 && active.resultAttempts === 0 && active.phase !== "prompting") return { type: "unadmitted" }
      return blocked("ambiguous_node", `could not reconcile prompt admission for node "${nodeID}"`)
    }

    const limits = definitionOf(run, branch.workflowID).limits
    const nodeLimit = limits.node_timeout_seconds ?? Math.min(900, limits.timeout_seconds)
    if (this.now() >= active.startedAt + nodeLimit * 1_000) {
      return { type: "failed", failure: { code: "node_timeout", message: `node "${nodeID}" exceeded its ${nodeLimit}s timeout`, nodeID, stepID } }
    }

    const permissions = (await this.native.listPermissions(sessionID).catch(() => branch.permissions ?? [])).slice(0, 50)
    const previous = branch.permissions ?? []
    if (permissions.length !== previous.length || permissions.some((item, index) => item.requestID !== previous[index]?.requestID)) {
      return { type: "permissions", permissions }
    }
    if (permissions.length > 0) return

    let session: SessionSnapshot
    try {
      session = await this.native.getSession(sessionID)
    } catch (error) {
      return { type: "failed", failure: { code: "session_unavailable", message: errorMessage(error), nodeID, stepID, nativeErrorType: errorType(error) } }
    }
    if (session.time.idle !== undefined && session.time.idle >= (active.promptedAt ?? active.startedAt)) {
      switch (session.outcome) {
        case "succeeded": {
          const report = await this.store.getReport(run.project.id, run.runID, stepID)
          if (report?.sessionID === sessionID) {
            const audit = auditFromMessages(await this.native.getContext(sessionID).catch(() => []))
            audit.toolCalls = audit.toolCalls.slice(-200)
            return { type: "completed", step: {
              ...stepRecord(run, active), status: "completed", result: report.result, nativeOutcome: session.outcome,
              usage: usageFromSession(session), audit, completedAt: this.now(),
            } }
          }
          if (recovering) return blocked("missing_report", `node "${nodeID}" finished after restart without a structured report`)
          if (active.resultAttempts < limits.max_result_retries) return { type: "correction" }
          return { type: "failed", failure: {
            code: "missing_structured_result",
            message: `node "${nodeID}" finished without calling flowgraph_report after ${active.resultAttempts} correction attempt(s)`,
            nodeID, stepID,
          } }
        }
        case "failed": {
          const idle = latestIdle(await this.native.getContext(sessionID).catch(() => []))
          return { type: "failed", failure: {
            code: "native_failure", message: errorMessage(idle?.error?.message, "native agent execution failed"),
            nodeID, stepID, nativeErrorType: idle?.error?.type,
          } }
        }
        case "interrupted":
          return blocked("node_interrupted", `node "${nodeID}" was interrupted; resume with confirmRetry=true to retry it`)
        default:
          return blocked("ambiguous_node", `node "${nodeID}" is idle without a terminal outcome`)
      }
    }
    if (recovering && Date.now() - recoveredAt >= this.options.recoveryGraceMs) {
      return blocked("ambiguous_node", `node "${nodeID}" did not report a terminal outcome after restart`)
    }
  }

  private async applyObservation(run: RunRecord, branch: Branch, active: ActiveStep, observation: Observation): Promise<void> {
    const timeout = checkRunDeadline(run, this.now())
    if (timeout) {
      await this.fail(run, timeout)
      return
    }
    const projectID = run.project.id
    const updateBranch = (fn: (draft: Branch) => void) => this.update(run, (draft) => {
      fn(draft.execution!.branches.find((item) => item.id === branch.id)!)
      projectCheckpoint(draft, this.now())
    })
    switch (observation.type) {
      case "permissions":
        await updateBranch((draft) => {
          draft.permissions = observation.permissions
          if (observation.permissions.length > 0) draft.blocker = {
            type: "permission", message: `node "${active.nodeID}" is waiting for a native permission decision`,
            since: this.now(), nodeID: active.nodeID, stepID: active.stepID,
          }
          else delete draft.blocker
        })
        return
      case "admitted":
        await this.markAdmitted(run, branch.id, observation.at)
        return
      case "unadmitted":
        this.invocations.unregister(active.sessionID)
        await this.store.putStep(projectID, { ...stepRecord(run, active), status: "abandoned", completedAt: this.now() })
        await updateBranch((draft) => { delete draft.active; delete draft.blocker; delete draft.permissions })
        return
      case "correction": {
        const correcting: ActiveStep = {
          ...active, phase: "prompting", promptMessageID: newMessageID(this.now()), resultAttempts: active.resultAttempts + 1,
        }
        const next = await updateBranch((draft) => { draft.active = correcting })
        await this.prompt(next, branch, correcting, buildReportCorrectionPrompt(buildGraph(definitionOf(run, branch.workflowID)), active.nodeID))
        return
      }
      case "completed":
        await this.complete(run, branch, active, observation)
        return
      case "failed":
        await this.fail(run, observation.failure)
        return
      case "blocked": {
        const step: StepRecord = { ...stepRecord(run, active), completedAt: this.now(),
          status: observation.blocker.type === "node_interrupted" ? "interrupted" : "ambiguous" }
        await this.store.putStep(projectID, step)
        this.invocations.unregister(active.sessionID)
        await this.update(run, (draft) => {
          const current = draft.execution!.branches.find((item) => item.id === branch.id)!
          if (active.phase !== "prompted" && active.resultAttempts === 0) draft.stepCount += 1
          current.active!.phase = "ambiguous"
          current.blocker = observation.blocker
          delete current.permissions
          recordStep(draft, step)
          projectCheckpoint(draft, this.now())
        })
      }
    }
  }

  private async complete(run: RunRecord, branch: Branch, active: ActiveStep, observation: Extract<Observation, { type: "completed" }>): Promise<void> {
    const { step } = observation
    const { result, audit } = step
    const workflow = definitionOf(run, branch.workflowID)
    let target: string
    try {
      target = resolveTransition(buildGraph(workflow), active.nodeID, result.outcome)
    } catch (error) {
      await this.fail(run, { code: "invalid_transition", message: errorMessage(error), nodeID: active.nodeID, stepID: active.stepID })
      return
    }
    await this.store.putStep(run.project.id, step)
    this.invocations.unregister(active.sessionID)
    const updated = await this.update(run, (draft) => {
      const current = draft.execution!.branches.find((item) => item.id === branch.id)!
      delete current.active
      delete current.blocker
      delete current.permissions
      delete current.joined
      current.nodeID = target
      current.previous = [...current.previous.slice(-2), active.stepID]
      recordStep(draft, step)
      draft.usage = mergeUsage(draft.usage, step.usage)
      draft.audit = {
        toolCalls: [...draft.audit.toolCalls, ...audit.toolCalls].slice(-200),
        mutatingToolCalls: draft.audit.mutatingToolCalls + audit.mutatingToolCalls,
      }
      const count = trackTransition(current, active.nodeID, result.outcome, target)
      try {
        if (count > workflow.limits.max_repeat_transitions) throw new RepeatedTransitionError(active.nodeID)
        advance(draft, this.now(), false)
      } catch (error) {
        if (!(error instanceof RepeatedTransitionError)) throw error
        draft.status = "failed"
        draft.failure = { code: "no_progress", message: error.message, nodeID: error.nodeID, stepID: active.stepID }
        draft.completedAt = this.now()
        projectCheckpoint(draft, this.now())
      }
    })
    if (updated.status === "failed") await this.cleanup(updated)
  }

  private async fail(run: RunRecord, failure: FailureInfo): Promise<RunRecord> {
    const failed = await this.update(run, (draft) => {
      draft.status = "failed"
      draft.failure = failure
      draft.completedAt = this.now()
    })
    return this.cleanup(failed)
  }

  private async cleanup(run: RunRecord): Promise<RunRecord> {
    const active = activeSteps(run)
    if (active.length === 0 && !run.execution?.branches.length) return run
    const interrupted = await Promise.all(active.map(async (step) => {
      const accepted = await this.native.interrupt(step.sessionID).catch(() => false)
      this.invocations.unregister(step.sessionID)
      return accepted
    }))
    const records = await Promise.all(active.map(async (active) => {
      const existing = await this.store.getStep(run.project.id, run.runID, active.stepID)
      if (existing && existing.status !== "running") return existing
      const failure = run.failure?.stepID === active.stepID ? run.failure : undefined
      return this.store.putStep(run.project.id, {
        ...stepRecord(run, active), status: failure ? "failed" : "interrupted", error: failure, completedAt: this.now(),
      })
    }))
    return this.update(run, (draft) => {
      for (const step of records) {
        // A prepared step may have been interrupted before it consumed a budget slot.
        if (draft.steps.length < draft.maxSteps || draft.steps.some((item) => item.stepID === step.stepID)) recordStep(draft, step)
      }
      if (draft.cancel) draft.cancel.interruptAccepted ||= interrupted.some(Boolean)
      if (draft.execution) {
        draft.execution.branches = []
        draft.execution.joins = {}
      }
      draft.activeStep = null
      draft.blocker = null
      draft.pendingPermissions = []
      draft.nextNode = null
    })
  }

  private async permissionsFor(run: RunRecord, step: ActiveStep): Promise<PermissionSummary[]> {
    const persisted = run.execution?.branches.find((branch) => branch.active?.stepID === step.stepID)?.permissions
    return this.native.listPermissions(step.sessionID).catch(() => run.execution ? persisted ?? [] : run.pendingPermissions)
  }

  async livePermissions(run: RunRecord): Promise<PermissionSummary[]> {
    const runner = owners.get(ownershipKey(run))?.runner ?? this
    const permissions = (await Promise.all(activeSteps(run).map((step) => runner.permissionsFor(run, step)))).flat()
    return Array.from(new Map(permissions.map((item) => [item.requestID, item])).values())
  }

  private async control(
    projectID: string, runID: string, expectedRevision: number, requestID: string,
    fn: (runner: WorkflowRunner, run: RunRecord, key: string, owner: OwnedRun) => Promise<RunRecord>,
  ): Promise<RunRecord> {
    const key = ownershipKey(await this.requireRun(projectID, runID))
    return gate.run(key, async () => {
      const current = await this.requireRun(projectID, runID)
      if (Object.hasOwn(current.recentControlRequests, requestID)) return current
      if (current.revision !== expectedRevision) throw new RevisionConflictError(current.revision)
      const owner = owners.get(key) ?? await this.claim(key, current)
      try {
        return await fn(owner.runner, current, key, owner)
      } finally {
        if (!owner.promise) await owner.runner.release(key, owner)
      }
    })
  }

  async pause(projectID: string, runID: string, expectedRevision: number, requestID: string): Promise<RunRecord> {
    return this.control(projectID, runID, expectedRevision, requestID, (runner, run) => runner.update(run, (draft) => {
      draft.recentControlRequests[requestID] = { operation: "pause", at: runner.now(), revision: draft.revision + 1 }
      if (TERMINAL.has(draft.status) || draft.status === "paused") return
      initialize(draft)
      draft.status = "pausing"
      projectCheckpoint(draft, runner.now())
    }))
  }

  async resume(projectID: string, runID: string, expectedRevision: number, requestID: string, confirmRetry: boolean): Promise<RunRecord> {
    return this.control(projectID, runID, expectedRevision, requestID, async (runner, run, key, owner) => {
      if (TERMINAL.has(run.status) || run.pause?.reason === "route") {
        throw new NotResumableError(`a ${run.status} run cannot be resumed`)
      }
      const permissions = await runner.livePermissions(run)
      if (permissions.length > 0) throw new PermissionPendingError(permissions)

      const execution = initialize(run)
      const ambiguous = execution.branches.filter((branch) => branch.active &&
        (branch.active.phase === "ambiguous" || (branch.blocker && branch.blocker.type !== "permission")))
      if (ambiguous.length > 0 && !confirmRetry) throw new AmbiguousResumeError()
      const records = await Promise.all(ambiguous.map(async (branch) => {
        const active = branch.active!
        let session = await runner.native.getSession(active.sessionID).catch(() => undefined)
        if (session?.time.idle === undefined || session.time.idle < (active.promptedAt ?? active.startedAt)) {
          await runner.native.interrupt(active.sessionID).catch(() => false)
          session = await runner.native.getSession(active.sessionID).catch(() => undefined)
          if (session?.time.idle === undefined || session.time.idle < (active.promptedAt ?? active.startedAt)) {
            throw new NotResumableError(`could not confirm node "${active.nodeID}" stopped`)
          }
        }
        return { ...stepRecord(run, active), status: "abandoned" as const, completedAt: runner.now() }
      }))
      for (const record of records) {
        await runner.store.putStep(projectID, record)
        runner.invocations.unregister(record.sessionID)
      }
      const updated = await runner.update(run, (draft) => {
        draft.recentControlRequests[requestID] = { operation: "resume", at: runner.now(), revision: draft.revision + 1 }
        const branches = initialize(draft).branches
        for (const branch of branches) {
          if (branch.blocker?.type === "permission") delete branch.blocker
          delete branch.permissions
          if (ambiguous.some((candidate) => candidate.id === branch.id)) {
            delete branch.active
            delete branch.blocker
          }
        }
        for (const record of records) recordStep(draft, record)
        draft.status = "running"
        draft.pause = null
        projectCheckpoint(draft, runner.now())
      })
      if (!owner.promise) runner.launch(key, owner, updated, activeSteps(updated).length > 0)
      return updated
    })
  }

  async cancel(projectID: string, runID: string, expectedRevision: number, requestID: string): Promise<RunRecord> {
    return this.control(projectID, runID, expectedRevision, requestID, async (runner, run) => {
      const updated = await runner.update(run, (draft) => {
        draft.recentControlRequests[requestID] = { operation: "cancel", at: runner.now(), revision: draft.revision + 1 }
        if (TERMINAL.has(draft.status)) return
        draft.status = "cancelled"
        draft.cancel = { requestedAt: runner.now(), interruptAccepted: false }
        draft.completedAt = runner.now()
      })
      return runner.cleanup(updated)
    })
  }

  async recoverProject(projectID: string, canonical?: string): Promise<void> {
    const runs = await this.store.listRuns(projectID)
    const outcomes = await Promise.allSettled(runs.filter((run) =>
      (canonical === undefined || run.project.canonical === canonical) && run.status !== "paused" &&
      (!TERMINAL.has(run.status) || activeSteps(run).length > 0),
    ).map(async (run) => {
      try {
        await this.start(projectID, run.runID, { recovery: true })
      } catch (error) {
        if (!(error instanceof RunOwnershipError)) throw error
        void this.retryRecovery(run)
      }
    }))
    const errors = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, "could not recover workflow runs")
  }

  private async retryRecovery(run: RunRecord): Promise<void> {
    const key = ownershipKey(run)
    if (this.deferredRecovery.has(key)) return
    this.deferredRecovery.add(key)
    const { signal } = this.shutdownSignal
    try {
      // A crashed process can leave a live-looking lock until the heartbeat expires.
      while (!signal.aborted) {
        await sleep(1_000, undefined, { signal, ref: false })
        try {
          await this.start(run.project.id, run.runID, { recovery: true })
          return
        } catch (error) {
          if (!(error instanceof RunOwnershipError)) throw error
        }
      }
    } catch (error) {
      if (!signal.aborted) console.error("flowgraph: recovery failed", errorMessage(error))
    } finally {
      this.deferredRecovery.delete(key)
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownSignal.abort()
    const entries = Array.from(owners).filter(([, owner]) => owner.runner === this)
    await Promise.allSettled(entries.map(async ([key, owner]) => {
      await gate.run(key, async () => {
        if (owners.get(key) !== owner) return
        owner.controller.abort()
        const run = await this.store.getRun(owner.projectID, owner.runID)
        if (run) await Promise.allSettled(activeSteps(run).map((step) => this.native.interrupt(step.sessionID)))
      })
      await owner.promise
    }))
  }
}
