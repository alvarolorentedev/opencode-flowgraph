import { hostname } from "node:os"
import { setTimeout as sleep } from "node:timers/promises"
import { KeyedMutex } from "../util/mutex.js"
import { errorMessage, errorType } from "../util/redact.js"
import { newMessageID, newStepID } from "../util/ids.js"
import { buildGraph, resolveTransition, validOutcomes } from "../workflow/graph.js"
import { buildNodePrompt, buildReportCorrectionPrompt } from "./prompts.js"
import { mergeUsage, zeroUsage } from "./results.js"
import { RevisionConflictError, type WorkflowStore } from "../state/store.js"
import type { ActiveStep, Blocker, Branch, FailureInfo, PermissionSummary, RunRecord, RunStatus, StepRecord, StepSummary } from "../state/types.js"
import { RunOwnershipError, type RunLock, type RunLockManager } from "../state/concurrency.js"
import type { ExecutionSnapshot, HarnessAdapter } from "./harness.js"
import type { InvocationRegistry } from "./report-intake.js"
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
  harness: HarnessAdapter
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

export class InvalidHumanResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidHumanResponseError"
  }
}

export type HumanDecision = {
  nodeID?: string | undefined
  outcome: string
  summary?: string | undefined
  feedback?: string | undefined
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
  private readonly harness: HarnessAdapter
  private readonly invocations: InvocationRegistry
  private readonly now: () => number
  private readonly options: RunnerOptions
  private readonly shutdownSignal = new AbortController()
  private readonly deferredRecovery = new Set<string>()

  constructor(private readonly deps: RunnerDeps) {
    this.store = deps.store
    this.harness = deps.harness
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

  private async ownsHarness(run: RunRecord): Promise<boolean> {
    const owner = await this.store.getRunHarness(run.project.id, run.runID)
    if (owner) return owner.id === this.harness.capabilities.id
    return this.harness.capabilities.sessions.adoptLegacyRuns
  }

  private async assertHarness(run: RunRecord): Promise<void> {
    const owner = await this.store.getRunHarness(run.project.id, run.runID)
    if (owner) {
      if (owner.id !== this.harness.capabilities.id) {
        throw new NotResumableError(
          `run belongs to harness "${owner.id}", not "${this.harness.capabilities.id}"`,
        )
      }
      return
    }
    if (!this.harness.capabilities.sessions.adoptLegacyRuns) {
      throw new NotResumableError("run predates harness identity and cannot be resumed by this harness")
    }
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
      await this.assertHarness(run)
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
      if (!run.runSessionID && !checkRunDeadline(run, this.now()) && this.harness.capabilities.sessions.runScope) {
        const createRunScope = this.harness.createRunScope
        if (createRunScope) {
          const session = await createRunScope.call(this.harness, {
            title: `Workflow ${run.workflowID} ${run.runID}`,
            metadata: { plugin: "flowgraph", kind: "workflow-run", runID, workflowID: run.workflowID },
          })
          await this.update(run, (draft) => { draft.runSessionID = session.ref })
        }
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
            if (!node) return true
            if ("agent" in node) return false
            if ("human" in node) return branch.blocker?.type !== "human_input"
            return true
          })) {
            run = await this.update(run, (draft) => advance(draft, this.now(), true))
          }
          const branch = run.execution!.branches.find((item) => !item.active)
          if (branch && run.status === "running") {
            const node = definitionOf(run, branch.workflowID).nodes[branch.nodeID]
            if (node && "agent" in node) run = await this.admit(run, branch)
          }
        }
        if (TERMINAL.has(run.status) || run.status === "paused") await this.release(key, owner)
        return run
      })
      if (signal.aborted || TERMINAL.has(run.status) || run.status === "paused") return
      if (run.status === "running" && run.execution!.branches.some((branch) => {
        if (branch.active) return false
        const node = definitionOf(run, branch.workflowID).nodes[branch.nodeID]
        return node !== undefined && "agent" in node
      })) continue

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

  private completionInstruction(nodeID: string, allowedOutcomes: string[]): string {
    return this.harness.completionInstruction?.({ nodeID, allowedOutcomes })
      ?? "Report the structured result for this node."
  }

  private async admit(run: RunRecord, branch: Branch): Promise<RunRecord> {
    const nodeID = branch.nodeID
    const timeout = checkRunDeadline(run, this.now())
    if (timeout) return this.fail(run, timeout)
    if (run.stepCount >= run.maxSteps) return this.fail(run, this.stepLimit(run, nodeID))
    const workflow = definitionOf(run, branch.workflowID)
    const node = workflow.nodes[nodeID]
    if (!node || !("agent" in node)) throw new Error("expected an agent node")

    const agent = await this.harness.resolveAgent(node.agent)
    const selectable = agent?.selectable ?? (agent !== undefined && !agent.hidden && agent.mode !== "subagent")
    if (!agent || !selectable) {
      const message = agent?.reason?.message ?? `agent "${node.agent}" is unavailable or not selectable`
      return this.fail(run, { code: "agent_unavailable", message, nodeID })
    }

    const stepIndex = run.execution!.nextStep
    let attempt = 1
    while (await this.store.getStep(run.project.id, run.runID, newStepID(stepIndex, attempt))) attempt += 1
    const stepID = newStepID(stepIndex, attempt)
    const metadata = { runID: run.runID, workflowID: branch.workflowID, nodeID, stepID }
    const previous = (await Promise.all(branch.previous.map((id) => this.store.getStep(run.project.id, run.runID, id))))
      .filter((step): step is StepRecord => step !== undefined)

    let sessionID: string
    try {
      const session = await this.harness.createSession({
        agentRef: node.agent,
        ...(run.runSessionID === null ? {} : { parent: run.runSessionID }),
        title: `Workflow ${branch.workflowID} / ${nodeID} / step ${stepIndex}`,
        metadata: { ...metadata, plugin: "flowgraph", kind: "workflow-node" },
      })
      sessionID = session.ref
    } catch (error) {
      return this.fail(run, { code: "session_create_failed", message: errorMessage(error), nodeID, nativeErrorType: errorType(error) })
    }

    const active: ActiveStep = {
      stepID, stepIndex, attempt, nodeID, agentID: node.agent, sessionID,
      promptMessageID: newMessageID(this.now()),
      phase: "session_created", startedAt: this.now(), resultAttempts: 0,
      ...(branch.calls.length > 0 && { workflowID: branch.workflowID, callPath: branch.calls.map((frame) => frame.nodeID) }),
    }
    const graph = buildGraph(workflow)
    const outcomes = validOutcomes(graph, nodeID)
    const prompt = buildNodePrompt({
      workflow, graph, runID: run.runID, nodeID, stepIndex: run.stepCount + 1, maxSteps: run.maxSteps,
      objective: run.objective,
      ...(run.runSessionID === null ? {} : { runSessionID: run.runSessionID }),
      harnessName: this.harness.capabilities.displayName,
      completionInstruction: this.completionInstruction(nodeID, outcomes),
      nodeSessionID: sessionID, joined: branch.joined === true,
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
      await this.harness.submit({
        session: active.sessionID, submission: active.promptMessageID, text,
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
      if (this.harness.submissionState) {
        const state = await this.harness.submissionState(sessionID, active.promptMessageID).catch(() => "unknown" as const)
        if (state === "admitted") return { type: "admitted", at: active.startedAt }
        if (state === "not_admitted" && active.resultAttempts === 0 && active.phase !== "prompting") {
          return { type: "unadmitted" }
        }
      }
      return blocked("ambiguous_node", `could not reconcile prompt admission for node "${nodeID}"`)
    }

    const limits = definitionOf(run, branch.workflowID).limits
    const nodeLimit = limits.node_timeout_seconds ?? Math.min(900, limits.timeout_seconds)
    if (this.now() >= active.startedAt + nodeLimit * 1_000) {
      return { type: "failed", failure: { code: "node_timeout", message: `node "${nodeID}" exceeded its ${nodeLimit}s timeout`, nodeID, stepID } }
    }

    const permissions = await this.harness.pendingPermissions(sessionID).catch(() => ({ state: "unknown" as const }))
    if (permissions.state === "unknown") {
      return blocked("ambiguous_node", `could not determine pending permissions for node "${nodeID}"`)
    }
    if (permissions.state === "pending") {
      const items = permissions.items.slice(0, 50)
      const previous = branch.permissions ?? []
      if (items.length !== previous.length || items.some((item, index) => item.requestID !== previous[index]?.requestID)) {
        return { type: "permissions", permissions: items }
      }
      return
    }

    let snapshot: ExecutionSnapshot
    try {
      snapshot = await this.harness.inspect(sessionID)
    } catch (error) {
      return { type: "failed", failure: { code: "session_unavailable", message: errorMessage(error), nodeID, stepID, nativeErrorType: errorType(error) } }
    }

    if (snapshot.finishedAt !== undefined && snapshot.finishedAt < (active.promptedAt ?? active.startedAt)) {
      // A terminal snapshot from before this prompt is stale.
      return
    }
    if (snapshot.state === "running" || snapshot.state === "starting") {
      if (recovering && Date.now() - recoveredAt >= this.options.recoveryGraceMs) {
        return blocked("ambiguous_node", `node "${nodeID}" did not report a terminal outcome after restart`)
      }
      return
    }
    if (snapshot.state === "unknown") {
      if (recovering && Date.now() - recoveredAt < this.options.recoveryGraceMs) return
      return blocked("ambiguous_node", `node "${nodeID}" is idle without a terminal outcome`)
    }

    switch (snapshot.state) {
      case "succeeded": {
        const report = await this.store.getReport(run.project.id, run.runID, stepID)
        if (report?.sessionID === sessionID) {
          const audit = snapshot.audit ?? { toolCalls: [], mutatingToolCalls: 0 }
          audit.toolCalls = audit.toolCalls.slice(-200)
          return { type: "completed", step: {
            ...stepRecord(run, active), status: "completed", result: report.result, nativeOutcome: "succeeded",
            usage: snapshot.usage ?? zeroUsage(), audit, completedAt: snapshot.finishedAt ?? this.now(),
          } }
        }
        if (recovering) return blocked("missing_report", `node "${nodeID}" finished after restart without a structured report`)
        if (!this.harness.capabilities.results.corrections) {
          return { type: "failed", failure: {
            code: "missing_structured_result",
            message: `node "${nodeID}" finished without a structured result and the harness does not support corrections`,
            nodeID, stepID,
          } }
        }
        if (active.resultAttempts < limits.max_result_retries) return { type: "correction" }
        return { type: "failed", failure: {
          code: "missing_structured_result",
          message: `node "${nodeID}" finished without a structured result after ${active.resultAttempts} correction attempt(s)`,
          nodeID, stepID,
        } }
      }
      case "failed":
        return { type: "failed", failure: {
          code: "native_failure", message: errorMessage(snapshot.error?.message, "native agent execution failed"),
          nodeID, stepID, nativeErrorType: snapshot.error?.type,
        } }
      case "interrupted":
      case "cancelled":
        return blocked("node_interrupted", `node "${nodeID}" was interrupted; resume with confirmRetry=true to retry it`)
      default:
        return blocked("ambiguous_node", `node "${nodeID}" is idle without a terminal outcome`)
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
        const graph = buildGraph(definitionOf(run, branch.workflowID))
        await this.prompt(
          next,
          branch,
          correcting,
          buildReportCorrectionPrompt(
            graph,
            active.nodeID,
            this.completionInstruction(active.nodeID, validOutcomes(graph, active.nodeID)),
          ),
        )
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
      const accepted = await this.harness.cancel(step.sessionID).catch(() => false)
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
    const state = await this.harness.pendingPermissions(step.sessionID).catch(() => ({ state: "unknown" as const }))
    if (state.state === "pending") return state.items
    if (state.state === "none") return []
    return run.execution ? persisted ?? [] : run.pendingPermissions
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
      await this.assertHarness(current)
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
      const permissionStates = await Promise.all(activeSteps(run).map((step) =>
        runner.harness.pendingPermissions(step.sessionID).catch(() => ({ state: "unknown" as const }))))
      if (permissionStates.some((state) => state.state === "unknown")) {
        throw new NotResumableError("cannot confirm whether a permission request is pending; refusing to retry")
      }
      const permissions = Array.from(new Map(
        permissionStates.flatMap((state) => state.state === "pending" ? state.items : [])
          .map((item) => [item.requestID, item] as const),
      ).values())
      if (permissions.length > 0) throw new PermissionPendingError(permissions)

      const execution = initialize(run)
      const human = execution.branches.filter((branch) => branch.blocker?.type === "human_input")
      const pendingWork = execution.branches.some((branch) => branch.active || branch.blocker?.type === "permission")
      if (human.length > 0 && !pendingWork && run.status !== "paused") {
        throw new NotResumableError("the run is waiting for a human decision; use respondRun")
      }
      const ambiguous = execution.branches.filter((branch) => branch.active &&
        (branch.active.phase === "ambiguous" || (branch.blocker && branch.blocker.type !== "permission")))
      if (ambiguous.length > 0 && !confirmRetry) throw new AmbiguousResumeError()
      const stopped = (snapshot: ExecutionSnapshot | undefined): boolean =>
        snapshot !== undefined &&
        snapshot.state !== "running" &&
        snapshot.state !== "starting" &&
        snapshot.state !== "unknown"
      const records = await Promise.all(ambiguous.map(async (branch) => {
        const active = branch.active!
        let snapshot = await runner.harness.inspect(active.sessionID).catch(() => undefined)
        if (!stopped(snapshot)) {
          await runner.harness.cancel(active.sessionID).catch(() => false)
          snapshot = await runner.harness.inspect(active.sessionID).catch(() => undefined)
          if (!stopped(snapshot)) {
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

  async respond(
    projectID: string,
    runID: string,
    expectedRevision: number,
    requestID: string,
    decision: HumanDecision,
  ): Promise<RunRecord> {
    return this.control(projectID, runID, expectedRevision, requestID, async (runner, run, key, owner) => {
      if (TERMINAL.has(run.status) || run.status === "paused" || run.status === "pausing") {
        throw new NotResumableError(`a ${run.status} run cannot accept a human decision`)
      }
      if (!run.execution) throw new NotResumableError("the run has no pending nodes")
      const waiting = run.execution.branches.filter((branch) =>
        !branch.active && branch.blocker?.type === "human_input" && branch.blocker.nodeID === branch.nodeID)
      const branch = decision.nodeID === undefined
        ? waiting.length === 1 ? waiting[0] : undefined
        : waiting.find((item) => item.nodeID === decision.nodeID)
      if (!branch) {
        throw new NotResumableError(decision.nodeID !== undefined
          ? `no human step "${decision.nodeID}" is waiting for a decision`
          : waiting.length === 0
            ? "no human step is waiting for a decision"
            : "multiple human steps are waiting; specify nodeID")
      }
      const workflow = definitionOf(run, branch.workflowID)
      const node = workflow.nodes[branch.nodeID]
      if (!node || !("human" in node)) throw new NotResumableError(`node "${branch.nodeID}" is not a human step`)
      let target: string
      try {
        target = resolveTransition(buildGraph(workflow), branch.nodeID, decision.outcome)
      } catch (error) {
        throw new InvalidHumanResponseError(errorMessage(error, "invalid human outcome"))
      }
      if (run.stepCount >= run.maxSteps) return runner.fail(run, runner.stepLimit(run, branch.nodeID))

      const stepIndex = run.execution.nextStep
      let attempt = 1
      while (await runner.store.getStep(run.project.id, run.runID, newStepID(stepIndex, attempt))) attempt += 1
      const stepID = newStepID(stepIndex, attempt)
      const at = runner.now()
      const step: StepRecord = {
        schemaVersion: 1,
        runID: run.runID,
        stepID,
        seq: stepIndex,
        nodeID: branch.nodeID,
        ...(branch.calls.length > 0 && { workflowID: branch.workflowID, callPath: branch.calls.map((frame) => frame.nodeID) }),
        agentID: "human",
        sessionID: run.runSessionID ?? "human",
        promptMessageID: `human:${stepID}`,
        attempt,
        status: "completed",
        result: {
          outcome: decision.outcome,
          summary: decision.summary?.trim() || `Human selected "${decision.outcome}"`,
          feedback: decision.feedback ?? "",
          evidence: [],
        },
        audit: { toolCalls: [], mutatingToolCalls: 0 },
        usage: zeroUsage(),
        startedAt: at,
        completedAt: at,
      }
      await runner.store.putStep(run.project.id, step)

      const updated = await runner.update(run, (draft) => {
        draft.recentControlRequests[requestID] = { operation: "respond", at: runner.now(), revision: draft.revision + 1 }
        const current = draft.execution!.branches.find((item) => item.id === branch.id)!
        delete current.active
        delete current.blocker
        delete current.permissions
        delete current.joined
        current.nodeID = target
        current.previous = [...current.previous.slice(-2), stepID]
        recordStep(draft, step)
        draft.stepCount += 1
        draft.execution!.nextStep += 1
        draft.status = "running"
        try {
          if (trackTransition(current, step.nodeID, decision.outcome, target) > workflow.limits.max_repeat_transitions) {
            throw new RepeatedTransitionError(step.nodeID)
          }
          advance(draft, runner.now(), false)
        } catch (error) {
          if (!(error instanceof RepeatedTransitionError)) throw error
          draft.status = "failed"
          draft.failure = { code: "no_progress", message: error.message, nodeID: error.nodeID, stepID }
          draft.completedAt = runner.now()
          projectCheckpoint(draft, runner.now())
        }
      })
      if (updated.status === "failed") await runner.cleanup(updated)
      else if (!owner.promise) runner.launch(key, owner, updated, activeSteps(updated).length > 0)
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
    const candidates = runs.filter((run) =>
      (canonical === undefined || run.project.canonical === canonical) && run.status !== "paused" &&
      (!TERMINAL.has(run.status) || activeSteps(run).length > 0),
    )
    const owned = (await Promise.all(
      candidates.map(async (run) => [run, await this.ownsHarness(run)] as const),
    )).filter(([, mine]) => mine).map(([run]) => run)
    const outcomes = await Promise.allSettled(owned.map(async (run) => {
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
        if (run) await Promise.allSettled(activeSteps(run).map((step) => this.harness.cancel(step.sessionID)))
      })
      await owner.promise
    }))
  }
}
