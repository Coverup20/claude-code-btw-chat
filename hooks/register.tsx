import { atom, read, update } from 'claude-code'
import type { ModelForkResult, Register } from 'claude-code'

import type { BtwMessage } from '../types'

const PANE = 'btw-chat'

// How many past side exchanges each fork carries, so the conversation stays
// continuous without unbounded prompt growth.
const MAX_EXCHANGES_IN_PROMPT = 12
// How many exchanges the pane draws, most recent last.
const MAX_EXCHANGES_DRAWN = 8
// How many exchanges the session keeps at all.
const MAX_EXCHANGES_KEPT = 50
// How many rows the ask field grows to before it scrolls instead. The native
// prompt wraps a long line onto more rows; this one follows it, up to a cap so
// the answers keep their room.
const MAX_INPUT_ROWS = 6
// The submit hint the engine draws beside a focused multi-row field, and the
// short one it falls back to when the long form would take more than half the
// field. Either steals room from the text, so the wrap width counts it.
const HINT_LONG_COLUMNS = 27 // " ⏎ send · shift+⏎ new line"
const HINT_SHORT_COLUMNS = 7 // " ⏎ send"

const msgs = atom({ plugin: 'btw-chat', key: 'msgs' } as const, [], {
  shape: 'msgs-1',
})
const draft = atom({ plugin: 'btw-chat', key: 'draft' } as const, '', {
  shape: 'draft-1',
})

// Unique per session; the timestamp keeps it so across reloads.
let seq = 0
const nextId = () => `${Date.now()}-${seq++}`

const SIDE_PREAMBLE = [
  'This is a side conversation ("by the way") about the session above.',
  'It never touches the main thread: answer directly and briefly, using what',
  'the transcript already shows. Earlier side exchanges, oldest first:',
].join('\n')

function buildPrompt(prior: readonly BtwMessage[], question: string): string {
  const kept = prior
    .filter(m => m.answer !== undefined)
    .slice(-MAX_EXCHANGES_IN_PROMPT)
  const history = kept.map(m => `Q: ${m.q}\nA: ${m.answer}`).join('\n\n')
  const soFar = history || '(none yet)'
  return `${SIDE_PREAMBLE}\n\n${soFar}\n\nCurrent question:\n${question}`
}

function describeFailure(r: ModelForkResult): string {
  if (r.isAnswered) return ''
  switch (r.reason) {
    case 'nothing-to-fork':
      return 'Nothing to fork yet — let the main conversation run one turn first.'
    case 'api-error':
      return `API error${'status' in r ? ` (HTTP ${r.status})` : ''}.`
    case 'empty-reply':
      return 'The model replied with no text.'
    case 'aborted':
      return 'Aborted — the turn was interrupted.'
  }
}

// The field's height for what it holds, as the native prompt box sizes itself:
// one row for a short question, one more for each row the text wraps onto.
//
// The engine draws the field across the whole pane body, keeping the submit
// hint beside it and wrapping the text one cell narrower than the room that
// leaves. It knows nothing of a border drawn around the field: one would take
// cells the engine still counts as text, and every wrapped row would come out
// cut with an ellipsis. So the field is drawn bare and its wrap width is
// counted here, from the same numbers the engine uses.
function rowsFor(text: string, bodyColumns: number): number {
  const hint =
    bodyColumns - HINT_LONG_COLUMNS >= bodyColumns / 2
      ? HINT_LONG_COLUMNS
      : HINT_SHORT_COLUMNS
  const width = Math.max(8, bodyColumns - hint - 1)
  const rows = text
    .split('\n')
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / width)), 0)
  return Math.min(MAX_INPUT_ROWS, Math.max(1, rows))
}

// Accept 'btw-chat', 'btw-chat:btw-chat' and '/btw-chat': the matcher form
// `{ command: 'btw-chat' }` has been observed to miss the handler on some
// builds, and plugin commands may arrive namespaced.
function commandName(value: unknown): string {
  const raw = String(value ?? '').trim().replace(/^\//, '')
  const last = raw.includes(':') ? raw.split(':').pop() || raw : raw
  return last.replace(/^\//, '')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'btw-chat',
      description: 'Open a side pane for a continuous /btw conversation',
    })

    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (commandName(e.command) !== 'btw-chat') return next(e)

    const opened = await $.ui.open({
      id: PANE,
      title: 'By the way',
      focus: true,
      closeOnEscape: true,
    })

    return {
      text: opened.isPlaced
        ? 'Side conversation pane opened.'
        : `Pane not placed: ${opened.reason}`,
    }
  })

  // This hook answers for itself and never calls next: every update below
  // redraws the pane, which invalidates the element's handler handle, so
  // next(e) after an await would throw. onInput/onSubmit are no-ops anyway.
  on('ui.input', { element: 'ask' }, async ($, e) => {
    if (e.kind === 'change') {
      // Keep the in-progress text so a redraw while a fork runs never wipes it.
      await update($, draft, () => e.value)
      return { element: e.element, value: e.value }
    }

    const question = e.value.trim()
    await update($, draft, () => '')
    if (!question) return { element: e.element, value: '' }

    const id = nextId()
    await update($, msgs, list =>
      [...list, { id, q: question, pending: true }].slice(-MAX_EXCHANGES_KEPT),
    )

    const prior = (await read($, msgs)).filter(m => m.id !== id)
    const r = await $.model.fork({ prompt: buildPrompt(prior, question) })
    const answer = r.isAnswered ? r.text : describeFailure(r)
    await update($, msgs, list =>
      list.map(m => (m.id === id ? { ...m, answer, pending: false } : m)),
    )

    return { element: e.element, value: '' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input, Button } = $.ui.resolve(e)
    const list = await read($, msgs)
    const text = await read($, draft)
    const shown = list.slice(-MAX_EXCHANGES_DRAWN)
    const columns = e.props.bodyColumns
    const rule = '─'.repeat(Math.max(8, columns))

    return (
      <Box flexDirection="column">
        {list.length === 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text color="claude" weight="bold">
              Side conversation
            </Text>
            <Text dimColor>
              Ask below: each answer forks the session transcript without
              touching the main conversation.
            </Text>
          </Box>
        )}
        {list.length > shown.length && (
          <Text dimColor>
            … {list.length - shown.length} earlier exchanges hidden
          </Text>
        )}
        {shown.map(m => (
          <Box flexDirection="column" marginBottom={1}>
            <Box flexDirection="row">
              <Text color="claude" weight="bold">
                ›{' '}
              </Text>
              <Text weight="bold">{m.q}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text dimColor={m.pending}>
                {m.pending ? 'thinking…' : m.answer}
              </Text>
            </Box>
          </Box>
        ))}
        <Box marginTop={1} flexDirection="column">
          {/* Rules, not a border: a Box border narrows the field without the
              engine knowing, and every wrapped row then comes out cut with an
              ellipsis. */}
          <Text dimColor>{rule}</Text>
          <Input
            key="ask"
            placeholder="Ask a side question…"
            submitLabel="send"
            autoFocus
            value={text}
            rows={rowsFor(text, columns)}
            onInput={() => {}}
            onSubmit={() => {}}
          />
          <Text dimColor>{rule}</Text>
        </Box>
        <Box marginTop={1} flexDirection="row" justifyContent="space-between">
          <Text dimColor>enter to send · esc to close</Text>
          <Button
            key="clear"
            onPress={() => {
              void update($, msgs, () => [])
            }}
          >
            <Text dimColor>Clear</Text>
          </Button>
        </Box>
      </Box>
    )
  })
}
