import { KeyedMutex } from "../util/mutex.js"
import { StorageKeys } from "./keys.js"
import {
  RunRecordSchema,
  StepRecordSchema,
  ReportRecordSchema,
  type RunRecord,
  type StepRecord,
  type ReportRecord,
} from "./types.js"

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type StorageScanResult = {
  entries: ReadonlyArray<{ key: string; value: unknown }>
  next?: string
}

export interface StoragePort {
  get(key: string): Promise<unknown>
  set(key: string, value: JsonValue): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<StorageScanResult>
}

export class StateCorruptionError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message)
    this.name = "StateCorruptionError"
  }
}

function jsonClone<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export class WorkflowStore {
  private readonly mutex = new KeyedMutex()

  constructor(
    private readonly storage: StoragePort,
    private readonly now: () => number = Date.now,
  ) {}

  private async readSchema<T>(
    key: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  ): Promise<T | undefined> {
    const value = await this.storage.get(key)
    if (value === undefined) return undefined
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new StateCorruptionError(key, `stored record at ${key} is invalid`)
    return parsed.data
  }

  async getRun(projectID: string, runID: string): Promise<RunRecord | undefined> {
    return this.readSchema(StorageKeys.run(projectID, runID), RunRecordSchema)
  }

  async createRun(run: RunRecord): Promise<RunRecord> {
    return this.mutex.run(`run:${run.runID}`, async () => {
      const key = StorageKeys.run(run.project.id, run.runID)
      const existing = await this.readSchema(key, RunRecordSchema)
      if (existing) return existing
      const parsed = RunRecordSchema.parse(run)
      await this.storage.set(key, jsonClone(parsed))
      return parsed
    })
  }

  async mutateRun(
    projectID: string,
    runID: string,
    expectedRevision: number | null,
    mutate: (run: RunRecord) => RunRecord | void,
  ): Promise<RunRecord> {
    return this.mutex.run(`run:${runID}`, async () => {
      const key = StorageKeys.run(projectID, runID)
      const current = await this.readSchema(key, RunRecordSchema)
      if (!current) throw new StateCorruptionError(key, `run ${runID} does not exist`)
      if (expectedRevision !== null && current.revision !== expectedRevision) {
        throw new RevisionConflictError(current.revision)
      }
      const draft = structuredClone(current)
      const result = mutate(draft) ?? draft
      result.revision = current.revision + 1
      result.updatedAt = this.now()
      const parsed = RunRecordSchema.parse(result)
      await this.storage.set(key, jsonClone(parsed))
      return parsed
    })
  }

  async putRun(run: RunRecord): Promise<RunRecord> {
    const parsed = RunRecordSchema.parse(run)
    await this.storage.set(StorageKeys.run(parsed.project.id, parsed.runID), jsonClone(parsed))
    return parsed
  }

  async listRuns(projectID: string, limit = 500): Promise<RunRecord[]> {
    const entries = await this.storage.scan({ prefix: StorageKeys.runsPrefix(projectID), limit: Math.min(limit, 500) })
    const runs: RunRecord[] = []
    for (const entry of entries.entries) {
      const parsed = RunRecordSchema.safeParse(entry.value)
      if (!parsed.success) throw new StateCorruptionError(entry.key, `stored run at ${entry.key} is invalid`)
      runs.push(parsed.data)
    }
    return runs.sort((a, b) => b.createdAt - a.createdAt || b.runID.localeCompare(a.runID))
  }

  async getStep(projectID: string, runID: string, stepID: string): Promise<StepRecord | undefined> {
    return this.readSchema(StorageKeys.step(projectID, runID, stepID), StepRecordSchema)
  }

  async putStep(projectID: string, step: StepRecord): Promise<StepRecord> {
    const parsed = StepRecordSchema.parse(step)
    await this.storage.set(StorageKeys.step(projectID, parsed.runID, parsed.stepID), jsonClone(parsed))
    return parsed
  }

  async listSteps(projectID: string, runID: string): Promise<StepRecord[]> {
    const entries = await this.storage.scan({
      prefix: StorageKeys.stepsPrefix(projectID, runID),
      limit: 500,
    })
    const steps: StepRecord[] = []
    for (const entry of entries.entries) {
      const parsed = StepRecordSchema.safeParse(entry.value)
      if (!parsed.success) throw new StateCorruptionError(entry.key, `stored step at ${entry.key} is invalid`)
      steps.push(parsed.data)
    }
    return steps.sort((a, b) => a.seq - b.seq)
  }

  async getReport(projectID: string, runID: string, stepID: string): Promise<ReportRecord | undefined> {
    return this.readSchema(StorageKeys.report(projectID, runID, stepID), ReportRecordSchema)
  }

  async putReport(projectID: string, report: ReportRecord): Promise<ReportRecord> {
    const parsed = ReportRecordSchema.parse(report)
    await this.storage.set(StorageKeys.report(projectID, parsed.runID, parsed.stepID), jsonClone(parsed))
    return parsed
  }

  async putSource(projectID: string, runID: string, source: string): Promise<void> {
    await this.storage.set(StorageKeys.source(projectID, runID), source)
  }

  async getSource(projectID: string, runID: string): Promise<string | undefined> {
    const value = await this.storage.get(StorageKeys.source(projectID, runID))
    return typeof value === "string" ? value : undefined
  }

  async putBackup(projectID: string, workflowID: string, hash: string, source: string): Promise<void> {
    await this.storage.set(StorageKeys.backup(projectID, workflowID, hash), source)
  }

  async getIdempotency(projectID: string, requestHash: string): Promise<string | undefined> {
    const value = await this.storage.get(StorageKeys.idem(projectID, requestHash))
    return typeof value === "string" ? value : undefined
  }

  async setIdempotency(projectID: string, requestHash: string, runID: string): Promise<void> {
    await this.storage.set(StorageKeys.idem(projectID, requestHash), runID)
  }

  async removeIdempotency(projectID: string, requestHash: string): Promise<void> {
    await this.storage.remove(StorageKeys.idem(projectID, requestHash))
  }

  async getLease(projectID: string): Promise<unknown> {
    return this.storage.get(StorageKeys.lease(projectID))
  }

  async setLease(projectID: string, value: JsonValue): Promise<void> {
    await this.storage.set(StorageKeys.lease(projectID), value)
  }

  async removeLease(projectID: string): Promise<void> {
    await this.storage.remove(StorageKeys.lease(projectID))
  }
}

export class RevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`stale revision; current revision is ${currentRevision}`)
    this.name = "RevisionConflictError"
  }
}
