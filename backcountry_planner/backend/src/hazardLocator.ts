import OpenAI from 'openai'

// A separate, deliberately cheap/small model from the main chat widget's HF_MODEL — this is a
// single-shot "does this alert text name one of these places?" classification, not a conversation,
// so it doesn't need a large model. Runs only when the hazards cache refreshes (see hazards.ts),
// not per page view, so cost stays low regardless of traffic. Uses the same HF_TOKEN as the chat
// widget's Hugging Face path; if that's unset, location-matching is simply skipped (see hazards.ts)
// rather than failing the whole hazards fetch.
const MODEL = process.env.HAZARD_LOCATOR_MODEL ?? 'meta-llama/Llama-3.1-8B-Instruct:novita'

let client: OpenAI | undefined
function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ baseURL: 'https://router.huggingface.co/v1', apiKey: process.env.HF_TOKEN || 'unset' })
  }
  return client
}

export interface LocationCandidate {
  id: string
  name: string
}

/** Reads an NPS alert's title/description and, only when it confidently names one of the park's
 * known places, returns that place's id — otherwise null. Deliberately conservative: a wrong pin
 * on a safety-relevant hazard is worse than no pin, so the prompt asks for `null` whenever the
 * text doesn't clearly single out one place (e.g. park-wide fire danger, general bear-activity
 * season notices). Never throws on a bad/unparseable model response — treated the same as "no
 * match" so one flaky call can't break the whole hazards fetch. */
export async function locateAlert(alert: { title: string; description: string }, candidates: LocationCandidate[]): Promise<string | null> {
  if (!process.env.HF_TOKEN || candidates.length === 0) return null

  const candidateList = candidates.map((c) => `${c.id}: ${c.name}`).join('\n')
  const prompt = `A national park alert may or may not be about one specific named place. Given the alert text and a list of known places (id: name), reply with ONLY the id of the place the alert is clearly about, or the word "none" if the alert is park-wide, about multiple/unclear places, or doesn't name any of these places specifically.

Alert title: ${alert.title}
Alert description: ${alert.description}

Known places:
${candidateList}

Reply with only an id from the list above, or "none". No other text.`

  try {
    const response = await callModel(prompt)
    const answer = response?.trim().toLowerCase()
    if (!answer || answer === 'none') return null
    const match = candidates.find((c) => c.id.toLowerCase() === answer)
    return match ? match.id : null
  } catch (err) {
    console.warn('[hazardLocator] match call failed, treating as no match:', err instanceof Error ? err.message : err)
    return null
  }
}

async function callModel(prompt: string): Promise<string | undefined> {
  const response = await getClient().chat.completions.create(
    { model: MODEL, max_tokens: 20, messages: [{ role: 'user', content: prompt }] },
    { signal: AbortSignal.timeout(15000) },
  )
  return response.choices[0]?.message?.content ?? undefined
}
