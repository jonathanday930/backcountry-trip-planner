import type OpenAI from 'openai'
import { TOOLS } from './index.js'

/** TOOLS in tools/index.ts stays the single source of truth for names/descriptions/schemas —
 * this just reshapes Anthropic's `input_schema` tool format into OpenAI's function-calling shape
 * for providers (e.g. Hugging Face's OpenAI-compatible router) that speak that dialect instead. */
export const OPENAI_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = TOOLS.map((tool) => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema as Record<string, unknown>,
  },
}))
