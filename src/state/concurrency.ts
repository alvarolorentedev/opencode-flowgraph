import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import lockfile from "proper-lockfile"
import { sha256 } from "../util/hash.js"

export class ProjectBusyError extends Error {
  constructor(message = "another workflow is active for this project") {
    super(message)
    this.name = "ProjectBusyError"
  }
}

export class RunOwnershipError extends Error {
  constructor() {
    super("another instance owns this workflow run")
    this.name = "RunOwnershipError"
  }
}

export type RunLock = { release(): Promise<void> }

export class RunLockManager {
  private readonly base = path.join(os.tmpdir(), "opencode-flowgraph", "locks")

  async acquire(projectID: string, canonical: string, runID: string): Promise<RunLock> {
    const key = sha256(`${projectID}\u0000${canonical}\u0000${runID}`).slice(0, 40)
    await fs.mkdir(this.base, { recursive: true })
    try {
      const release = await lockfile.lock(path.join(this.base, key), {
        realpath: false,
        stale: 120_000,
        update: 30_000,
        retries: 0,
      })
      return { release }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new RunOwnershipError()
      throw error
    }
  }
}
