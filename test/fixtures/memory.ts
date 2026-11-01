import { parseWorkflowSource } from "../../src/workflow/loader.js"
import { RunRecordSchema, type RunRecord } from "../../src/state/types.js"
import { zeroUsage } from "../../src/execution/results.js"
import type { JsonValue, StoragePort, WorkflowStore } from "../../src/state/store.js"

export class MemoryStorage implements StoragePort {
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

export const source = `version: 1
name: sample
entry: developer
limits:
  max_steps: 8
  timeout_seconds: 60
  max_result_retries: 1
  max_recovery_attempts: 3
  max_repeat_transitions: 5
nodes:
  developer:
    agent: developer
    next: reviewer
  reviewer:
    agent: reviewer
    routes:
      approved: complete
      changes_requested: developer
      blocked: pause
`

export function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
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
    objective: "implement the feature",
    status: "running",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    deadlineAt: now + 60_000,
    runSessionID: "sess_run_1",
    currentNode: null,
    nextNode: "developer",
    stepCount: 0,
    maxSteps: 8,
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

export async function waitForRun(
  store: WorkflowStore,
  projectID: string,
  runID: string,
  predicate: (run: RunRecord) => boolean,
  timeoutMs = 3_000,
): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs
  let last: RunRecord | undefined
  while (Date.now() < deadline) {
    last = await store.getRun(projectID, runID)
    if (last && predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for run; last status=${last?.status}`)
}
