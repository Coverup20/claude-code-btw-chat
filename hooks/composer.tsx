import type { ClientModule } from 'claude-code'

type Props = {
  value: string
  columns: number
  rows: number
  ackClient: string
  ackRevision: number
  ackSubmit: number
}
type Snapshot = { text: string; caret: number; anchor: number }
type Submission = { sequence: number; text: string }
type State = Snapshot & {
  clientId: string
  revision: number
  submitted: number
  pending: Submission[]
  history: Snapshot[]
  historyIndex: number
  preferredX?: number
  warning?: string
}
type Line = { start: number; end: number; cells: number[] }

const LIMIT = 24000
const SPECIAL = new Set([
  'escape', 'insert', 'capslock', 'shift', 'control', 'alt', 'meta',
  'enter', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
])
const clean = (text: string) => text.replace(/\r\n?/g, '\n')
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\t/g, '  ')

// Cell approximation, not font shaping. Code-point offsets never split a
// surrogate pair. Combining marks and common wide characters keep their width.
function cellWidth(char: string): number {
  const n = char.codePointAt(0)!
  if (/\p{Mark}/u.test(char) || n === 0x200d || n === 0xfe0f) return 0
  return n >= 0x1100 && (n <= 0x115f || n === 0x2329 || n === 0x232a ||
    (n >= 0x2e80 && n <= 0xa4cf) || (n >= 0xac00 && n <= 0xd7a3) ||
    (n >= 0xf900 && n <= 0xfaff) || (n >= 0xfe10 && n <= 0xfe6f) ||
    (n >= 0xff01 && n <= 0xff60) || (n >= 0xffe0 && n <= 0xffe6) ||
    n >= 0x1f000) ? 2 : 1
}

function layout(chars: string[], width: number): Line[] {
  const lines: Line[] = []
  let start = 0, cells = [0]
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!
    if (char === '\n') {
      lines.push({ start, end: i, cells })
      start = i + 1
      cells = [0]
      continue
    }
    const size = cellWidth(char)
    if (cells[cells.length - 1]! + size > width && i > start) {
      lines.push({ start, end: i, cells })
      start = i
      cells = [0]
    }
    cells.push(cells[cells.length - 1]! + size)
  }
  lines.push({ start, end: chars.length, cells })
  return lines
}

function position(caret: number, lines: Line[]) {
  let row = lines.length - 1
  for (let i = 0; i < lines.length; i++) {
    if (caret <= lines[i]!.end && lines[i + 1]?.start !== caret) {
      row = i
      break
    }
  }
  return { row, col: lines[row]!.cells[caret - lines[row]!.start] ?? 0 }
}
function offset(line: Line, col: number): number {
  let index = 0
  while (index + 1 < line.cells.length && line.cells[index + 1]! <= col) index++
  return line.start + index
}
function view(st: State, width: number, height: number) {
  const chars = Array.from(st.text), lines = layout(chars, width)
  const pos = position(st.caret, lines)
  const first = Math.max(0, Math.min(pos.row - Math.floor(height / 2), lines.length - height))
  return { chars, lines, pos, first }
}

