export type SessionContentPart = {
  type: string
  text?: string
  name?: string
  executed?: boolean
  state?: { status?: "streaming" | "running" | "completed" | "error" }
}

export type SessionMessage = {
  id: string
  type: string
  time: { created: number }
  outcome?: "succeeded" | "failed" | "interrupted"
  error?: { type: string; message: string }
  agent?: string
  content?: SessionContentPart[]
}
