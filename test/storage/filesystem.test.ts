import { afterEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { FileSystemStoragePort, StorageKeyError } from "../../src/storage/filesystem.js"
import { StateCorruptionError } from "../../src/state/store.js"

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "awf-fs-"))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function recordFile(port: FileSystemStoragePort, key: string): Promise<string> {
  const names = await fs.readdir(port.directory)
  const source = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    const file = path.join(port.directory, name)
    const value = JSON.parse(await fs.readFile(file, "utf8")) as { key?: string }
    return value.key === key ? file : undefined
  }))
  const found = source.find((file): file is string => file !== undefined)
  if (!found) throw new Error(`record for ${key} not found`)
  return found
}

describe("FileSystemStoragePort", () => {
  it("reads, writes, deletes, and reports missing keys", async () => {
    const directory = path.join(await tempDir(), "state")
    const port = new FileSystemStoragePort({ directory })
    expect(await port.get("v1/a")).toBeUndefined()
    await port.set("v1/a", { value: 1 })
    expect(await port.get("v1/a")).toEqual({ value: 1 })
    await port.remove("v1/a")
    expect(await port.get("v1/a")).toBeUndefined()
    await port.remove("v1/a")
  })

  it("persists values across instances", async () => {
    const directory = path.join(await tempDir(), "state")
    await new FileSystemStoragePort({ directory }).set("v1/key", { nested: [true, 2, "three"] })
    const second = new FileSystemStoragePort({ directory })
    expect(await second.get("v1/key")).toEqual({ nested: [true, 2, "three"] })
  })

  it("scans prefixes deterministically and paginates with after/limit/next", async () => {
    const directory = path.join(await tempDir(), "state")
    const port = new FileSystemStoragePort({ directory })
    for (const key of ["p/a", "p/b", "p/c", "p/d", "q/a"]) await port.set(key, key)

    expect((await port.scan({ prefix: "p/" })).entries.map((entry) => entry.key)).toEqual(["p/a", "p/b", "p/c", "p/d"])
    expect((await port.scan({ prefix: "p/", limit: 2 })).entries.map((entry) => entry.key)).toEqual(["p/a", "p/b"])

    const first = await port.scan({ prefix: "p/", limit: 2 })
    expect(first.next).toBe("p/b")
    const second = await port.scan({ prefix: "p/", after: first.next, limit: 2 })
    expect(second.entries.map((entry) => entry.key)).toEqual(["p/c", "p/d"])
    expect(second.next).toBeUndefined()

    const third = await port.scan({ prefix: "p/", after: "p/b", limit: 1 })
    expect(third.entries.map((entry) => entry.key)).toEqual(["p/c"])
    expect(third.next).toBe("p/c")
  })

  it("keeps concurrent writes whole and last-write-wins", async () => {
    const directory = path.join(await tempDir(), "state")
    const port = new FileSystemStoragePort({ directory })
    const values = Array.from({ length: 20 }, (_, index) => ({ writer: index, text: `value-${index}` }))
    await Promise.all(values.map((value) => port.set("v1/shared", value)))
    const final = await port.get("v1/shared") as { writer: number }
    expect(values.some((value) => value.writer === final.writer)).toBe(true)
    expect((await port.scan({ prefix: "v1/shared" })).entries).toHaveLength(1)
  })

  it("fails closed on corrupted records", async () => {
    const directory = path.join(await tempDir(), "state")
    const port = new FileSystemStoragePort({ directory })
    await port.set("v1/good", { ok: true })
    const file = await recordFile(port, "v1/good")
    await fs.writeFile(path.join(directory, "corrupt.json"), "{not json")
    await expect(port.scan({ prefix: "v1/" })).rejects.toBeInstanceOf(StateCorruptionError)

    await fs.unlink(path.join(directory, "corrupt.json"))
    await fs.writeFile(file, JSON.stringify({ version: 1, key: "v1/other", value: 1 }))
    await expect(port.get("v1/good")).rejects.toMatchObject({ name: "StateCorruptionError" })
  })

  it("rejects a scanned record whose filename does not match its key", async () => {
    const directory = path.join(await tempDir(), "state")
    const port = new FileSystemStoragePort({ directory })
    await port.set("v1/good", { ok: true })
    const file = await recordFile(port, "v1/good")
    await fs.writeFile(file, JSON.stringify({ version: 1, key: "v1/other", value: 1 }))

    await expect(port.scan({ prefix: "v1/" })).rejects.toThrow(/does not match its record key/u)
  })

  it("rejects invalid keys", async () => {
    const port = new FileSystemStoragePort({ directory: path.join(await tempDir(), "state") })
    await expect(port.get("")).rejects.toBeInstanceOf(StorageKeyError)
    await expect(port.set("bad\u0000key", 1)).rejects.toBeInstanceOf(StorageKeyError)
    await expect(port.remove("")).rejects.toBeInstanceOf(StorageKeyError)
    await expect(port.scan({ prefix: "bad\u0000" })).rejects.toBeInstanceOf(StorageKeyError)
  })

  it("hashes keys so traversal strings cannot escape the state directory", async () => {
    const project = await tempDir()
    const directory = path.join(project, "state")
    const port = new FileSystemStoragePort({ directory })
    await port.set("../../outside", { safe: true })
    expect(await port.get("../../outside")).toEqual({ safe: true })
    expect(await fs.readdir(project)).toEqual(["state"])
    const names = await fs.readdir(directory)
    expect(names.every((name) => /^[0-9a-f]{64}\.json$/u.test(name))).toBe(true)
  })

  it("does not follow symlinked records", async () => {
    const project = await tempDir()
    const directory = path.join(project, "state")
    const outside = path.join(project, "outside.json")
    await fs.writeFile(outside, JSON.stringify({ version: 1, key: "v1/symlink", value: "outside" }))
    const port = new FileSystemStoragePort({ directory })
    await port.set("v1/symlink", "inside")
    const file = await recordFile(port, "v1/symlink")
    await fs.unlink(file)
    await fs.symlink(outside, file)
    await expect(port.get("v1/symlink")).rejects.toMatchObject({ name: "StateCorruptionError" })
    await expect(port.scan({ prefix: "v1/" })).rejects.toMatchObject({ name: "StateCorruptionError" })
  })

  it("rejects a symlinked state directory", async () => {
    const project = await tempDir()
    const outside = await tempDir()
    const directory = path.join(project, "state")
    await fs.symlink(outside, directory)
    const port = new FileSystemStoragePort({ directory })
    await expect(port.set("v1/key", "value")).rejects.toMatchObject({ name: "StateCorruptionError" })
    expect(await fs.readdir(outside)).toEqual([])
  })

  it("uses restrictive permissions for the directory and records", async () => {
    const directory = path.join(await tempDir(), "state")
    const port = new FileSystemStoragePort({ directory })
    await port.set("v1/key", "value")
    const directoryStat = await fs.stat(directory)
    const fileStat = await fs.stat(await recordFile(port, "v1/key"))
    expect(directoryStat.mode & 0o777).toBe(0o700)
    expect(fileStat.mode & 0o777).toBe(0o600)
  })

  it("keeps temporary files in the state directory and cleans only abandoned ones", async () => {
    const directory = path.join(await tempDir(), "state")
    const port = new FileSystemStoragePort({ directory })
    await port.set("v1/key", "value")
    const stale = path.join(directory, ".tmp-stale")
    const fresh = path.join(directory, ".tmp-fresh")
    await fs.writeFile(stale, "partial")
    await fs.writeFile(fresh, "active")
    const old = new Date(Date.now() - 2 * 60 * 60 * 1_000)
    await fs.utimes(stale, old, old)
    await port.scan({ prefix: "v1/" })
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(fs.stat(fresh)).resolves.toBeDefined()
  })

  it("isolates temp files from the workflow and OS temporary directories", async () => {
    const project = await tempDir()
    const directory = path.join(project, "state")
    const port = new FileSystemStoragePort({ directory })
    await port.set("v1/key", "value")
    expect(await fs.readdir(project)).toEqual(["state"])
    expect((await fs.readdir(directory)).some((name) => name.startsWith(".tmp-"))).toBe(false)
  })
})
