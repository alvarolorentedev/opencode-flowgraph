import { describe, expect, it } from "vitest"
import type { HarnessCapabilities } from "../../src/execution/harness.js"
import {
  foreignControlTitle,
  foreignControlToast,
  foreignGuiLine,
  foreignPanelLine,
  foreignPickerSuffix,
  foreignRunSuffix,
  foreignSessionToast,
  harnessId,
  harnessLines,
  harnessWarnings,
  legacyReadOnlyPanelLine,
  legacyReadOnlyTitle,
  legacyReadOnlyToast,
  runPickerSuffix,
  runSuffix,
  type HarnessCapabilityState,
} from "../../src/ui/harness.js"

const opencode: HarnessCapabilities = {
  id: "opencode",
  displayName: "OpenCode",
  version: "2.2.5",
  agents: { discovery: "native" },
  sessions: { runScope: true, adoptLegacyRuns: true },
  results: { mechanism: "native_tool", corrections: true },
  permissions: { survivesRestart: true, approval: "native" },
  security: { nativePermissions: true, protectedPaths: "tool_hook", backgroundWork: "blocked" },
  usage: { tokens: true, cost: true },
  audit: true,
}

const unobservable: HarnessCapabilities = {
  ...opencode,
  id: "a-very-long-foreign-harness-identifier",
  version: undefined,
  sessions: { runScope: false, adoptLegacyRuns: false },
  results: { mechanism: "structured_output", corrections: false },
  permissions: { survivesRestart: false, approval: "none" },
  security: { nativePermissions: false, protectedPaths: "none", backgroundWork: "unobservable" },
}

describe("harness capability presentation", () => {
  it("renders loading, ready, and unavailable states", () => {
    expect(harnessLines({ status: "loading" })).toEqual(["Active harness: loading…"])
    expect(harnessLines({ status: "error" })).toEqual(["Active harness capabilities unavailable."])
    expect(harnessLines({ status: "ready", capabilities: opencode })).toEqual([
      "Active harness: opencode 2.2.5",
      "Results native_tool · Permissions native · Paths tool_hook · Background blocked",
    ])
    expect(harnessLines({ status: "ready", capabilities: unobservable })).toEqual([
      "Active harness: a-very-long-fore…",
      "Results structured_output · Permissions none · Paths none · Background unobservable",
    ])
  })

  it("omits the version when the adapter reports none", () => {
    const lines = harnessLines({ status: "ready", capabilities: unobservable })
    expect(lines[0]).toBe("Active harness: a-very-long-fore…")
  })

  it("warns only for unenforced security claims", () => {
    expect(harnessWarnings({ status: "ready", capabilities: opencode })).toEqual([])
    expect(harnessWarnings({ status: "loading" })).toEqual([])
    expect(harnessWarnings({ status: "error" })).toEqual([])
    expect(harnessWarnings({ status: "ready", capabilities: unobservable })).toEqual([
      "Warning: background work can outlive this step (unobservable).",
      "Warning: protected paths are not intercepted (none).",
    ])
  })

  it("truncates a displayed harness id to 16 characters", () => {
    expect(harnessId("opencode")).toBe("opencode")
    expect(harnessId("1234567890123456")).toBe("1234567890123456")
    expect(harnessId("12345678901234567")).toBe("1234567890123456…")
  })

  it("renders the exact foreign-run copy", () => {
    const id = "0123456789abcdef-extra"
    const shown = "0123456789abcdef…"
    expect(foreignRunSuffix({ id })).toBe(` · [${shown}]`)
    expect(foreignRunSuffix(undefined)).toBe("")
    expect(foreignPickerSuffix({ id })).toBe(` · ${shown}`)
    expect(foreignPickerSuffix(undefined)).toBe("")
    expect(foreignPanelLine(id)).toBe(`Harness ${shown} · read-only in this client`)
    expect(foreignControlToast(id)).toBe(
      `This run belongs to the ${shown} harness. Pause, resume, respond, and cancel are unavailable in this client.`,
    )
    expect(foreignSessionToast(id)).toBe(`Sessions for the ${shown} harness open in its own client.`)
    expect(foreignGuiLine(id)).toBe(
      `Read-only: this run belongs to the ${shown} harness. Controls are unavailable in this client.`,
    )
    expect(foreignControlTitle(id)).toBe(`Unavailable for ${shown} runs`)
    expect(runSuffix({ harness: { id } })).toBe(` · [${shown}]`)
    expect(runSuffix({ readOnly: true })).toBe(" · [read-only]")
    expect(runSuffix({})).toBe("")
    expect(runPickerSuffix({ harness: { id } })).toBe(` · ${shown}`)
    expect(runPickerSuffix({ readOnly: true })).toBe(" · read-only")
    expect(legacyReadOnlyPanelLine).toBe("Read-only in this client · harness identity unavailable")
    expect(legacyReadOnlyToast).toBe(
      "This run is read-only in this client because its harness identity is unavailable.",
    )
    expect(legacyReadOnlyTitle).toBe("Read-only run")
    const state: HarnessCapabilityState = { status: "ready", capabilities: opencode }
    expect(state.status).toBe("ready")
  })
})
