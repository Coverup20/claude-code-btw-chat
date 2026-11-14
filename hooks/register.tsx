import { atom, read, update } from 'claude-code'
import type { ModelForkResult, Register } from 'claude-code'

import type { BtwMessage } from '../types'

const PANE = 'btw-chat'

// How many past side exchanges each fork carries, so the conversation stays
// continuous without unbounded prompt growth.
const MAX_EXCHANGES_IN_PROMPT = 12
// How many exchanges the session keeps at all.
const MAX_EXCHANGES_KEPT = 50

const msgs = atom({ plugin: 'btw-chat', key: 'msgs' } as const, [], {
  shape: 'msgs-1',
})
const draft = atom({ plugin: 'btw-chat', key: 'draft' } as const, '', {
  shape: 'draft-1',
})
// Rows scrolled back from the tail; the pane draws its own window over the
// exchange rows so the frame never scrolls away with the content.
const scrollBack = atom({ plugin: 'btw-chat', key: 'scrollBack' } as const, 0, {
  shape: 'scroll-1',
})
// Repaints the thinking spinner while a fork runs.
const tick = atom({ plugin: 'btw-chat', key: 'tick' } as const, 0, {
  shape: 'tick-1',
})

const THINKING_FRAMES = ['✢', '✳', '✶', '✻', '✽'] as const
let ticker: { cancel: () => void } | null = null

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

type Row = {
  text: string
  kind: 'question' | 'answer' | 'info' | 'pending'
  pending: boolean
}

// Greedy word wrap; a word longer than the line is cut. One string in, the
// lines it takes out.
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (para === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const word of para.split(' ')) {
      if (line === '') line = word
      else if (line.length + 1 + word.length <= width) line += ' ' + word
      else {
        out.push(line)
        line = word
      }
      while (line.length > width) {
        out.push(line.slice(0, width))
        line = line.slice(width)
      }
    }
    out.push(line)
  }
  return out
}

function buildRows(
  list: readonly BtwMessage[],
  width: number,
  frame: string,
): Row[] {
  if (list.length === 0) {
    return wrap(
      'Ask below: each answer forks the session transcript without touching the main conversation.',
      width,
    ).map(text => ({ text, kind: 'info' as const, pending: false }))
  }
  const rows: Row[] = []
  for (const m of list) {
    // The main thread's own marks: a chevron on what the person said, a bullet
    // on what came back, a spinner while it thinks.
    for (const text of wrap(`❯ ${m.q}`, width)) {
      rows.push({ text, kind: 'question', pending: false })
    }
    for (const text of m.pending
      ? [`${frame} Thinking…`]
      : wrap(m.answer ?? '', width).map((line, i) =>
          i === 0 ? `● ${line}` : line,
        )) {
      rows.push({ text, kind: m.pending ? 'pending' : 'answer', pending: m.pending })
    }
    // A space, not an empty string: the desktop surface gives an empty Text no
    // row, which would leave the tree shorter than bodyRows.
    rows.push({ text: ' ', kind: 'answer', pending: false })
  }
  return rows
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

    await update($, scrollBack, () => 0)
    const opened = await $.ui.open({
      id: PANE,
      title: 'By the way',
      focus: true,
      closeOnEscape: true,
      backgroundColor: '#000000',
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
    await update($, scrollBack, () => 0)
    await update($, msgs, list =>
      [...list, { id, q: question, pending: true }].slice(-MAX_EXCHANGES_KEPT),
    )

    const prior = (await read($, msgs)).filter(m => m.id !== id)
    ticker?.cancel()
    try {
      ticker = $.clock.every(140, () => {
        void update($, tick, n => n + 1)
      })
    } catch {
      // No clock in this host (a test harness, say): the spinner stays still.
      ticker = null
    }
    const r = await $.model.fork({ prompt: buildPrompt(prior, question) })
    ticker?.cancel()
    ticker = null
    const answer = r.isAnswered ? r.text : describeFailure(r)
    await update($, msgs, list =>
      list.map(m => (m.id === id ? { ...m, answer, pending: false } : m)),
    )

    return { element: e.element, value: '' }
  })

  // The person's wheel and keys over the pane: move our own window instead of
  // the engine's, which stays pinned so the frame holds still.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (e.by === 0) return next(e)
    await update($, scrollBack, n => Math.max(0, n - e.by))
    return next({ ...e, offset: 0 })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input, Button } = $.ui.resolve(e)
    const list = await read($, msgs)
    const text = await read($, draft)
    const back = await read($, scrollBack)
    const columns = e.props.bodyColumns

    // The field is one row and keeps the engine's hint down to the bare ⏎: a
    // multi-row field makes the engine draw "send · shift+⏎ new line" and hold
    // some twenty-five columns of every row for it. A longer question is shown
    // above the field, wrapped here at the width we choose.
    const previewWidth = Math.max(12, columns - 3)
    const previewLines = text === '' ? [] : wrap(text, previewWidth)
    const preview = previewLines.length > 1 ? previewLines : []

    // The exchanges take whatever the field, its frame, the preview and the
    // footer leave.
    const width = Math.max(12, columns - 2)
    const flat = '─'.repeat(Math.max(8, columns - 2))
    const top = `╭${flat}╮`
    const bottom = `╰${flat}╯`
    const capacity = Math.max(
      1,
      e.props.scroll.bodyRows -
        (preview.length === 0 ? 8 : preview.length + 9),
    )

    const frame = THINKING_FRAMES[(await read($, tick)) % THINKING_FRAMES.length] ?? '✻'
    const rows = buildRows(list, width, frame)
    const start = Math.max(0, Math.max(0, rows.length - capacity) - back)
    const windowRows = rows.slice(start, start + capacity)

    return (
      <Box
        flexDirection="column"
        height={e.props.scroll.bodyRows}
        backgroundColor="#000000"
      >
        <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
          {windowRows.map(row => (
            <Text
              color={row.kind === 'question' ? 'claude' : undefined}
              weight={row.kind === 'question' ? 'bold' : undefined}
              dimColor={
                row.kind === 'info' ||
                row.kind === 'pending' ||
                row.pending
              }
            >
              {row.text}
            </Text>
          ))}
        </Box>
        {/* A question longer than the field is shown whole, wrapped, just above
            it. The engine's own prefixed hint is kept down to the bare ⏎ by the
            one-row field. */}
        {preview.length > 0 && (
          <Box flexDirection="column" paddingX={2} marginBottom={1}>
            {preview.map(line => (
              <Text dimColor>{line}</Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column">
          <Text color="promptBorder">{top}</Text>
          {/* The frame spans the pane; only the text inside it is indented, so
              the cursor starts clear of the left border. */}
          <Box paddingLeft={2}>
            <Input
              key="ask"
              placeholder="Ask a side question…"
              submitLabel=""
              autoFocus
              value={text}
              rows={1}
              onInput={() => {}}
              onSubmit={() => {}}
            />
          </Box>
          <Text color="promptBorder">{bottom}</Text>
        </Box>
        <Box
          marginTop={1}
          marginBottom={1}
          paddingX={1}
          flexDirection="row"
          justifyContent="space-between"
        >
          <Text dimColor>enter to send · esc to close</Text>
          <Button
            key="clear"
            onPress={() => {
              void update($, msgs, () => [])
              void update($, scrollBack, () => 0)
            }}
          >
            <Text dimColor>Clear</Text>
          </Button>
        </Box>
      </Box>
    )
  })
}
