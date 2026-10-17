import Anthropic from '@anthropic-ai/sdk'
import { TOOLS, executeTool, describeToolCall } from '../tools/index.js'
import type { ChatCompletionRequest, ChatCompletionResult, ToolCallSummary } from './types.js'

// Tool-calling: a manual loop below, not the SDK's beta Tool Runner — we need per-tool duration
// tracking (for the frontend's activity chips), a per-tool try/catch that turns a thrown error
// into an `is_error` tool_result instead of aborting the whole turn, and a hard iteration cap,
// none of which the Tool Runner exposes as cleanly. RAG would still slot in independently of this
// (a `contextChunks: string[]` field rendered into `system` before the call).

const client = new Anthropic()

const MODEL = process.env.CHAT_MODEL ?? 'claude-haiku-4-5'
const MAX_TOKENS = process.env.CHAT_MAX_TOKENS ? Number(process.env.CHAT_MAX_TOKENS) : 4096
const MAX_TOOL_ITERATIONS = 6

const FALLBACK_REPLY = "Sorry, I couldn't come up with a reply for that — could you try rephrasing?"
const TIMEOUT_REPLY = "I looked into a few things but couldn't finish in time — could you narrow the question?"

export async function getChatReply(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
  const messages: Anthropic.MessageParam[] = [
    ...req.history.map((t) => ({ role: t.role, content: t.content }) as Anthropic.MessageParam),
    { role: 'user', content: req.message },
  ]
  const toolCalls: ToolCallSummary[] = []

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: req.system,
      tools: TOOLS,
      messages,
    })
    messages.push({ role: 'assistant', content: response.content })

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
      const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
      if (!textBlock) {
        console.error('[chat:anthropic] no text block in response, stop_reason:', response.stop_reason)
        return { reply: FALLBACK_REPLY, toolCalls }
      }
      return { reply: textBlock.text, toolCalls }
    }

    // All of one turn's tool_use blocks must get their tool_result in a single following `user`
    // message — splitting them across messages trains the model to stop batching parallel calls.
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of toolUseBlocks) {
      const start = Date.now()
      try {
        const result = await executeTool(block.name, block.input, { parkId: req.parkId })
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) })
        toolCalls.push({ name: block.name, label: describeToolCall(block.name, block.input), durationMs: Date.now() - start, ok: true })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: message, is_error: true })
        toolCalls.push({ name: block.name, label: describeToolCall(block.name, block.input), durationMs: Date.now() - start, ok: false })
      }
    }
    messages.push({ role: 'user', content: toolResults })
  }

  return { reply: TIMEOUT_REPLY, toolCalls }
}
