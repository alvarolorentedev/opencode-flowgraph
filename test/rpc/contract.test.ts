import { describe, expect, it } from "vitest"
import type { z } from "zod"
import { FlowgraphRpc } from "../../src/rpc.js"
import {
  CapabilitiesOutputSchema,
  RunUpdatedEventSchema,
  StartRunInputSchema,
  ValidateWorkflowInputSchema,
} from "../../src/contract.js"

describe("flowgraph RPC contract", () => {
  it("exposes every required method and event", () => {
    expect(Object.keys(FlowgraphRpc.methods).sort()).toEqual(
      [
        "cancelRun",
        "capabilities",
        "deleteWorkflow",
        "getRun",
        "getRunGraph",
        "getRunStep",
        "getWorkflow",
        "harnessCapabilities",
        "listRuns",
        "listWorkflows",
        "pauseRun",
        "respondRun",
        "resumeRun",
        "saveWorkflow",
        "startRun",
        "validateWorkflow",
      ].sort(),
    )
    expect(Object.keys(FlowgraphRpc.events)).toEqual(["runUpdated"])
  })

  it("validates startRun input", () => {
    const schema = FlowgraphRpc.methods.startRun.input as unknown as z.ZodTypeAny
    expect(schema.safeParse({ workflowID: "sample", objective: "do it", requestID: "r1" }).success).toBe(true)
    expect(schema.safeParse({ workflowID: "../escape", objective: "do it", requestID: "r1" }).success).toBe(false)
    expect(
      (FlowgraphRpc.methods.getRunGraph.input as unknown as z.ZodTypeAny).safeParse({ runID: "run_1" }).success,
    ).toBe(true)
    expect(schema.safeParse({ workflowID: "sample", objective: "", requestID: "r1" }).success).toBe(false)
  })

  it("validates respondRun input", () => {
    const schema = FlowgraphRpc.methods.respondRun.input as unknown as z.ZodTypeAny
    expect(
      schema.safeParse({ runID: "run_1", requestID: "r1", expectedRevision: 0, outcome: "approved", feedback: "ok" }).success,
    ).toBe(true)
    expect(schema.safeParse({ runID: "run_1", requestID: "r1", expectedRevision: 0, outcome: "Approved" }).success).toBe(false)
    expect(
      schema.safeParse({ runID: "run_1", requestID: "r1", expectedRevision: 0, outcome: "approved", extra: true }).success,
    ).toBe(false)
  })

  it("validates workflow input size and unknown fields", () => {
    expect(ValidateWorkflowInputSchema.safeParse({ yaml: "version: 1", extra: true }).success).toBe(false)
    expect(StartRunInputSchema.safeParse({ workflowID: "sample", objective: "x", requestID: "r1" }).success).toBe(true)
  })

  it("validates the harnessCapabilities payload", () => {
    const schema = FlowgraphRpc.methods.harnessCapabilities.output as unknown as z.ZodTypeAny
    const capabilities = {
      id: "opencode",
      displayName: "OpenCode",
      version: "2.2.5",
      agents: { discovery: "native" },
      sessions: { runScope: true, adoptLegacyRuns: true },
      results: { mechanism: "native_tool", corrections: true },
      permissions: { survivesRestart: true, approval: "native" },
      security: { nativePermissions: true, protectedPaths: "tool_hook", backgroundWork: "blocked" },
      usage: { tokens: true, cost: true },
      audit: true,
    }
    expect(schema.safeParse(capabilities).success).toBe(true)
    expect(schema.safeParse({ ...capabilities, extra: true }).success).toBe(false)
    expect(schema.safeParse({ ...capabilities, results: { mechanism: "tool" } }).success).toBe(false)
    expect(schema.safeParse({ ...capabilities, security: { ...capabilities.security, backgroundWork: "maybe" } }).success)
      .toBe(false)
    expect((FlowgraphRpc.methods.harnessCapabilities.input as unknown as z.ZodTypeAny).safeParse(undefined).success)
      .toBe(true)
  })

  it("validates the capabilities and runUpdated payloads", () => {
    expect(
      CapabilitiesOutputSchema.safeParse({
        plugin: { name: "@alvarolorentedev/opencode-flowgraph", version: "0.7.0" },
        rpc: { id: "flowgraph", version: 1 },
        workflowSchemaVersion: 1,
        openCodeVersion: "2.0.32",
        features: {
          conditionalRoutes: true,
          cycles: true,
          pause: true,
          structuredResults: "tool",
          conservativeRecovery: true,
          runGraph: true,
          parallelBranches: false,
          nestedWorkflows: false,
          backgroundNativeWork: false,
        },
        limits: { maxWorkflowBytes: 1, maxNodes: 1, maxSteps: 1, maxObjectiveBytes: 1, maxRuns: 1 },
        storage: { durable: true, transactional: false, compareAndSwap: false, projectScopedKeys: true },
      }).success,
    ).toBe(true)

    expect(
      RunUpdatedEventSchema.safeParse({
        projectID: "prj_1",
        projectCanonical: "/tmp/project",
        directory: "/tmp/project",
        runID: "run_1",
        workflowID: "sample",
        status: "running",
        currentNode: "developer",
        revision: 2,
        timestamp: 1,
      }).success,
    ).toBe(true)
  })
})
