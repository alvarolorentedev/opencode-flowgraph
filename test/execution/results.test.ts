import { describe, expect, it } from "vitest"
import { addUsage, auditFromMessages, zeroUsage } from "../../src/execution/results.js"

describe("result audit and usage", () => {
  it("separates observed mutating tools from agent-reported evidence", () => {
    const audit = auditFromMessages([
      {
        id: "msg_1",
        type: "assistant",
        time: { created: 1 },
        content: [
          { type: "text", text: "done" },
          { type: "tool", name: "read", executed: true, state: { status: "completed" } },
          { type: "tool", name: "shell", executed: true, state: { status: "completed" } },
          { type: "tool", name: "edit", executed: true, state: { status: "error" } },
        ],
      },
    ])
    expect(audit.toolCalls).toHaveLength(3)
    expect(audit.mutatingToolCalls).toBe(2)
    expect(audit.toolCalls.find((call) => call.name === "shell")?.mutating).toBe(true)
  })

  it("accumulates provider-reported usage without claiming it is enforced", () => {
    const usage = addUsage(zeroUsage(), {
      cost: 0.25,
      tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 2, write: 3 } },
    })
    expect(usage.costUSD).toBe(0.25)
    expect(usage.input).toBe(10)
    expect(usage.output).toBe(20)
    expect(usage.estimated).toBe(true)
    expect(usage.enforced).toBe(false)
  })
})
