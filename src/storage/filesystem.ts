import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { sha256 } from "../util/hash.js"
import {
  StateCorruptionError,
  type JsonValue,
  type StoragePort,
  type StorageScanResult,
} from "../state/store.js"

const MAX_KEY_BYTES = 4_096
const MAX_VALUE_BYTES = 16 * 1024 * 1024
const TEMP_PREFIX = ".tmp-"
const TEMP_MAX_AGE_MS = 60 * 60 * 1_000
const RECORD_SUFFIX = ".json"

export class StorageKeyError extends Error {
  constructor(key: string) {
    super(`invalid storage key: ${JSON.stringify(key.slice(0, 80))}`)
    this.name = "StorageKeyError"
  }
}

type Envelope = { version: 1; key: string; value: JsonValue }

function assertKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
    throw new StorageKeyError(key)
  }
  // The key is hashed before it touches the filesystem, but NUL bytes still
  // make the envelope and diagnostics ambiguous.
  if (key.includes("\u0000")) throw new StorageKeyError(key)
}

function assertPrefix(prefix: string): void {
  if (typeof prefix !== "string" || Buffer.byteLength(prefix, "utf8") > MAX_KEY_BYTES) {
    throw new StorageKeyError(prefix)
  }
  if (prefix.includes("\u0000")) throw new StorageKeyError(prefix)
}

function parseEnvelope(source: string, expected?: string, label = expected ?? "storage entry"): Envelope {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new StateCorruptionError(label, `stored value at ${label} is not valid JSON`)
  }
  if (
    value === null ||
    typeof value !== "object" ||
    (value as Envelope).version !== 1 ||
    typeof (value as Envelope).key !== "string" ||
    (value as Envelope).key.length === 0 ||
    !Object.hasOwn(value, "value") ||
    (expected !== undefined && (value as Envelope).key !== expected)
  ) {
    throw new StateCorruptionError(label, `stored value at ${label} has an invalid record envelope`)
  }
  return value as Envelope
}

/**
 * Durable key/value storage under one directory.
 *
 * Keys are hashed to file names, so a key can never forge a path. Writes go to
 * a same-directory temporary file, are fsynced, then atomically renamed; a
 * reader sees either the old or the new complete value. There is no
 * compare-and-swap: concurrent writers to one key resolve last-write-wins.
 */
export class FileSystemStoragePort implements StoragePort {
  readonly directory: string
  private base?: Promise<string>

  constructor(options: { directory: string; now?: () => number }) {
    this.directory = path.resolve(options.directory)
    this.now = options.now ?? Date.now
  }

  private readonly now: () => number

  private fileFor(key: string): string {
    return `${sha256(key)}${RECORD_SUFFIX}`
  }

