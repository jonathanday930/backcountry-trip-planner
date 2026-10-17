export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatCompletionRequest {
  system: string
  history: ChatTurn[]
  message: string
  parkId: string
}

export interface ToolCallSummary {
  name: string
  label: string
  durationMs: number
  ok: boolean
}

export interface ChatCompletionResult {
  reply: string
  toolCalls: ToolCallSummary[]
}
