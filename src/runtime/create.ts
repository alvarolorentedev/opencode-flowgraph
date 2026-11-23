import { WorkflowService } from "../service.js"
import { WorkflowRepository } from "../workflow/loader.js"
import { WorkflowStore, type StoragePort } from "../state/store.js"
import { RunLockManager } from "../state/concurrency.js"
import { createInvocationRegistry, ReportIntake, type InvocationRegistry } from "../execution/report-intake.js"
import { WorkflowRunner, type RunUpdatedPayload, type RunnerOptions } from "../execution/runner.js"
import { HarnessCapabilitiesSchema, type HarnessAdapter } from "../execution/harness.js"
import type { ProjectIdentity } from "../state/types.js"
import { newInstanceID } from "../util/ids.js"

export type RuntimeOptions = Partial<RunnerOptions> & {
  /** Run project recovery shortly after `start()`. Defaults to true. */
  recoverOnStart?: boolean
  /** Delay before automatic recovery so a host can finish registering. */
  recoveryDelayMs?: number
}

export type HarnessAdapterContext = {
  project: ProjectIdentity
  workflowRoot: string
  store: WorkflowStore
  intake: ReportIntake
  invocations: InvocationRegistry
}

export type HarnessAdapterProvider = (context: HarnessAdapterContext) => HarnessAdapter | Promise<HarnessAdapter>

export type CreateFlowgraphRuntimeInput = {
  project: ProjectIdentity
  /** An adapter instance, or a provider that receives the composed portable components. */
  harness: HarnessAdapter | HarnessAdapterProvider
  storage: StoragePort
  /** Explicit workflow directory, relative to the project or absolute inside it. */
  workflowRoot?: string
  /** Directory whose project-scoped workflow folder is resolved. Defaults to project.directory. */
  workflowDirectory?: string
  options?: RuntimeOptions
  emit?: (payload: RunUpdatedPayload) => Promise<void>
  instanceID?: string
  /** Injectable clock for deterministic hosts and tests. */
  now?: () => number
}

export type FlowgraphRuntime = {
  project: ProjectIdentity
  service: WorkflowService
  runner: WorkflowRunner
  intake: ReportIntake
  invocations: InvocationRegistry
  store: WorkflowStore
  repo: WorkflowRepository
  harness: HarnessAdapter
  workflowRoot: string
  start(): Promise<void>
  recover(): Promise<void>
  shutdown(): Promise<void>
}

const DEFAULT_RECOVERY_DELAY_MS = 250

export async function createFlowgraphRuntime(input: CreateFlowgraphRuntimeInput): Promise<FlowgraphRuntime> {
  const instanceID = input.instanceID ?? newInstanceID()
  const emit = input.emit ?? (async () => undefined)
  const repo = new WorkflowRepository(
    input.workflowDirectory ?? input.project.directory,
    input.workflowRoot === undefined ? {} : { root: input.workflowRoot },
  )
  const store = new WorkflowStore(input.storage, input.now)
  const invocations = createInvocationRegistry()
  const intake = new ReportIntake(store, invocations)
  const harness = typeof input.harness === "function"
    ? await input.harness({ project: input.project, workflowRoot: repo.root, store, intake, invocations })
    : input.harness
  HarnessCapabilitiesSchema.parse(harness.capabilities)

  const runner = new WorkflowRunner({
    store,
    harness,
    locks: new RunLockManager(),
    invocations,
    instanceID,
    emit,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.options === undefined ? {} : { options: input.options }),
  })

  const service = new WorkflowService({
    project: input.project,
    store,
    runner,
    harness,
    repo,
    instanceID,
    emit,
    ...(input.now === undefined ? {} : { now: input.now }),
  })

  let recoveryTimer: ReturnType<typeof setTimeout> | undefined
  let started = false
  let closed = false

  const runtime: FlowgraphRuntime = {
    project: input.project,
    service,
    runner,
    intake,
    invocations,
    store,
    repo,
    harness,
    workflowRoot: repo.root,
    async start() {
      if (started || closed) return
      started = true
      if (input.options?.recoverOnStart === false) return
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined
        if (closed) return
        void service.recover().catch((error: unknown) => {
          console.error("flowgraph: recovery failed", error instanceof Error ? error.message : "unknown error")
        })
      }, input.options?.recoveryDelayMs ?? DEFAULT_RECOVERY_DELAY_MS)
      recoveryTimer.unref?.()
    },
    async recover() {
      await service.recover()
    },
    async shutdown() {
      if (closed) return
      closed = true
      if (recoveryTimer !== undefined) {
        clearTimeout(recoveryTimer)
        recoveryTimer = undefined
      }
      await runner.shutdown()
    },
  }
  return runtime
}