  private async ensureBase(): Promise<string> {
    this.base ??= (async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
      const info = await fs.lstat(this.directory)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new StateCorruptionError(this.directory, "state directory must be a real directory, not a symlink")
      }
      await fs.chmod(this.directory, 0o700).catch(() => undefined)
      return this.directory
    })().catch((error: unknown) => {
      this.base = undefined
      throw error
    })
    return this.base
  }

  private async readFile(base: string, key: string): Promise<JsonValue | undefined> {
    const file = path.join(base, this.fileFor(key))
    let info
    try {
      info = await fs.lstat(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new StateCorruptionError(key, `stored value at ${key} is not a regular file`)
    }
    if (info.size > MAX_VALUE_BYTES) {
      throw new StateCorruptionError(key, `stored value at ${key} exceeds the size limit`)
    }
    let source: string
    try {
      source = await fs.readFile(file, "utf8")
    } catch (error) {
      // Deleted between the lstat and the read; the key is missing now.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    return parseEnvelope(source, key).value
  }

  async get(key: string): Promise<unknown> {
    assertKey(key)
    return this.readFile(await this.ensureBase(), key)
  }

  async set(key: string, value: JsonValue): Promise<void> {
    assertKey(key)
    const base = await this.ensureBase()
    const envelope: Envelope = { version: 1, key, value }
    let payload: string
    try {
      payload = JSON.stringify(envelope)
    } catch {
      throw new StorageKeyError(key)
    }
    if (Buffer.byteLength(payload, "utf8") > MAX_VALUE_BYTES) {
      throw new StorageKeyError(key)
    }

    const temp = path.join(base, `${TEMP_PREFIX}${process.pid}-${randomUUID()}`)
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await fs.open(temp, "wx", 0o600)
      await handle.writeFile(payload, "utf8")
      await handle.sync()
      await handle.close()
      handle = undefined
      await fs.rename(temp, path.join(base, this.fileFor(key)))
      await this.syncDirectory(base)
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      await fs.unlink(temp).catch(() => undefined)
      throw error
    }
  }

  async remove(key: string): Promise<void> {
    assertKey(key)
    const base = await this.ensureBase()
    const file = path.join(base, this.fileFor(key))
    let info
    try {
      info = await fs.lstat(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new StateCorruptionError(key, `stored value at ${key} is not a regular file`)
    }
    try {
      await fs.unlink(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    // Persist the unlink so a crash cannot resurrect a removed value.
    await this.syncDirectory(base)
  }

  async scan(options: { prefix: string; after?: string; limit?: number }): Promise<StorageScanResult> {
    assertPrefix(options.prefix)
    if (options.after !== undefined) {
      assertKey(options.after)
      // Bound the page key to the prefix so a foreign `after` cannot reorder
      // or skip records the caller asked to page through.
      if (!options.after.startsWith(options.prefix)) throw new StorageKeyError(options.after)
    }
    const base = await this.ensureBase()
    await this.cleanupTemps(base)

    let names: string[]
    try {
      names = await fs.readdir(base)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] }
      throw error
    }

    const entries: Array<{ key: string; value: unknown }> = []
    for (const name of names) {
      if (!name.endsWith(RECORD_SUFFIX)) continue
      const file = path.join(base, name)
      let info
      try {
        info = await fs.lstat(file)
      } catch (error) {
        // Deleted between the readdir and the lstat; nothing to scan.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new StateCorruptionError(name, `storage entry ${name} is not a regular file`)
      }
      if (info.size > MAX_VALUE_BYTES) {
        throw new StateCorruptionError(name, `storage entry ${name} exceeds the size limit`)
      }
      const source = await fs.readFile(file, "utf8").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      })
      if (source === undefined) continue
      const envelope = parseEnvelope(source, undefined, name)
      // The record must live under the hash of its own key, so a renamed or
      // tampered file cannot surface another key through prefix scans.
      if (`${sha256(envelope.key)}${RECORD_SUFFIX}` !== name) {
        throw new StateCorruptionError(name, `storage entry ${name} does not match its record key`)
      }
      if (!envelope.key.startsWith(options.prefix)) continue
      if (options.after !== undefined && envelope.key <= options.after) continue
      entries.push({ key: envelope.key, value: envelope.value })
    }

    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000))
    const page = entries.slice(0, limit)
    const last = page.at(-1)
    return {
      entries: page,
      ...(last !== undefined && entries.length > page.length ? { next: last.key } : {}),
    }
  }

  private async cleanupTemps(base: string): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(base)
    } catch {
      return
    }
    const cutoff = this.now() - TEMP_MAX_AGE_MS
    await Promise.all(names.filter((name) => name.startsWith(TEMP_PREFIX)).map(async (name) => {
      const file = path.join(base, name)
      const info = await fs.lstat(file).catch(() => undefined)
      if (info === undefined || !info.isFile() || info.mtimeMs > cutoff) return
      await fs.unlink(file).catch(() => undefined)
    }))
  }

  private async syncDirectory(base: string): Promise<void> {
    const handle = await fs.open(base, "r").catch(() => undefined)
    if (!handle) return
    try {
      await handle.sync()
    } catch {
      // Directory fsync is not available on every platform; the rename still
      // prevents torn values.
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
}
