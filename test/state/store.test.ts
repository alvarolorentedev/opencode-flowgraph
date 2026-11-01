import { describe, expect, it } from "vitest"
import { WorkflowStore, RevisionConflictError, type JsonValue, type StoragePort } from "../../src/state/store.js"
import { parseWorkflowSource } from "../../src/workflow/loader.js"
import { RunRecordSchema, type RunRecord } from "../../src/state/types.js"
import { zeroUsage } from "../../src/execution/results.js"

class MemoryStorage implements StoragePort {
  readonly data = new Map<string, JsonValue>()
  async get(key: string) {
    return this.data.get(key)
  }
  async set(key: string, value: JsonValue) {
    this.data.set(key, JSON.parse(JSON.stringify(value)) as JsonValue)
  }
  async remove(key: string) {
    this.data.delete(key)
  }
  async scan(options: { prefix: string; after?: string; limit?: number }) {
    const entries = Array.from(this.data.entries())
      .filter(([key]) => key.startsWith(options.prefix) && (options.after === undefined || key > options.after))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, options.limit ?? 100)
      .map(([key, value]) => ({ key, value }))
    return { entries }
  }
}

const source = `version: 1
name: sample
entry: a
limits: { max_steps: 3 }
nodes:
  a: { agent: developer, next: complete }
`

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const workflow = parseWorkflowSource(source, { workflowID: "sample" }).workflow!
  const now = 1_000
  return RunRecordSchema.parse({
    schemaVersion: 1,
    runID: "run_0000000001_abcdef",
    workflowID: "sample",
    requestID: "req-1",
    requestHash: "a".repeat(64),
    project: { id: "prj_1", canonical: "/tmp/project", directory: "/tmp/project" },
    workflowHash: "b".repeat(64),
    workflowSnapshot: workflow,
    sourceYamlKey: "v1/run-sources/prj_1/run_0000000001_abcdef",
    objective: "do the thing",
    status: "running",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    deadlineAt: now + 60_000,
    runSessionID: null,
    currentNode: null,
    nextNode: "a",
    stepCount: 0,
    maxSteps: 3,
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
    owner: { instanceID: "inst_1", hostname: "host", pid: 1 },
    recovery: { attempts: 0 },
    recentControlRequests: {},
    ...overrides,
  })
}

describe("WorkflowStore", () => {
  it("creates, mutates, and lists runs with revisions", async () => {
    const storage = new MemoryStorage()
    const store = new WorkflowStore(storage, () => 2_000)
    const run = await store.createRun(runRecord())
    expect(run.revision).toBe(1)

    const updated = await store.mutateRun("prj_1", run.runID, 1, (draft) => {
      draft.status = "paused"
    })
    expect(updated.revision).toBe(2)
    expect(updated.updatedAt).toBe(2_000)
    await expect(store.mutateRun("prj_1", run.runID, 1, () => undefined)).rejects.toBeInstanceOf(RevisionConflictError)

    await store.createRun(runRecord({ runID: "run_0000000002_abcdef", createdAt: 3_000 }))
    const runs = await store.listRuns("prj_1")
    expect(runs.map((item) => item.runID)).toEqual(["run_0000000002_abcdef", run.runID])
  })

  it("keeps projects isolated by storage keys", async () => {
    const storage = new MemoryStorage()
    const store = new WorkflowStore(storage)
    await store.createRun(runRecord())
    expect(await store.listRuns("prj_2")).toEqual([])
    expect(await store.getRun("prj_2", "run_0000000001_abcdef")).toBeUndefined()
  })

  it("fails closed on corrupt records", async () => {
    const storage = new MemoryStorage()
    const store = new WorkflowStore(storage)
    await storage.set("v1/runs/prj_1/bad", { nope: true })
    await expect(store.listRuns("prj_1")).rejects.toMatchObject({ name: "StateCorruptionError" })
  })
})
