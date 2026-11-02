import { describe, expect, it } from "vitest"
import { errorDetail, errorMessage } from "../../src/util/redact.js"

describe("errorMessage", () => {
  it("reads Error messages", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom")
  })

  it("reads plain RPC error objects", () => {
    expect(errorMessage({ _tag: "RpcError", type: "not_found", message: "workflow not found: test" })).toBe(
      "workflow not found: test",
    )
  })

  it("falls back for unknown values", () => {
    expect(errorMessage({}, "fallback")).toBe("fallback")
  })
})

describe("errorDetail", () => {
  it("appends the first workflow diagnostic", () => {
    expect(
      errorDetail(
        {
          _tag: "RpcError",
          type: "invalid_workflow",
          message: "workflow validation failed",
          data: { diagnostics: [{ path: "nodes.po.agent", message: 'agent "po" was not found' }] },
        },
        "fallback",
      ),
    ).toBe('workflow validation failed: agent "po" was not found')
  })

  it("leaves errors without diagnostics unchanged", () => {
    expect(errorDetail({ message: "workflow not found: test" }, "fallback")).toBe("workflow not found: test")
  })
})
