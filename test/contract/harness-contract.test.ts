import { describe, expect, it } from "vitest"
import { WorkflowStore } from "../../src/state/store.js"
import { RunLockManager } from "../../src/state/concurrency.js"
import { WorkflowRunner } from "../../src/execution/runner.js"
import { createInvocationRegistry, ReportIntake } from "../../src/execution/report-intake.js"
import { FakeHarness } from "../fixtures/fake-harness.js"
import { MemoryStorage } from "../fixtures/memory.js"
import {
  capabilityFindings,
  describeHarnessContract,
  type ContractFactory,
  type ContractScenario,
} from "./harness-suite.js"

const defaultScenario: ContractScenario = (input) => ({
  report: input.agent === "developer"
    ? { outcome: "done", summary: "implemented", feedback: "", evidence: [] }
    : { outcome: "approved", summary: "approved", feedback: "", evidence: [] },
})

const fakeFactory: ContractFactory = (options = {}) => {
  const store = new WorkflowStore(new MemoryStorage())
  const invocations = createInvocationRegistry()
  const intake = new ReportIntake(store, invocations)
  const variant = options.variant ?? {}
  const scenario = options.scenario ?? defaultScenario
  const harness = new FakeHarness(
    intake,
    ((input: { nodeID: string; agent: string; text: string }, count: number) => scenario(input, count)) as never,
    {
      id: variant.id,
      runScope: variant.runScope,
      adoptLegacyRuns: variant.adoptLegacyRuns,
      resultsMechanism: variant.resultsMechanism,
      corrections: variant.corrections,
      permissions: variant.permissions,
      permissionSurvivesRestart: variant.permissionSurvivesRestart,
      admission: variant.admission,
      security: variant.security,
    },
  )
  const runner = new WorkflowRunner({
    store,
    harness,
    locks: new RunLockManager(),
    invocations,
    emit: async () => undefined,
    now: options.now ?? (() => 2_000),
    options: { pollIntervalMs: 5, recoveryGraceMs: 30 },
  })
  return {
    harness,
    store,
    invocations,
    intake,
    runner,
    // FakeHarness declares no enforcement of these claims, so a claim is a finding.
    capabilityProbe: async () => {
      const findings: string[] = []
      if (harness.capabilities.security.backgroundWork === "blocked") {
        findings.push("background work is not rejected by the fake harness")
      }
      if (harness.capabilities.security.protectedPaths !== "none") {
        findings.push(`protected paths are not intercepted by the fake harness`)
      }
      return findings
    },
    stop: () => runner.shutdown(),
  }
}

describeHarnessContract("fake harness (full)", fakeFactory)
describeHarnessContract("fake harness (minimal)", (options = {}) => fakeFactory({
  ...options,
  variant: {
    id: "fake-minimal",
    runScope: false,
    resultsMechanism: "structured_output",
    permissionSurvivesRestart: true,
    ...options.variant,
  },
}))

describe("harness capability honesty", () => {
  it("fails a deliberate lie about background work or protected paths", async () => {
    const honest = fakeFactory()
    expect(await capabilityFindings(honest.harness, honest.capabilityProbe)).toEqual([])
    await honest.stop()

    const liar = fakeFactory({
      variant: { security: { backgroundWork: "blocked", protectedPaths: "tool_hook" } },
    })
    expect(await capabilityFindings(liar.harness, liar.capabilityProbe)).toEqual([
      "background work is not rejected by the fake harness",
      "protected paths are not intercepted by the fake harness",
    ])
    await liar.stop()
  })

  it("requires a probe for a declared security claim", async () => {
    const liar = fakeFactory({ variant: { security: { backgroundWork: "blocked" } } })
    expect(await capabilityFindings(liar.harness)).toEqual(["declared security enforcement has no capability probe"])
    await liar.stop()
  })
})
