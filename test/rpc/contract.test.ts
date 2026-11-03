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
        "listRuns",
        "listWorkflows",
        "pauseRun",
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

  it("validates workflow input size and unknown fields", () => {
    expect(ValidateWorkflowInputSchema.safeParse({ yaml: "version: 1", extra: true }).success).toBe(false)
    expect(StartRunInputSchema.safeParse({ workflowID: "sample", objective: "x", requestID: "r1" }).success).toBe(true)
  })

  it("validates the capabilities and runUpdated payloads", () => {
    expect(
      CapabilitiesOutputSchema.safeParse({
        plugin: { name: "@alvarolorentedev/opencode-flowgraph", version: "0.4.0" },
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
