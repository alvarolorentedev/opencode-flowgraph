import { randomBytes, randomUUID } from "node:crypto"

function suffix(bytes = 8): string {
  return randomBytes(bytes).toString("hex")
}

export function newRunID(now = Date.now()): string {
  return `run_${now.toString(36).padStart(10, "0")}_${suffix(6)}`
}

export function newStepID(stepIndex: number, attempt: number): string {
  return `step_${String(stepIndex).padStart(6, "0")}_a${String(attempt).padStart(3, "0")}`
}

export function newMessageID(now = Date.now()): string {
  return `msg_${now.toString(36)}_${suffix(8)}`
}

export function newInstanceID(): string {
  return `inst_${randomUUID()}`
}

export function newRequestID(): string {
  return randomUUID()
}

export function safeSegment(value: string): string {
  return encodeURIComponent(value)
}
