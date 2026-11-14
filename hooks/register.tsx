import { atom, read, update } from 'claude-code'
import type {
  ClientProps,
  EngineInterface,
  ModelForkResult,
  Register,
  RenderElement,
} from 'claude-code'

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
// Whether the ring sits on the composer field: unfocused, the pane draws the
// draft itself, since the surface's field loses its text on blur.
const focused = atom({ plugin: 'btw-chat', key: 'focused' } as const, false, {
  shape: 'focused-1',
})
const composerAck = atom(
  { plugin: 'btw-chat', key: 'composerAck' } as const,
  { clientId: '', revision: 0, submitted: 0 },
  {
    shape: 'composer-1',
  },
)

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

async function askQuestion($: EngineInterface, question: string) {
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
    // A space, not an empty string: the desktop surface gives an empty Text no
    // row, which would leave the tree shorter than bodyRows.
    rows.push({ text: ' ', kind: 'answer', pending: false })
    if (m.pending) {
      rows.push({ text: `${frame} Thinking…`, kind: 'pending', pending: true })
    } else {
      const answer = wrap(m.answer ?? '', width)
      answer.forEach((line, i) => {
        rows.push({
          text: i === 0 ? `● ${line}` : line,
          kind: 'answer',
          pending: false,
        })
      })
    }
    rows.push({ text: ' ', kind: 'answer', pending: false })
  }
  return rows
}

type ValidatedSubmission = { sequence: number; text: string }
type ValidatedComposerData = {
  clientId: string
  revision: number
  draft: string
  submissions: ValidatedSubmission[]
}

