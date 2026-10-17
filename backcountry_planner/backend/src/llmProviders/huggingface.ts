import OpenAI from 'openai'
import { executeTool, describeToolCall } from '../tools/index.js'
import { OPENAI_TOOLS } from '../tools/toOpenAiTools.js'
import type { ChatCompletionRequest, ChatCompletionResult, ToolCallSummary } from './types.js'

// Hugging Face's Inference Providers router is OpenAI-compatible, so this reuses the `openai`
// SDK purely as an HTTP client rather than pulling in a second bespoke provider client. Mirrors
// anthropic.ts's tool loop (iteration cap, per-tool try/catch -> error tool result instead of
// aborting the turn, per-tool duration tracking, same fallback strings) with OpenAI's
// `tool_calls` / `role: 'tool'` message shape instead of Anthropic's `tool_use`/`tool_result`.

// Constructed lazily (not at module load) since llm.ts imports this module unconditionally —
// eagerly building the client would throw on missing HF_TOKEN even when LLM_PROVIDER=anthropic.
let client: OpenAI | undefined
function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      baseURL: 'https://router.huggingface.co/v1',
      apiKey: process.env.HF_TOKEN || 'unset',
    })
  }
  return client
}

const MODEL = process.env.HF_MODEL ?? 'meta-llama/Llama-3.3-70B-Instruct:novita'
const MAX_TOKENS = process.env.CHAT_MAX_TOKENS ? Number(process.env.CHAT_MAX_TOKENS) : 4096
const MAX_TOOL_ITERATIONS = 6

const FALLBACK_REPLY = "Sorry, I couldn't come up with a reply for that — could you try rephrasing?"
const TIMEOUT_REPLY = "I looked into a few things but couldn't finish in time — could you narrow the question?"

export async function getChatReply(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: req.system },
    ...req.history.map((t) => ({ role: t.role, content: t.content }) as OpenAI.Chat.Completions.ChatCompletionMessageParam),
    { role: 'user', content: req.message },
  ]
  const toolCalls: ToolCallSummary[] = []

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await getClient().chat.completions.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages,
      tools: OPENAI_TOOLS,
    })
    const choice = response.choices[0]
    const assistantMessage = choice?.message
    if (!assistantMessage) {
      console.error('[chat:huggingface] no message in response')
      return { reply: FALLBACK_REPLY, toolCalls }
    }
    messages.push(assistantMessage)

    const toolCallBlocks = assistantMessage.tool_calls ?? []
    if (choice.finish_reason !== 'tool_calls' || toolCallBlocks.length === 0) {
      const text = assistantMessage.content
      if (!text) {
        console.error('[chat:huggingface] no text content in response, finish_reason:', choice.finish_reason)
        return { reply: FALLBACK_REPLY, toolCalls }
      }
      return { reply: text, toolCalls }
    }

    for (const call of toolCallBlocks) {
      const start = Date.now()
      let input: unknown = {}
      try {
        input = call.function.arguments ? JSON.parse(call.function.arguments) : {}
      } catch {
        input = {}
      }
      try {
        const result = await executeTool(call.function.name, input, { parkId: req.parkId })
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
        toolCalls.push({ name: call.function.name, label: describeToolCall(call.function.name, input), durationMs: Date.now() - start, ok: true })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        messages.push({ role: 'tool', tool_call_id: call.id, content: message })
        toolCalls.push({ name: call.function.name, label: describeToolCall(call.function.name, input), durationMs: Date.now() - start, ok: false })
      }
    }
  }

  return { reply: TIMEOUT_REPLY, toolCalls }
}