const Composer: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (!state) {
    const text = clean(props.value), caret = Array.from(text).length
    state = {
      text, caret, anchor: caret, clientId: `${Date.now()}-${Math.random()}`,
      revision: 0, submitted: 0, pending: [],
      history: [{ text, caret, anchor: caret }], historyIndex: 0,
    }
    surface.setState(state)
  }
  // Parent redraws acknowledge delivery, but never replace newer local typing.
  if (props.ackClient === state.clientId && state.pending.some(p => p.sequence <= props.ackSubmit)) {
    state = { ...state, pending: state.pending.filter(p => p.sequence > props.ackSubmit) }
    surface.setState(state)
  }
  const width = Math.max(2, (surface.columns || props.columns) - 1)
  const height = Math.max(1, surface.rows || props.rows)
  const warn = (st: State, warning: string) => surface.setState({ ...st, warning })

  function publish(st: State, candidate: State, remember: boolean) {
    if (candidate.text.length > LIMIT || candidate.pending.some(p => p.text.length > LIMIT)) {
      warn(st, 'Draft limit reached (24,000 characters)')
      return
    }
    // A post is latest-wins per frame. Carry all unacknowledged submissions in
    // EVERY snapshot, so typing immediately after Enter cannot erase a send.
    const data = { clientId: st.clientId, revision: st.revision + 1,
      draft: candidate.text, submissions: candidate.pending }
    if (candidate.pending.length > 100 || JSON.stringify(data).length > 95000) {
      warn(st, 'Send pending; try again')
      return
    }
    let history = candidate.history, historyIndex = candidate.historyIndex
    if (remember) {
      history = st.history.slice(0, st.historyIndex + 1)
      history.push({ text: candidate.text, caret: candidate.caret, anchor: candidate.anchor })
      history = history.slice(-100)
      historyIndex = history.length - 1
    }
    surface.setState({ ...candidate, revision: data.revision, history, historyIndex,
      warning: undefined, preferredX: undefined })
    surface.post(data)
  }

  surface.onKey(event => {
    const st = surface.state!
    const modified = event.ctrl || event.meta, key = event.key
    const { chars, lines, pos } = view(st, width, height)
    const low = Math.min(st.caret, st.anchor), high = Math.max(st.caret, st.anchor)
    const move = (caret: number, preferredX?: number) => surface.setState({ ...st,
      caret, anchor: event.shift ? st.anchor : caret, preferredX })
    const replace = (text: string, from = low, to = high) => {
      const inserted = Array.from(text), caret = from + inserted.length
      publish(st, { ...st, text: [...chars.slice(0, from), ...inserted, ...chars.slice(to)].join(''),
        caret, anchor: caret }, true)
    }
    if (key === 'return') {
      if (modified) return
      if (event.shift) { replace('\n'); return }
      const question = st.text.trim(), sequence = st.submitted + 1
      publish(st, { ...st, text: '', caret: 0, anchor: 0,
        submitted: question ? sequence : st.submitted,
        pending: question ? [...st.pending, { sequence, text: question }] : st.pending }, true)
      return
    }
    if (modified && key.toLowerCase() === 'a') {
      surface.setState({ ...st, anchor: 0, caret: chars.length }); return
    }
    if (modified && (key.toLowerCase() === 'z' || key.toLowerCase() === 'y')) {
      const redo = key.toLowerCase() === 'y' || event.shift
      const index = st.historyIndex + (redo ? 1 : -1), snapshot = st.history[index]
      if (snapshot) publish(st, { ...st, ...snapshot, historyIndex: index }, false)
      return
    }
    if (key === 'left' || key === 'right') {
      const direction = key === 'left' ? -1 : 1
      let target = st.caret
      if (!event.shift && low !== high && !modified) target = direction < 0 ? low : high
      else if (modified) {
        const wordChar = (i: number) => chars[i] !== undefined && !/\s/u.test(chars[i]!)
        if (direction < 0) {
          while (target > 0 && !wordChar(target - 1)) target--
          while (target > 0 && wordChar(target - 1)) target--
        } else {
          while (target < chars.length && wordChar(target)) target++
          while (target < chars.length && !wordChar(target)) target++
        }
      } else target = Math.max(0, Math.min(chars.length, target + direction))
      move(target); return
    }
    if (key === 'home' || key === 'end') {
      move(key === 'home' ? (modified ? 0 : lines[pos.row]!.start)
        : (modified ? chars.length : lines[pos.row]!.end)); return
    }
    if (key === 'up' || key === 'down' || key === 'pageup' || key === 'pagedown') {
      const delta = (key === 'up' || key === 'pageup' ? -1 : 1) * (key.startsWith('page') ? height : 1)
      const row = Math.max(0, Math.min(lines.length - 1, pos.row + delta))
      const col = st.preferredX ?? pos.col
      move(offset(lines[row]!, col), col); return
    }
    if (modified) return // No clipboard/IME API is exposed by ClientSurface.
    if (key === 'backspace' || key === 'delete') {
      replace('', low !== high ? low : Math.max(0, low - (key === 'backspace' ? 1 : 0)),
        low !== high ? high : Math.min(chars.length, high + (key === 'delete' ? 1 : 0)))
      return
    }
    if (key === 'tab') { replace('  '); return }
    if (SPECIAL.has(key.toLowerCase())) return
    const text = clean(key)
    if (text) replace(text)
  })

  surface.onPointer(event => {
    if (event.button !== 'left' || (event.type !== 'down' && event.type !== 'move')) return
    const st = surface.state!
    const { lines, first } = view(st, width, Math.max(1, height - (st.warning ? 1 : 0)))
    const row = Math.max(0, Math.min(lines.length - 1, first + event.y))
    const caret = offset(lines[row]!, Math.max(0, event.x))
    surface.setState({ ...st, caret, preferredX: undefined,
      anchor: event.type === 'move' || event.shift ? st.anchor : caret })
  })

  const visibleHeight = Math.max(1, height - (state.warning ? 1 : 0))
  const { chars, lines, pos, first } = view(state, width, visibleHeight)
  const low = Math.min(state.caret, state.anchor), high = Math.max(state.caret, state.anchor)
  return (
    <Box flexDirection="column" height={height} backgroundColor="#000000">
      {state.warning && height === 1 ? (
        <Text color="error" wrap="truncate-end">{state.warning}</Text>
      ) : state.text === '' ? (
        <Text mono wrap="truncate-end" dimColor><Text inverse> </Text>Click to write a side question…</Text>
      ) : lines.slice(first, first + visibleHeight).map((line, row) => {
        const segments: { text: string; inverse: boolean }[] = []
        for (let i = line.start; i <= line.end; i++) {
          const caret = low === high && i === state.caret && first + row === pos.row
          const selected = i >= low && i < high
          const text = i < line.end ? chars[i]! : (caret || line.start === line.end ? ' ' : '')
          if (!text) continue
          const inverse = caret || selected, last = segments[segments.length - 1]
          if (last && last.inverse === inverse) last.text += text
          else segments.push({ text, inverse })
        }
        return <Text mono wrap="wrap">{segments.map(s => <Text inverse={s.inverse}>{s.text}</Text>)}</Text>
      })}
      {state.warning && height > 1 && <Text color="error" wrap="truncate-end">{state.warning}</Text>}
    </Box>
  )
}

export default Composer