function parseComposerData(raw: unknown): ValidatedComposerData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>

  const clientId = obj.clientId
  if (typeof clientId !== 'string' || clientId === '' || clientId.length > 128) return null

  const revision = obj.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0) return null

  const draft = obj.draft
  if (typeof draft !== 'string' || draft.length > 24000) return null

  const subs = obj.submissions
  if (!Array.isArray(subs) || subs.length > 100) return null

  const submissions: ValidatedSubmission[] = []
  let prevSeq = 0
  for (const s of subs) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null
    const subObj = s as Record<string, unknown>

    const seq = subObj.sequence
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) return null
    if (seq <= prevSeq) return null
    prevSeq = seq

    const text = subObj.text
    if (typeof text !== 'string' || text.length > 24000 || text.trim() === '') return null

    submissions.push({ sequence: seq, text })
  }

  return { clientId, revision, draft, submissions }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'btw-chat',
      description: 'Open a side pane for a continuous /btw conversation',
    })

    return next(e)
  })

  // Accept 'btw-chat', 'btw-chat:btw-chat' and '/btw-chat': the matcher form
  // `{ command: 'btw-chat' }` has been observed to miss the handler on some
  // builds, and plugin commands may arrive namespaced.
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
    await askQuestion($, question)

    return { element: e.element, value: '' }
  })

  on('ui.message', { component: 'Pane', requestId: PANE, element: 'composer' }, async ($, e) => {
    const data = parseComposerData(e.data)
    if (!data) return {}

    let accepted = false
    let questions: ValidatedSubmission[] = []

    await update($, composerAck, current => {
      accepted = false
      questions = []
      const sameId = data.clientId === current.clientId
      if (sameId && data.revision <= current.revision) {
        return current
      }
      accepted = true
      const previousSubmitted = sameId ? current.submitted : 0
      questions = data.submissions.filter(s => s.sequence > previousSubmitted)
      const lastSeq = data.submissions.length > 0 ? data.submissions[data.submissions.length - 1]!.sequence : 0
      return {
        clientId: data.clientId,
        revision: data.revision,
        submitted: Math.max(previousSubmitted, lastSeq),
      }
    })

    if (!accepted) return {}

    await update($, draft, () => data.draft)
    for (const sub of questions) {
      await askQuestion($, sub.text.trim())
    }

    return {}
  })

  on('ui.focus', async ($, e, next) => {
    const onField = e.requestId === PANE && e.element === 'ask'
    await update($, focused, () => onField)
    return next(e)
  })

  // The person's wheel and keys over the pane: move our own window instead of
  // the engine's, which stays pinned so the frame holds still.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (e.by === 0) return next(e)
    await update($, scrollBack, n => Math.max(0, n - e.by))
    return next({ ...e, offset: 0 })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const resolved = $.ui.resolve(e)
    const { Box, Text, Button } = resolved
    // A surface that offers Client gets the wrapping editor; the rest keep the
    // native field. Decided by the element table, not the surface's name.
    const canClient = 'Client' in (resolved as object) && e.surface !== 'terminal'
    const list = await read($, msgs)
    const text = await read($, draft)
    const back = await read($, scrollBack)
    const ack = await read($, composerAck)

    // Frame border and padding take six columns; keep a sane floor.
    const width = Math.max(12, e.props.bodyColumns - 6)
    const composerColumns = Math.max(4, e.props.bodyColumns - 10)

    const effWidth = Math.max(1, composerColumns - 1)
    let estimatedRows = 0
    for (const para of text.split('\n')) {
      const len = [...para].length
      estimatedRows += Math.max(1, Math.floor(len / effWidth) + 1)
    }

    const bodyRows = e.props.scroll.bodyRows
    const isFocused = await read($, focused)
    // Unfocused, the terminal's field forgets its text, so the pane draws the
    // draft itself: the field keeps one row (a click target) and the wrapped
    // draft sits under it. Focused, the field is the only view.
    const draftLines = text === '' ? [] : wrap(text, width)
    const unfocusedRows = text === '' ? 0 : Math.min(7, draftLines.length)
    // Where Client exists the editor wraps by itself; on the terminal the
    // field never wraps, so it starts at three rows and grows with the
    // newlines the person types (Shift+Enter).
    const inputRows = canClient
      ? Math.min(Math.max(1, Math.floor((bodyRows - 8) / 2)), Math.max(2, estimatedRows))
      : isFocused
        ? Math.min(6, Math.max(1, text.split('\n').length))
        : 1 + unfocusedRows

    const overhead = inputRows + 8
    const room = Math.max(1, bodyRows - overhead)

    const frame = THINKING_FRAMES[(await read($, tick)) % THINKING_FRAMES.length] ?? '✻'
    const rows = buildRows(list, width, frame)
    const maxStart = Math.max(0, rows.length - room)
    const start = Math.max(0, maxStart - back)
    const windowRows = rows.slice(start, start + room)

    let composer: RenderElement
    if (canClient) {
      const Client = (
        resolved as unknown as {
          Client: (props: ClientProps) => RenderElement
        }
      ).Client
      composer = (
        <Client
          key="composer"
          module="./composer.tsx"
          width="100%"
          height={inputRows}
          props={{
            value: text,
            columns: composerColumns,
            rows: inputRows,
            ackClient: ack.clientId,
            ackRevision: ack.revision,
            ackSubmit: ack.submitted,
          }}
        />
      )
    } else {
      const { Input } = resolved
      composer = (
        <Box flexDirection="column">
          <Input
            key="ask"
            placeholder="Ask a side question…"
            submitLabel=""
            autoFocus
            rows={isFocused ? inputRows : 1}
            value={text}
            onInput={() => {}}
            onSubmit={() => {}}
          />
          {!isFocused && draftLines.length > 0 && (
            <Box flexDirection="column">
              {draftLines.slice(0, 7).map(line => (
                <Text dimColor>{line}</Text>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box
        flexDirection="column"
        height={bodyRows}
        backgroundColor="#000000"
      >
        {/* No padding on this Box: the overlay's offsets measure from its
            content box, and a padded root pulled the frame inside the edge. */}
        <Box
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          borderStyle="round"
          borderColor="#FFA500"
        />
        <Box
          flexDirection="column"
          flexGrow={1}
          paddingX={2}
          paddingY={1}
        >
        {/* The history keeps a fixed height too: `room` rows whatever the text. */}
        <Box flexDirection="column" height={room}>
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
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor="promptBorder"
          paddingX={1}
          flexDirection="column"
        >
          {composer}
        </Box>
        <Box
          marginTop={1}
          marginBottom={1}
          paddingLeft={2}
          paddingRight={2}
          flexDirection="row"
          justifyContent="space-between"
        >
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
      </Box>
    )
  })
}

// Accept 'btw-chat', 'btw-chat:btw-chat' and '/btw-chat': the matcher form
// `{ command: 'btw-chat' }` has been observed to miss the handler on some
// builds, and plugin commands may arrive namespaced.
function commandName(value: unknown): string {
  const raw = String(value ?? '').trim().replace(/^\//, '')
  const last = raw.includes(':') ? raw.split(':').pop() || raw : raw
  return last.replace(/^\//, '')
}
