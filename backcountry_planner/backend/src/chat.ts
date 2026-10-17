import express from 'express'
import { getChatReply, type ChatTurn } from './llm.js'
import { PARKS } from './parks.js'

export const chatRouter = express.Router()

/** Cheap abuse/cost guard — trimmed server-side regardless of what the client sends. */
const MAX_HISTORY_TURNS = 20

function buildSystemPrompt(parkName: string, routeSummary?: string): string {
  const today = new Date().toISOString().slice(0, 10)
  return [
    'You are a helpful trip-planning assistant embedded in a backcountry trip planner app.',
    `Today's date is ${today}. Resolve relative dates ("next weekend", "starting Thursday") to real ISO dates yourself before calling a tool that needs one.`,
    `The user is currently planning a trip in ${parkName}.`,
    routeSummary ? `Their current route: ${routeSummary}` : 'They have not yet planned a route.',
    'Answer questions about trip planning, gear, safety, and logistics conversationally. You have tools for real-time weather, trail closures, live permit availability, known real routes for this park, and checking whether a multi-night plan fits a daily mileage limit — use them rather than guessing whenever a question depends on current or park-specific information.',
    'Call get_known_routes before naming or describing a specific route, rather than inventing one from general knowledge. Only call check_permit_availability for specific real campsite ids you already know (from get_known_routes, find_itinerary_splits, or the user\'s current route) — its results are cached up to 6 hours, so mention roughly how fresh the check is rather than implying it\'s live-live, and remind the user that a spot showing available online can be booked by someone else before they finish reserving it.',
    'You have no way to get precise driving distances or times between trailheads (e.g. for car-shuttle logistics on a point-to-point route) — answer those from general knowledge and say the number is approximate, not authoritative.',
  ].join('\n')
}

function isValidHistory(history: unknown): history is ChatTurn[] {
  return (
    Array.isArray(history) &&
    history.every(
      (turn) =>
        turn &&
        typeof turn === 'object' &&
        (turn.role === 'user' || turn.role === 'assistant') &&
        typeof turn.content === 'string',
    )
  )
}

chatRouter.post('/', async (req, res) => {
  const { parkId, history, message, routeSummary } = req.body ?? {}

  if (typeof parkId !== 'string' || !parkId) {
    res.status(400).json({ error: 'parkId is required' })
    return
  }
  if (typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' })
    return
  }
  if (history !== undefined && !isValidHistory(history)) {
    res.status(400).json({ error: 'history must be an array of {role, content} turns' })
    return
  }
  if (routeSummary !== undefined && typeof routeSummary !== 'string') {
    res.status(400).json({ error: 'routeSummary must be a string' })
    return
  }

  const trimmedHistory: ChatTurn[] = Array.isArray(history) ? history.slice(-MAX_HISTORY_TURNS) : []
  const parkName = PARKS.find((p) => p.id === parkId)?.name ?? parkId

  try {
    const result = await getChatReply({
      system: buildSystemPrompt(parkName, routeSummary),
      history: trimmedHistory,
      message: message.trim(),
      parkId,
    })
    res.json({
      reply: result.reply,
      toolCalls: result.toolCalls.map(({ label, ok, durationMs }) => ({ label, ok, durationMs })),
    })
  } catch (err) {
    console.error('[chat] reply failed:', err)
    res.status(502).json({ error: 'Chat is not available right now, please try again.' })
  }
})
