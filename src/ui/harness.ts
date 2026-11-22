import type { HarnessCapabilities } from "../execution/harness.js"

export type HarnessCapabilityState =
  | { status: "loading" }
  | { status: "ready"; capabilities: HarnessCapabilities }
  | { status: "error" }

export function harnessId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id
}

export function harnessLines(state: HarnessCapabilityState): string[] {
  if (state.status === "loading") return ["Active harness: loading…"]
  if (state.status === "error") return ["Active harness capabilities unavailable."]
  const { capabilities: value } = state
  return [
    `Active harness: ${harnessId(value.id)}${value.version === undefined ? "" : ` ${value.version}`}`,
    `Results ${value.results.mechanism} · Permissions ${value.permissions.approval} · ` +
      `Paths ${value.security.protectedPaths} · Background ${value.security.backgroundWork}`,
  ]
}

export function harnessWarnings(state: HarnessCapabilityState): string[] {
  if (state.status !== "ready") return []
  const { security } = state.capabilities
  return [
    ...(security.backgroundWork === "unobservable"
      ? ["Warning: background work can outlive this step (unobservable)."]
      : []),
    ...(security.protectedPaths === "none"
      ? ["Warning: protected paths are not intercepted (none)."]
      : []),
    ...(security.protectedPaths === "best_effort"
      ? [
          "Warning: protected paths are best-effort; shell checks are heuristic.",
          security.nativePermissions
            ? "Native permissions remain the security boundary."
            : "No native permission boundary is available.",
        ]
      : []),
  ]
}

/** A graph is read-only when a foreign harness owns it or the active adapter cannot adopt it. */
export function readOnlyGraph(value: { harness?: { id: string }; readOnly?: true }): boolean {
  return value.harness !== undefined || value.readOnly === true
}

export function graphControlTitle(value: { harness?: { id: string }; readOnly?: true }): string | undefined {
  if (value.harness !== undefined) return foreignControlTitle(value.harness.id)
  return value.readOnly === true ? legacyReadOnlyTitle : undefined
}

/** Picker selection: owned runs follow their native session; foreign and legacy runs open read-only. */
export function readOnlyRun(run: { harness?: { id: string }; readOnly?: true }): boolean {
  return run.harness !== undefined || run.readOnly === true
}

export const readOnlyNoHostToast =
  "Open a session first: the read-only graph opens in that session's Workflow panel."

export function foreignRunSuffix(harness: { id: string } | undefined): string {
  return harness === undefined ? "" : ` · [${harnessId(harness.id)}]`
}

/** Row badge for a run the active adapter does not own. */
export function runSuffix(run: { harness?: { id: string }; readOnly?: true }): string {
  if (run.harness !== undefined) return foreignRunSuffix(run.harness)
  return run.readOnly ? " · [read-only]" : ""
}

export function runPickerSuffix(run: { harness?: { id: string }; readOnly?: true }): string {
  if (run.harness !== undefined) return foreignPickerSuffix(run.harness)
  return run.readOnly ? " · read-only" : ""
}

export const legacyReadOnlyPanelLine = "Read-only in this client · harness identity unavailable"
export const legacyReadOnlyToast = "This run is read-only in this client because its harness identity is unavailable."
export const legacyReadOnlyTitle = "Read-only run"

// The GUI picker title uses the same separator without the bracketed row badge.
export function foreignPickerSuffix(harness: { id: string } | undefined): string {
  return harness === undefined ? "" : ` · ${harnessId(harness.id)}`
}

export function foreignPanelLine(id: string): string {
  return `Harness ${harnessId(id)} · read-only in this client`
}

export function foreignControlToast(id: string): string {
  return (
    `This run belongs to the ${harnessId(id)} harness. ` +
    "Pause, resume, respond, and cancel are unavailable in this client."
  )
}

export function foreignSessionToast(id: string): string {
  return `Sessions for the ${harnessId(id)} harness open in its own client.`
}

export function foreignGuiLine(id: string): string {
  return (
    `Read-only: this run belongs to the ${harnessId(id)} harness. ` +
    "Native sessions and controls are unavailable in this client."
  )
}

export function foreignControlTitle(id: string): string {
  return `Unavailable for ${harnessId(id)} runs`
}
