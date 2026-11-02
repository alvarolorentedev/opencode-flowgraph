import { describe, expect, it } from "vitest"
import { parseWorkflowCommand } from "../src/command.js"

describe("parseWorkflowCommand", () => {
  it("opens the graph with no input", () => {
    expect(parseWorkflowCommand()).toEqual({ type: "graph" })
    expect(parseWorkflowCommand("   ")).toEqual({ type: "graph" })
  })

  it("opens the graph with graph or visuals", () => {
    expect(parseWorkflowCommand("graph")).toEqual({ type: "graph" })
    expect(parseWorkflowCommand("visuals")).toEqual({ type: "graph" })
    expect(parseWorkflowCommand("visual")).toEqual({ type: "graph" })
    expect(parseWorkflowCommand("view")).toEqual({ type: "graph" })
  })

  it("opens the run list", () => {
    expect(parseWorkflowCommand("runs")).toEqual({ type: "runs" })
    expect(parseWorkflowCommand("all")).toEqual({ type: "runs" })
    expect(parseWorkflowCommand("page")).toEqual({ type: "runs" })
  })

  it("lists workflows", () => {
    expect(parseWorkflowCommand("list")).toEqual({ type: "list" })
    expect(parseWorkflowCommand("LIST")).toEqual({ type: "list" })
  })

  it("parses run with a workflow and objective", () => {
    expect(parseWorkflowCommand("run product-delivery Build the feature")).toEqual({
      type: "run",
      workflowID: "product-delivery",
      objective: "Build the feature",
    })
  })

  it("parses run without a workflow or objective", () => {
    expect(parseWorkflowCommand("run")).toEqual({ type: "run" })
    expect(parseWorkflowCommand("start product-delivery")).toEqual({
      type: "run",
      workflowID: "product-delivery",
    })
  })

  it("parses the shorthand", () => {
    expect(parseWorkflowCommand("product-delivery Build the feature")).toEqual({
      type: "run",
      workflowID: "product-delivery",
      objective: "Build the feature",
    })
  })
})
