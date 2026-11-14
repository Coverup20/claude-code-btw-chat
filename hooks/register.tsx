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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'btw-chat',
      description: 'Open a side pane for a continuous /btw conversation',
    })

    return next(e)
  })

  on('command.run', { command: 'btw-chat' }, async $ => {
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

    return (
      <Box flexDirection="column">
        {list.length === 0 && (
          <Text dimColor>
            No side questions yet. Ask below: each answer forks the session
            transcript without touching the main conversation.
          </Text>
        )}
        {list.length > shown.length && (
          <Text dimColor>
            … {list.length - shown.length} earlier exchanges hidden
          </Text>
        )}
        {shown.map(m => (
          <Box flexDirection="column">
            <Text weight="bold">› {m.q}</Text>
            <Text dimColor={m.pending}>{m.pending ? '…' : m.answer}</Text>
          </Box>
        ))}
        <Input
          key="ask"
          placeholder="Ask a side question…"
          submitLabel="ask"
          autoFocus
          value={text}
          onInput={() => {}}
          onSubmit={() => {}}
        />
        <Box flexDirection="row">
          <Button
            key="clear"
            label="Clear"
            onPress={() => {
              void update($, msgs, () => [])
            }}
          />
        </Box>
      </Box>
    )
  })
}
