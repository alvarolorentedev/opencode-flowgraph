import type { OpenCodeClient, RpcClient } from "@opencode/client/promise"
import type { FlowgraphRpcDefinition } from "../rpc.js"
import type { RunSummary } from "../state/types.js"
import { withTimeout } from "../util/timeout.js"

export type LocatedRun = {
  run: RunSummary
  directory: string
}

type FlowgraphRpcClient = RpcClient<FlowgraphRpcDefinition>

const STATUS_RANK: Record<string, number> = {
  running: 0,
  pausing: 0,
  blocked: 1,
  paused: 2,
}

function statusRank(status: string): number {
  return STATUS_RANK[status] ?? 3
}

export function compareLocatedRuns(a: LocatedRun, b: LocatedRun): number {
  return (
    statusRank(a.run.status) - statusRank(b.run.status) ||
    b.run.updatedAt - a.run.updatedAt ||
    b.run.runID.localeCompare(a.run.runID)
  )
}

export async function discoverLocations(client: OpenCodeClient, currentDirectory?: string): Promise<string[]> {
  const locations = new Set<string>()
  if (currentDirectory) locations.add(currentDirectory)

  let projects: Array<{ id: string; canonical: string }>
  try {
    projects = await client.project.list()
  } catch {
    return [...locations]
  }

  await Promise.all(
    projects.map(async (project) => {
      if (project.canonical) locations.add(project.canonical)
      try {
        const worktrees = await client.worktree.list({ projectID: project.id })
        for (const worktree of worktrees) locations.add(worktree.directory)
      } catch {
        // A project without worktree support still has its canonical root.
      }
    }),
  )

  return [...locations]
}

export async function listLocatedRuns(input: {
  client: OpenCodeClient
  rpc: FlowgraphRpcClient
  currentDirectory?: string
  limit?: number
}): Promise<{ runs: LocatedRun[]; locations: string[]; unavailable: string[] }> {
  const locations = await discoverLocations(input.client, input.currentDirectory)
  const unavailable: string[] = []

  const results = await Promise.all(
    locations.map(async (directory) => {
      try {
        const result = await input.rpc.listRuns(
          { limit: input.limit ?? 50 },
          { location: { directory } },
        )
        return result.runs
      } catch {
        unavailable.push(directory)
        return []
      }
    }),
  )

  const seen = new Set<string>()
  const runs: LocatedRun[] = []
  for (const run of results.flat()) {
    const key = `${run.project.id}\u0000${run.runID}`
    if (seen.has(key)) continue
    seen.add(key)
    runs.push({ run, directory: run.project.directory })
  }
  runs.sort(compareLocatedRuns)
  return { runs, locations, unavailable }
}

export async function waitForRunSession(
  rpc: FlowgraphRpcClient,
  directory: string,
  runID: string,
  timeoutMs = 5_000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const graph = await withTimeout(
      rpc.getRunGraph({ runID }, { location: { directory } }),
      2_000,
      "workflow run session lookup timed out",
    ).catch(() => undefined)
    if (graph?.runSessionID) return graph.runSessionID
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return undefined
}
