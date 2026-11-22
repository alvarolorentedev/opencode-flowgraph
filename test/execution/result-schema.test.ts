import { describe, expect, it } from "vitest"
import { z } from "zod"
import { NodeResultJsonSchema, NodeResultSchema } from "../../src/workflow/schema.js"

type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchema
  pattern?: string
}

describe("NodeResult JSON Schema", () => {
  const schema = NodeResultJsonSchema as JsonSchema

  it("is generated from NodeResultSchema, not hand-written", () => {
    expect(NodeResultJsonSchema).toEqual(z.toJSONSchema(NodeResultSchema))
  })

  it("exposes the canonical fields and required outcomes", () => {
    expect(schema.type).toBe("object")
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["evidence", "feedback", "outcome", "summary"])
    expect(schema.required).toEqual(expect.arrayContaining(["outcome", "summary"]))
    expect(schema.properties?.feedback?.type).toBe("string")
    expect(schema.properties?.evidence?.type).toBe("array")
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties?.outcome?.pattern).toBe("^[a-z][a-z0-9_]*$")
  })

  it("describes evidence items with their declared kinds", () => {
    const evidence = schema.properties?.evidence
    expect(evidence?.type).toBe("array")
    expect(Object.keys(evidence?.items?.properties ?? {}).sort()).toEqual(["kind", "value"])
    expect([...(evidence?.items?.required ?? [])].sort()).toEqual(["kind", "value"])
  })

  it("accepts a payload that matches the schema", () => {
    expect(NodeResultSchema.safeParse({
      outcome: "approved",
      summary: "looks good",
      feedback: "",
      evidence: [{ kind: "file", value: "src/index.ts" }],
    }).success).toBe(true)
  })
})
