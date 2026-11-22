// Reusable HarnessAdapter contract suite. A future adapter runs it by passing a
// factory that wires that adapter into WorkflowStore, ReportIntake, and
// WorkflowRunner. The suite imports no @opencode/* module.
import { afterEach, describe, expect, it } from "vitest"
import type { HarnessAdapter, HarnessCapabilities } from "../../src/execution/harness.js"
import type { InvocationRegistry } from "../../src/execution/report-intake.js"
import type { ReportIntake } from "../../src/execution/report-intake.js"
import type { WorkflowRunner } from "../../src/execution/runner.js"
import { NotResumableError } from "../../src/execution/runner.js"
import type { WorkflowStore } from "../../src/state/store.js"
import type { NodeResult } from "../../src/workflow/schema.js"
import { parseWorkflowSource } from "../../src/workflow/loader.js"
import { activeSteps } from "../../src/execution/checkpoint.js"
import { makeRunRecord, waitForRun } from "../fixtures/memory.js"

export type ContractBehavior = {
  report?: NodeResult
  outcome?: "succeeded" | "failed" | "interrupted"
  pendingPermission?: boolean
  delayMs?: number
  /** Finish the session without a terminal outcome. */
  unknownTerminal?: boolean
}

export type ContractScenario = (
  input: { nodeID: string; agent: string; text: string },
  count: number,
) => ContractBehavior

export type ContractVariant = {
  id?: string
  runScope?: boolean
  adoptLegacyRuns?: boolean
  resultsMechanism?: HarnessCapabilities["results"]["mechanism"]
  corrections?: boolean
  permissions?: "none" | "pending" | "unknown"
  permissionSurvivesRestart?: boolean
  admission?: "confirmed" | "ambiguous"
  security?: Partial<HarnessCapabilities["security"]>
}

export type ContractFixture = {
  harness: HarnessAdapter
  store: WorkflowStore
  invocations: InvocationRegistry
  intake: ReportIntake
  runner: WorkflowRunner
  /** Adapter-specific probe for declared security enforcement. */
  capabilityProbe?: () => Promise<string[]>
  stop: () => Promise<void>
}

export type ContractFactory = (options?: {
  scenario?: ContractScenario
  variant?: ContractVariant
  now?: () => number
}) => ContractFixture

/** Returns one finding per security claim the adapter cannot demonstrate. */
export async function capabilityFindings(
  harness: HarnessAdapter,
  probe?: () => Promise<string[]>,
): Promise<string[]> {
  const findings = probe === undefined ? [] : [...await probe()]
  const { security } = harness.capabilities
  if ((security.protectedPaths !== "none" || security.backgroundWork === "blocked") && probe === undefined) {
    findings.push("declared security enforcement has no capability probe")
  }
  return findings
}

const developerReport: NodeResult = { outcome: "done", summary: "implemented", feedback: "", evidence: [] }
const reviewerReport: NodeResult = { outcome: "approved", summary: "approved", feedback: "", evidence: [] }

function reports(input: { agent: string }): ContractBehavior {
  return { report: input.agent === "developer" ? developerReport : reviewerReport }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 4_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("timed out waiting for the harness contract condition")
}

const parallel = `version: 1
name: parallel
entry: dispatch
limits: { max_steps: 12 }
nodes:
  dispatch: { fork: [left, right], join: merge }
  left: { agent: developer, next: merge }
  right: { agent: reviewer, next: merge }
  merge:
    agent: developer
    routes: { done: complete }
`

const parent = `version: 1
name: parent
entry: prep
limits: { max_steps: 8 }
nodes:
  prep: { agent: developer, next: check }
  check: { workflow: child, routes: { complete: accepted, pause: inspect } }
  accepted: { agent: reviewer, next: complete }
  inspect: { agent: reviewer, next: complete }
`

const child = `version: 1
name: child
entry: scan
limits: { max_steps: 3 }
nodes:
  scan: { agent: developer, next: decide }
  decide: { agent: reviewer, routes: { approved: complete, blocked: pause } }
`

const slow = `version: 1
name: slow
entry: developer
limits: { max_steps: 2, node_timeout_seconds: 1 }
nodes:
  developer: { agent: developer, next: complete }
`

