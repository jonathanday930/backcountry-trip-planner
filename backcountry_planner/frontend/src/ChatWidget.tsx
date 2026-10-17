import { useEffect, useRef, useState } from 'react'
import './chatWidget.css'

interface ToolCallSummary {
  label: string
  ok: boolean
  durationMs: number
}

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  /** Only ever set on assistant turns — which tools (if any) the agent called to produce this
   * reply. Not sent back to the server as part of `history`; the backend only ever sees flattened
   * text, so this is purely local display state. */
  toolCalls?: ToolCallSummary[]
}

/** Rotates through a few reassuring strings while a reply is pending, since a turn that needs a
 * live permit-availability check can take 10-30s and a static "Thinking…" that long reads as
 * stuck. This is NOT real progress — there's no way to know what the agent is actually doing
 * mid-request without streaming, which this app doesn't do — just a cosmetic reassurance that
 * something is still happening. */
const PENDING_MESSAGES = ['Thinking…', 'Checking live conditions…', 'Still working on it…']
const PENDING_MESSAGE_INTERVAL_MS = 4000

export default function ChatWidget({ parkId, routeSummary }: { parkId: string; routeSummary?: string }) {
  const [messages, setMessages] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [pendingMessageIndex, setPendingMessageIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Skip on mount with no messages yet — scrolling into view here would drag the whole
    // (scrollable) sidebar down to reveal the empty chat panel at its bottom.
    if (messages.length === 0 && !sending) return
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  useEffect(() => {
    if (!sending) {
      setPendingMessageIndex(0)
      return
    }
    const interval = setInterval(() => {
      setPendingMessageIndex((i) => Math.min(i + 1, PENDING_MESSAGES.length - 1))
    }, PENDING_MESSAGE_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [sending])

  function sendMessage() {
    const trimmed = input.trim()
    if (!trimmed || sending) return

    const history = messages.map(({ role, content }) => ({ role, content }))
    setMessages((prev) => [...prev, { role: 'user', content: trimmed }])
    setInput('')
    setError(null)
    setSending(true)

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parkId, history, message: trimmed, routeSummary }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? 'Chat request failed')
        }
        return res.json() as Promise<{ reply: string; toolCalls?: ToolCallSummary[] }>
      })
      .then((data) => {
        setMessages((prev) => [...prev, { role: 'assistant', content: data.reply, toolCalls: data.toolCalls }])
      })
      .catch((err) => {
        // Deliberately not appended to `messages` — that array doubles as the history sent back to
        // the server, and this failure text was never actually said by the model.
        setError(err instanceof Error ? err.message : 'Something went wrong, please try again.')
      })
      .finally(() => setSending(false))
  }

  return (
    <div className="chat-panel">
      <div className="chat-panel-header">
        <span>Trip planning chat</span>
      </div>
      <div className="chat-panel-messages">
        {messages.length === 0 && (
          <p className="chat-empty-hint">
            Ask me anything about planning your trip &mdash; gear, logistics, weather, closures, permit
            availability, or route ideas.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-message-group chat-message-group-${m.role}`}>
            {m.toolCalls && m.toolCalls.length > 0 && (
              <div className="chat-tool-calls">
                {m.toolCalls.map((tc, j) => (
                  <span key={j} className={`chat-tool-chip ${tc.ok ? '' : 'chat-tool-chip-error'}`}>
                    {tc.label} ({(tc.durationMs / 1000).toFixed(1)}s)
                  </span>
                ))}
              </div>
            )}
            <div className={`chat-message chat-message-${m.role}`}>{m.content}</div>
          </div>
        ))}
        {sending && (
          <div className="chat-message chat-message-assistant chat-message-pending">
            {PENDING_MESSAGES[pendingMessageIndex]}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      {error && <div className="chat-error">{error}</div>}
      <form
        className="chat-panel-input-row"
        onSubmit={(e) => {
          e.preventDefault()
          sendMessage()
        }}
      >
        <input
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question&hellip;"
          disabled={sending}
        />
        <button type="submit" disabled={sending || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
