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

export type ProjectLock = {
  projectID: string
  canonical: string
  release(): Promise<void>
}

export class ProjectLockManager {
  private readonly base = path.join(os.tmpdir(), "opencode-flowgraph", "locks")
  private readonly held = new Map<string, { release: () => Promise<void>; lock: ProjectLock }>()

  async acquire(projectID: string, canonical: string): Promise<ProjectLock> {
    const key = sha256(`${projectID}\u0000${canonical}`).slice(0, 40)
    const existing = this.held.get(key)
    if (existing) return existing.lock

    await fs.mkdir(this.base, { recursive: true })
    const target = path.join(this.base, `${key}.target`)
    await fs.writeFile(target, "", { flag: "a" })

    let release: () => Promise<void>
    try {
      release = await lockfile.lock(target, {
        realpath: false,
        stale: 120_000,
        update: 30_000,
        retries: 0,
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ELOCKED") throw new ProjectBusyError()
      throw error
    }

    let released = false
    const lock: ProjectLock = {
      projectID,
      canonical,
      release: async () => {
        if (released) return
        released = true
        this.held.delete(key)
        await release().catch(() => undefined)
      },
    }
    this.held.set(key, { release, lock })
    return lock
  }

  async releaseAll(): Promise<void> {
    const locks = Array.from(this.held.values())
    this.held.clear()
    await Promise.allSettled(locks.map((item) => item.release()))
  }

  get size(): number {
    return this.held.size
  }
}
