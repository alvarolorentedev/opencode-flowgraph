import { describe, expect, it } from "vitest"
import { RunSummarySchema, type RunSummary } from "../../src/state/types.js"
import { compareLocatedRuns, discoverLocations, listLocatedRuns, waitForRunSession } from "../../src/ui/runs.js"
import { zeroUsage } from "../../src/execution/results.js"

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return RunSummarySchema.parse({
    runID: "run_1",
    workflowID: "sample",
    project: { id: "prj_1", canonical: "/root", directory: "/root" },
    objective: "do it",
    status: "completed",
    revision: 1,
    currentNode: null,
    nextNode: null,
    stepCount: 1,
    maxSteps: 3,
    createdAt: 1,
    updatedAt: 1,
    runSessionID: "sess_run_1",
    blocker: null,
    failure: null,
    usage: zeroUsage(),
    ...overrides,
  })
}

describe("workflow run discovery", () => {
  it("discovers project roots and worktrees, tolerating failures", async () => {
    const client = {
      project: {
        list: async () => [
          { id: "prj_1", canonical: "/root" },
          { id: "prj_2", canonical: "/other" },
        ],
      },
      worktree: {
        list: async ({ projectID }: { projectID: string }) => {
          if (projectID !== "prj_1") throw new Error("unsupported")
          return [{ directory: "/root-wt" }]
        },
      },
    } as never

    const locations = await discoverLocations(client, "/current")
    expect(new Set(locations)).toEqual(new Set(["/current", "/root", "/other", "/root-wt"]))
  })

  it("merges runs from every location and omits unavailable ones", async () => {
    const client = {
      project: {
        list: async () => [
          { id: "prj_1", canonical: "/root" },
          { id: "prj_broken", canonical: "/broken" },
        ],
      },
      worktree: { list: async () => [] },
    } as never
    const rpc = {
      listRuns: async (_input: unknown, options: { location: { directory: string } }) => {
        if (options.location.directory === "/broken") throw new Error("not loaded")
        return {
          runs: [
            summary({
              runID: options.location.directory === "/root" ? "run_root" : "run_wt",
              project: { id: "prj_1", canonical: options.location.directory, directory: options.location.directory },
              status: options.location.directory === "/root" ? "running" : "completed",
              updatedAt: options.location.directory === "/root" ? 1 : 2,
            }),
          ],
        }
      },
    } as never

    const result = await listLocatedRuns({
      client,
      rpc,
      currentDirectory: "/wt",
      limit: 10,
    })
    expect(result.unavailable).toEqual(["/broken"])
    expect(result.runs.map((item) => item.run.runID)).toEqual(["run_root", "run_wt"])
    expect(result.runs.map((item) => item.directory)).toEqual(["/root", "/wt"])
  })

  it("sorts active runs first, then newest updates", () => {
    const runs = [
      { run: summary({ runID: "done", status: "completed", updatedAt: 50 }), directory: "/a" },
      { run: summary({ runID: "running", status: "running", updatedAt: 10 }), directory: "/a" },
      { run: summary({ runID: "blocked", status: "blocked", updatedAt: 20 }), directory: "/a" },
      { run: summary({ runID: "newer", status: "completed", updatedAt: 60 }), directory: "/a" },
    ]
    expect(runs.sort(compareLocatedRuns).map((item) => item.run.runID)).toEqual([
      "running",
      "blocked",
      "newer",
      "done",
    ])
  })

  it("returns the run session when it appears", async () => {
    let calls = 0
    const rpc = {
      getRunGraph: async () => {
        calls += 1
        return { runSessionID: calls === 1 ? null : "sess_ready" }
      },
    } as never
    expect(await waitForRunSession(rpc, "/root", "run_1", 1_000)).toBe("sess_ready")
  })
})
