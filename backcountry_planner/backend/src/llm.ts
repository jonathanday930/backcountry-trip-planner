import { getChatReply as getAnthropicChatReply } from './llmProviders/anthropic.js'
import { getChatReply as getHuggingFaceChatReply } from './llmProviders/huggingface.js'
import type { ChatCompletionRequest, ChatCompletionResult } from './llmProviders/types.js'

export type { ChatTurn, ChatCompletionRequest, ToolCallSummary, ChatCompletionResult } from './llmProviders/types.js'

// The only file that knows which provider is live. Swapping models within a provider is an env
// var change (CHAT_MODEL / HF_MODEL); swapping providers is LLM_PROVIDER (default 'anthropic', so
// this is a no-op change until someone opts in) — chat.ts and the frontend contract never change
// either way, since every provider module implements the same ChatCompletionRequest ->
// ChatCompletionResult signature.
const PROVIDER = process.env.LLM_PROVIDER ?? 'anthropic'

export async function getChatReply(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
  switch (PROVIDER) {
    case 'huggingface':
      return getHuggingFaceChatReply(req)
    case 'anthropic':
    default:
      return getAnthropicChatReply(req)
  }
}
