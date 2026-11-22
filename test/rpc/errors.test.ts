import { describe, expect, it } from "vitest"
import { ProjectBusyError } from "../../src/state/concurrency.js"
import { InvalidHumanResponseError } from "../../src/execution/runner.js"
import { toRpcError, type ErrorContext } from "../../src/rpc/errors.js"

function recorder() {
  const calls: Array<{ type: string; message: string; data?: unknown }> = []
  const context: ErrorContext = {
    error(type, message, data) {
      calls.push({ type, message, data })
      return { type }
    },
  }
  return { context, calls }
}

describe("toRpcError", () => {
  it("sends data for project_busy so the RPC host can encode the error", () => {
    const { context, calls } = recorder()
    toRpcError(context, new ProjectBusyError())
    expect(calls).toEqual([
      {
        type: "project_busy",
        message: "another workflow is active for this project",
        data: { message: "another workflow is active for this project" },
      },
    ])
  })

  it("maps an undeclared human outcome to invalid_input", () => {
    const { context, calls } = recorder()
    toRpcError(context, new InvalidHumanResponseError('outcome "maybe" is not declared for node "signoff"'))
    expect(calls).toEqual([
      {
        type: "invalid_input",
        message: 'outcome "maybe" is not declared for node "signoff"',
        data: { message: 'outcome "maybe" is not declared for node "signoff"' },
      },
    ])
  })
})
