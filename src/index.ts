import { Plugin } from "@opencode/plugin"
import type { CapabilitiesOutput } from "./contract.js"
import { AgentWorkflowsRpc } from "./rpc.js"
import { createRpcHandlers } from "./rpc/handlers.js"
import { WorkflowService } from "./service.js"
import { WorkflowRepository } from "./workflow/loader.js"
import { HARD_LIMITS } from "./workflow/schema.js"
import { WorkflowStore, type JsonValue, type StoragePort } from "./state/store.js"
import { ProjectLockManager } from "./state/concurrency.js"
import { createInvocationRegistry } from "./execution/report-tool.js"
import { ReportTool } from "./execution/report-tool.js"
import { registerToolHooks } from "./execution/tool-hooks.js"
import { WorkflowRunner } from "./execution/runner.js"
import { OpenCodeNativeRuntime } from "./execution/native-agents.js"
import { newInstanceID } from "./util/ids.js"
import { PLUGIN_NAME, PLUGIN_VERSION } from "./version.js"

type OpenCodePluginContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

function storagePort(ctx: OpenCodePluginContext): StoragePort {
  return {
    get: (key) => ctx.storage.get(key),
    set: (key, value) => ctx.storage.set(key, value as never),
    remove: (key) => ctx.storage.remove(key),
    scan: async (options) => {
      const result = await ctx.storage.scan(options)
      return {
        entries: result.entries.map((entry) => ({ key: entry.key, value: entry.value })),
        ...(result.next === undefined ? {} : { next: result.next }),
      }
    },
  }
}

function numberOption(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

export default Plugin.define({
  id: "agent-workflows",
  async setup(ctx) {
    const instanceID = newInstanceID()
    const project = {
      id: ctx.location.project.id,
      canonical: ctx.location.project.canonical,
      directory: ctx.location.directory,
    }
    const store = new WorkflowStore(storagePort(ctx))
    const native = new OpenCodeNativeRuntime(ctx)
    const repo = new WorkflowRepository(ctx.location.project.directory)
    const locks = new ProjectLockManager()
    const invocations = createInvocationRegistry()
    let emitRunUpdated: (payload: unknown) => Promise<void> = async () => undefined

    const runner = new WorkflowRunner({
      store,
      native,
      locks,
      invocations,
      emit: (payload) => emitRunUpdated(payload),
      options: {
        pollIntervalMs: numberOption(ctx.options.pollIntervalMs, 1_000),
        recoveryGraceMs: numberOption(ctx.options.recoveryGraceMs, 5_000),
      },
    })

    const reportTool = new ReportTool(ctx, store, invocations)
    await reportTool.register()
    await reportTool.requireTool()
    await registerToolHooks(ctx, invocations, {
      allowBackgroundWork: ctx.options.allowBackgroundWork === true,
    })

    const service = new WorkflowService({
      project,
      store,
      runner,
      native,
      repo,
      instanceID,
      emit: (payload) => emitRunUpdated(payload),
    })

    const capabilities: CapabilitiesOutput = {
      plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
      rpc: { id: "agent_workflows", version: 1 },
      workflowSchemaVersion: 1,
      openCodeVersion: ctx.app.version,
      features: {
        conditionalRoutes: true,
        cycles: true,
        pause: true,
        structuredResults: "tool",
        conservativeRecovery: true,
        parallelBranches: false,
        nestedWorkflows: false,
        backgroundNativeWork: false,
      },
      limits: {
        maxWorkflowBytes: HARD_LIMITS.maxWorkflowBytes,
        maxNodes: HARD_LIMITS.maxNodes,
        maxSteps: HARD_LIMITS.maxSteps,
        maxObjectiveBytes: HARD_LIMITS.maxObjectiveBytes,
        maxRuns: HARD_LIMITS.maxRuns,
      },
      storage: {
        durable: true,
        transactional: false,
        compareAndSwap: false,
        projectScopedKeys: true,
      },
    }

    const rpcRegistration = await ctx.rpc.register(AgentWorkflowsRpc as never, createRpcHandlers(service, capabilities) as never)
    emitRunUpdated = (payload) => rpcRegistration.events.emit("runUpdated", payload as never)

    const recoveryTimer = setTimeout(() => {
      void service.recover().catch((error) => {
        console.error("agent-workflows: recovery failed", error instanceof Error ? error.message : "unknown error")
      })
    }, 250)
    recoveryTimer.unref?.()

    return async () => {
      clearTimeout(recoveryTimer)
      await runner.shutdown()
    }
  },
})