const single = `version: 1
name: single
entry: a
limits: { max_steps: 2 }
nodes:
  a: { agent: developer, next: complete }
`

function parsed(yaml: string, workflowID: string) {
  return parseWorkflowSource(yaml, { workflowID }).workflow!
}

export function describeHarnessContract(name: string, factory: ContractFactory): void {
  describe(`harness contract: ${name}`, () => {
    const fixtures: ContractFixture[] = []
    const create: ContractFactory = (options) => {
      const fixture = factory(options)
      fixtures.push(fixture)
      return fixture
    }
    afterEach(async () => {
      await Promise.all(fixtures.splice(0).map((fixture) => fixture.stop()))
    })

    it("discovers selectable agents and creates a session without prompting", async () => {
      const { harness } = create()
      const agents = await harness.listAgents()
      expect(agents.length).toBeGreaterThan(0)
      const selectable = agents.filter((agent) => agent.selectable)
      expect(selectable.length).toBeGreaterThan(0)
      expect(agents.filter((agent) => !agent.selectable).every((agent) => agent.reason !== undefined)).toBe(true)
      expect(await harness.resolveAgent("missing-agent-does-not-exist")).toBeUndefined()
      if (harness.capabilities.sessions.runScope) {
        expect(harness.createRunScope).toBeDefined()
        const scope = await harness.createRunScope!({ title: "scope", metadata: {} })
        expect(scope.ref.length).toBeGreaterThan(0)
      }
      const session = await harness.createSession({
        agentRef: selectable[0]!.id,
        title: "node",
        metadata: { nodeID: "probe" },
      })
      expect(session.ref.length).toBeGreaterThan(0)
    })

    it("submits a prompt and proves admission", async () => {
      const { harness } = create({ scenario: () => ({ delayMs: 60_000 }) })
      const agent = (await harness.listAgents()).find((candidate) => candidate.selectable)!
      const session = await harness.createSession({ agentRef: agent.id, title: "node", metadata: {} })
      await harness.submit({ session: session.ref, submission: "msg_1", text: "do it", metadata: {} })
      if (harness.submissionState) {
        expect(await harness.submissionState(session.ref, "msg_1")).toBe("admitted")
      }
      expect(await harness.cancel(session.ref)).toBe(true)
    })

    it("runs a workflow to completion with structured results", async () => {
      const { store, runner } = create({ scenario: reports })
      const run = await store.createRun(makeRunRecord())
      await runner.start("prj_1", run.runID)
      const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
      expect(final.steps.map((step) => step.nodeID)).toEqual(["developer", "reviewer"])
      expect(final.steps[0]?.outcome).toBe("done")
      expect(final.steps[1]?.outcome).toBe("approved")
    })

    it("rejects an undeclared outcome and never persists it", async () => {
      const { invocations, intake, store } = create()
      invocations.register({
        runID: "run_1", projectID: "prj_1", stepID: "step_1", sessionID: "contract_session",
        nodeID: "reviewer", allowedOutcomes: ["approved"], attempt: 1, reported: 0,
      })
      await expect(intake.submit({
        session: "contract_session", messageRef: "msg_1", toolCallRef: "call_1",
        result: { outcome: "done", summary: "wrong", feedback: "", evidence: [] },
      })).rejects.toThrow(/not declared/)
      expect(await store.getReport("prj_1", "run_1", "step_1")).toBeUndefined()
    })

    it("dedupes an identical report and rejects a conflicting one", async () => {
      const { invocations, intake, store } = create()
      invocations.register({
        runID: "run_1", projectID: "prj_1", stepID: "step_1", sessionID: "contract_session",
        nodeID: "reviewer", allowedOutcomes: ["approved"], attempt: 1, reported: 0,
      })
      const base = {
        session: "contract_session", messageRef: "msg_1", toolCallRef: "call_1",
        result: { outcome: "approved", summary: "ok", feedback: "", evidence: [] },
      }
      await intake.submit(base)
      expect(await intake.submit(base)).toMatchObject({ toolCallID: "call_1" })
      await expect(intake.submit({ ...base, result: { ...base.result, summary: "changed" } }))
        .rejects.toThrow(/different result/)
      expect((await store.getReport("prj_1", "run_1", "step_1"))?.result.summary).toBe("ok")
    })

    it("routes conditional outcomes and cycles through the graph", async () => {
      const { store, runner } = create({
        scenario: (input, count) => ({
          report: input.agent === "developer"
            ? developerReport
            : { ...reviewerReport, outcome: count === 1 ? "changes_requested" : "approved" },
        }),
      })
      const run = await store.createRun(makeRunRecord())
      await runner.start("prj_1", run.runID)
      const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
      expect(final.steps.map((step) => step.nodeID)).toEqual(["developer", "reviewer", "developer", "reviewer"])
      expect(final.steps.map((step) => step.outcome)).toEqual(["done", "changes_requested", "done", "approved"])
    })

    it("runs parallel branches and joins their results", async () => {
      const { store, runner } = create({ scenario: reports })
      const run = await store.createRun(makeRunRecord({
        workflowID: "parallel",
        workflowSnapshot: parsed(parallel, "parallel"),
        maxSteps: 12,
        nextNode: "dispatch",
      }))
      await runner.start("prj_1", run.runID)
      const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
      expect(final.steps.map((step) => step.nodeID).sort()).toEqual(["left", "merge", "right"])
    })

    it("runs a nested workflow call with its own steps", async () => {
      const { store, runner } = create({ scenario: reports })
      const run = await store.createRun(makeRunRecord({
        workflowID: "parent",
        workflowSnapshot: parsed(parent, "parent"),
        workflowDependencies: { child: { definition: parsed(child, "child"), hash: "c".repeat(64) } },
        maxSteps: 8,
        nextNode: "prep",
      }))
      await runner.start("prj_1", run.runID)
      const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
      expect(final.steps.map((step) => step.nodeID)).toEqual(["prep", "scan", "decide", "accepted"])
      expect(final.steps.find((step) => step.nodeID === "scan")?.workflowID).toBe("child")
      expect(final.steps.find((step) => step.nodeID === "scan")?.callPath).toEqual(["check"])
    })

    it("fails a missing result when the adapter has no corrections", async () => {
      const { store, runner, harness } = create({
        scenario: () => ({ outcome: "succeeded" }),
        variant: { corrections: false },
      })
      const run = await store.createRun(makeRunRecord())
      await runner.start("prj_1", run.runID)
      const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status !== "running")
      expect(final.status).toBe("failed")
      expect(final.failure?.code).toBe("missing_structured_result")
      expect((harness as { prompts?: unknown[] }).prompts).toHaveLength(1)
    })

    it("asks for a correction on the same session when results are supported", async () => {
      const { store, runner, harness } = create({
        scenario: (_input, count) => count === 1 ? { outcome: "succeeded" } : reports({ agent: "developer" }),
      })
      const run = await store.createRun(makeRunRecord({
        workflowSnapshot: parsed(`version: 1
name: single
entry: developer
limits: { max_steps: 2, max_result_retries: 1 }
nodes:
  developer: { agent: developer, next: complete }
`, "single"),
        workflowID: "single",
        maxSteps: 2,
        nextNode: "developer",
      }))
      await runner.start("prj_1", run.runID)
      const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
      expect(final.steps).toHaveLength(1)
      expect((harness as { prompts?: unknown[] }).prompts).toHaveLength(2)
    })

    it("blocks while a permission is pending and never auto-approves", async () => {
      const { store, runner } = create({ scenario: () => ({ pendingPermission: true }) })
      const run = await store.createRun(makeRunRecord())
      await runner.start("prj_1", run.runID)
      const blocked = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "blocked")
      expect(blocked.blocker?.type).toBe("permission")
      expect(blocked.pendingPermissions.length).toBeGreaterThan(0)
    })

    it("blocks unknown permission state and refuses resume", async () => {
      const { store, runner } = create({ variant: { permissions: "unknown" } })
      const run = await store.createRun(makeRunRecord())
      await runner.start("prj_1", run.runID)
      const blocked = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "blocked")
      expect(blocked.blocker?.type).toBe("ambiguous_node")
      await expect(runner.resume("prj_1", run.runID, blocked.revision, "resume-1", false))
        .rejects.toBeInstanceOf(NotResumableError)
    })

    it("cancels an active node and interrupts its native session", async () => {
      const { store, runner, harness } = create({ scenario: () => ({ delayMs: 60_000 }) })
      const run = await store.createRun(makeRunRecord())
      await runner.start("prj_1", run.runID)
      await waitFor(() => (harness as { prompts?: unknown[] }).prompts?.length === 1)
      const current = (await store.getRun("prj_1", run.runID))!
      const cancelled = await runner.cancel("prj_1", run.runID, current.revision, "cancel-1")
      expect(cancelled.status).toBe("cancelled")
      const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "cancelled")
      const step = await store.getStep("prj_1", run.runID, final.steps[0]!.stepID)
      expect(step?.status).toBe("interrupted")
    })

    it("fails an active node at its timeout without re-prompting", async () => {
      const { store, runner, harness } = create({
        scenario: () => ({ delayMs: 60_000 }),
        now: () => Date.now(),
      })
      const run = await store.createRun(makeRunRecord({
        workflowID: "slow",
        workflowSnapshot: parsed(slow, "slow"),
        maxSteps: 2,
        nextNode: "developer",
        deadlineAt: Date.now() + 60_000,
      }))
      await runner.start("prj_1", run.runID)
      const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "failed", 6_000)
      expect(final.failure?.code).toBe("node_timeout")
      expect((harness as { prompts?: unknown[] }).prompts).toHaveLength(1)
    })

    it("blocks a node that finished after restart without a report", async () => {
      const { store, harness, runner, invocations } = create({
        scenario: () => ({ outcome: "succeeded" }),
      })
      const run = await store.createRun(makeRunRecord({
        workflowSnapshot: parsed(single, "single"),
        workflowID: "single",
        maxSteps: 2,
        nextNode: "a",
      }))
      const scope = harness.capabilities.sessions.runScope
        ? await harness.createRunScope!({ title: "run", metadata: {} })
        : undefined
      const session = await harness.createSession({
        ...(scope === undefined ? {} : { parent: scope.ref }),
        agentRef: "developer",
        title: "a",
        metadata: {},
      })
      const stepID = "step_000001_a001"
      invocations.register({
        runID: run.runID, projectID: "prj_1", stepID, sessionID: session.ref,
        nodeID: "a", allowedOutcomes: [], attempt: 1, reported: 0,
      })
      await harness.submit({ session: session.ref, submission: "msg_1", text: "do it" })
      await waitFor(async () => (await harness.inspect(session.ref)).state === "succeeded")
      await store.mutateRun("prj_1", run.runID, null, (draft) => {
        draft.runSessionID = scope?.ref ?? null
        draft.currentNode = "a"
        draft.nextNode = "a"
        draft.stepCount = 1
        draft.activeStep = {
          stepID, stepIndex: 1, attempt: 1, nodeID: "a", agentID: "developer",
          sessionID: session.ref, promptMessageID: "msg_1", phase: "prompted",
          startedAt: 1_000, promptedAt: 1_000, resultAttempts: 0,
        }
      })
      await runner.recoverProject("prj_1")
      const blocked = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "blocked")
      expect(blocked.blocker?.type).toBe("missing_report")
      expect((harness as { prompts?: unknown[] }).prompts).toHaveLength(1)
      expect(activeSteps(blocked)).toHaveLength(1)
    })

    it("blocks an idle node without a terminal outcome after restart", async () => {
      const { store, harness, runner } = create({ scenario: () => ({ unknownTerminal: true }) })
      const run = await store.createRun(makeRunRecord({
        workflowSnapshot: parsed(single, "single"),
        workflowID: "single",
        maxSteps: 2,
        nextNode: "a",
      }))
      const session = await harness.createSession({ agentRef: "developer", title: "a", metadata: {} })
      await harness.submit({ session: session.ref, submission: "msg_1", text: "do it" })
      await waitFor(async () => (await harness.inspect(session.ref)).state === "unknown")
      const stepID = "step_000001_a001"
      await store.mutateRun("prj_1", run.runID, null, (draft) => {
        draft.currentNode = "a"
        draft.nextNode = "a"
        draft.stepCount = 1
        draft.activeStep = {
          stepID, stepIndex: 1, attempt: 1, nodeID: "a", agentID: "developer",
          sessionID: session.ref, promptMessageID: "msg_1", phase: "prompted",
          startedAt: 1_000, promptedAt: 1_000, resultAttempts: 0,
        }
      })
      await runner.recoverProject("prj_1")
      const blocked = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "blocked")
      expect(blocked.blocker?.type).toBe("ambiguous_node")
      expect((harness as { prompts?: unknown[] }).prompts).toHaveLength(1)
    })

    it("blocks ambiguous admission after restart instead of re-prompting", async () => {
      const { store, harness, runner } = create({ variant: { admission: "ambiguous" } })
      const run = await store.createRun(makeRunRecord({
        workflowSnapshot: parsed(single, "single"),
        workflowID: "single",
        maxSteps: 2,
        nextNode: "a",
      }))
      const session = await harness.createSession({ agentRef: "developer", title: "a", metadata: {} })
      const stepID = "step_000001_a001"
      await store.mutateRun("prj_1", run.runID, null, (draft) => {
        draft.currentNode = "a"
        draft.nextNode = "a"
        draft.stepCount = 1
        draft.activeStep = {
          stepID, stepIndex: 1, attempt: 1, nodeID: "a", agentID: "developer",
          sessionID: session.ref, promptMessageID: "msg_unproven", phase: "session_created",
          startedAt: 1_000, resultAttempts: 0,
        }
      })
      await runner.recoverProject("prj_1")
      const blocked = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "blocked")
      expect(blocked.blocker?.type).toBe("ambiguous_node")
      expect((harness as { prompts?: unknown[] }).prompts).toHaveLength(0)
    })

    it("fails a native failure without retrying the node", async () => {
      const { store, runner, harness } = create({ scenario: () => ({ outcome: "failed" }) })
      const run = await store.createRun(makeRunRecord({
        workflowSnapshot: parsed(single, "single"),
        workflowID: "single",
        maxSteps: 2,
        nextNode: "a",
      }))
      await runner.start("prj_1", run.runID)
      const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "failed")
      expect(final.failure?.code).toBe("native_failure")
      expect((harness as { prompts?: unknown[] }).prompts).toHaveLength(1)
    })

    it("abandons an unadmitted prepared step and admits a fresh attempt", async () => {
      const { store, harness, runner } = create({ scenario: reports })
      const run = await store.createRun(makeRunRecord({
        workflowSnapshot: parsed(single, "single"),
        workflowID: "single",
        maxSteps: 2,
        nextNode: "a",
      }))
      const session = await harness.createSession({ agentRef: "developer", title: "a", metadata: {} })
      const stepID = "step_000001_a001"
      await store.mutateRun("prj_1", run.runID, null, (draft) => {
        draft.currentNode = "a"
        draft.nextNode = "a"
        draft.stepCount = 1
        draft.activeStep = {
          stepID, stepIndex: 1, attempt: 1, nodeID: "a", agentID: "developer",
          sessionID: session.ref, promptMessageID: "msg_unproven", phase: "session_created",
          startedAt: 1_000, resultAttempts: 0,
        }
      })
      await runner.recoverProject("prj_1")
      const final = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
      expect((await store.getStep("prj_1", run.runID, stepID))?.status).toBe("abandoned")
      const prompts = (harness as { prompts?: { sessionID: string }[] }).prompts ?? []
      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.sessionID).not.toBe(session.ref)
      expect(final.steps[0]?.sessionID).toBe(prompts[0]?.sessionID)
    })

    it("blocks instead of re-admitting when a prompt may already be in flight", async () => {
      const { store, harness, runner } = create({ scenario: reports })
      const run = await store.createRun(makeRunRecord({
        workflowSnapshot: parsed(single, "single"),
        workflowID: "single",
        maxSteps: 2,
        nextNode: "a",
      }))
      const session = await harness.createSession({ agentRef: "developer", title: "a", metadata: {} })
      await store.mutateRun("prj_1", run.runID, null, (draft) => {
        draft.currentNode = "a"
        draft.nextNode = "a"
        draft.stepCount = 1
        draft.activeStep = {
          stepID: "step_000001_a001", stepIndex: 1, attempt: 1, nodeID: "a", agentID: "developer",
          sessionID: session.ref, promptMessageID: "msg_unproven", phase: "prompting",
          startedAt: 1_000, resultAttempts: 0,
        }
      })
      await runner.recoverProject("prj_1")
      const blocked = await waitForRun(store, "prj_1", run.runID, (item) => item.status === "blocked")
      expect(blocked.blocker?.type).toBe("ambiguous_node")
      expect((harness as { prompts?: unknown[] }).prompts).toHaveLength(0)
    })

    it("does not duplicate execution when start is called twice", async () => {
      const { store, runner, harness } = create({ scenario: () => ({ ...reports({ agent: "developer" }), delayMs: 20 }) })
      const run = await store.createRun(makeRunRecord({
        workflowSnapshot: parsed(`version: 1
name: single
entry: developer
limits: { max_steps: 2 }
nodes:
  developer: { agent: developer, next: complete }
`, "single"),
        workflowID: "single",
        maxSteps: 2,
        nextNode: "developer",
      }))
      await Promise.all([runner.start("prj_1", run.runID), runner.start("prj_1", run.runID)])
      await waitForRun(store, "prj_1", run.runID, (item) => item.status === "completed")
      expect((harness as { prompts?: unknown[] }).prompts).toHaveLength(1)
    })

    it("isolates concurrent runs in the same store", async () => {
      const { store, runner } = create({ scenario: (input) => ({ ...reports(input), delayMs: 20 }) })
      const first = await store.createRun(makeRunRecord({ runID: "run_0000000001_aaaaaa" }))
      const second = await store.createRun(makeRunRecord({ runID: "run_0000000002_bbbbbb", createdAt: 2_000 }))
      await Promise.all([runner.start("prj_1", first.runID), runner.start("prj_1", second.runID)])
      const [left, right] = await Promise.all([
        waitForRun(store, "prj_1", first.runID, (item) => item.status === "completed"),
        waitForRun(store, "prj_1", second.runID, (item) => item.status === "completed"),
      ])
      const leftSessions = new Set(left.steps.map((step) => step.sessionID))
      expect(right.steps.every((step) => !leftSessions.has(step.sessionID))).toBe(true)
      expect(right.steps[0]?.outcome).toBe("done")
    })

    it("owns its sidecar, adopts legacy runs only when configured, and refuses foreign runs", async () => {
      const refusing = create({ variant: { adoptLegacyRuns: false } })
      const legacy = await refusing.store.createRun(makeRunRecord({ runID: "run_0000000001_legacy" }))
      await expect(refusing.runner.start("prj_1", legacy.runID)).rejects.toBeInstanceOf(NotResumableError)

      const foreign = await refusing.store.createRun(makeRunRecord({ runID: "run_0000000002_foreign" }))
      await refusing.store.putRunHarness("prj_1", foreign.runID, { id: "another-harness" })
      await expect(refusing.runner.start("prj_1", foreign.runID)).rejects.toBeInstanceOf(NotResumableError)

      const owned = await refusing.store.createRun(makeRunRecord({ runID: "run_0000000003_owned" }))
      await refusing.store.putRunHarness("prj_1", owned.runID, { id: refusing.harness.capabilities.id })
      await refusing.runner.start("prj_1", owned.runID)
      const ownedFinal = await waitForRun(refusing.store, "prj_1", owned.runID, (item) => item.status === "completed")
      expect(ownedFinal.status).toBe("completed")

      const adopting = create({ variant: { adoptLegacyRuns: true } })
      const adopted = await adopting.store.createRun(makeRunRecord({ runID: "run_0000000004_legacy" }))
      await adopting.runner.start("prj_1", adopted.runID)
      const adoptedFinal = await waitForRun(adopting.store, "prj_1", adopted.runID, (item) => item.status === "completed")
      expect(adoptedFinal.status).toBe("completed")
    })

    it("backs declared security capabilities with an actual probe", async () => {
      const fixture = create()
      expect(await capabilityFindings(fixture.harness, fixture.capabilityProbe)).toEqual([])
    })

    it("documents the supported result mechanism honestly", async () => {
      const { harness } = create()
      expect(["native_tool", "structured_output", "mcp_tool", "none"]).toContain(harness.capabilities.results.mechanism)
      expect(harness.capabilities.id.length).toBeGreaterThan(0)
      expect(harness.capabilities.displayName.length).toBeGreaterThan(0)
    })
  })
}
