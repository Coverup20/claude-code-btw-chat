import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'btw-chat',
  component: 'Pane',
  requestId: 'btw-chat',
  props: {
    title: 'By the way',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

test('each question forks the transcript with the earlier side exchanges', async ($, on) => {
  const prompts: string[] = []
  on('model.fork', (_, e) => {
    prompts.push(e.prompt)
    return {
      value: { isAnswered: true, text: `answer ${prompts.length}`, usage: USAGE },
    }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'ask', text: 'first question' })
  await ui.input({ key: 'ask', text: 'second question' })

  expect(prompts.length).toBe(2)
  expect(prompts[0]!.includes('first question')).toBe(true)
  expect(prompts[1]!.includes('second question')).toBe(true)
  // Continuity: the second fork carries the first exchange.
  expect(prompts[1]!.includes('first question')).toBe(true)
  expect(prompts[1]!.includes('answer 1')).toBe(true)

  expect((await ui.find({ type: 'Text', text: /answer 2/ }))?.text).toBe(
    '● answer 2',
  )
  await ui.unmount()
})

test('a failed fork is reported in the pane', async ($, on) => {
  on('model.fork', () => ({
    value: { isAnswered: false, reason: 'nothing-to-fork' },
  }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'ask', text: 'anything' })

  expect(await ui.find({ type: 'Text', text: /Nothing to fork/ })).toBeDefined()
  await ui.unmount()
})

test('the pane draws on the desktop surface and uses Client composer with zero Input', async ($, on) => {
  on('model.fork', () => ({
    value: { isAnswered: true, text: 'desktop answer', usage: USAGE },
  }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await ui.key({ key: 'desktop question', in: 'composer' })
  await ui.key({ key: 'return', in: 'composer' })

  expect((await ui.find({ type: 'Text', text: /desktop answer/ }))?.text).toBe(
    '● desktop answer',
  )
  await ui.unmount()
})

test('desktop composer long line wrapping and row inspection', async ($, on) => {
  on('model.fork', () => ({
    value: { isAnswered: true, text: 'answer', usage: USAGE },
  }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const longText = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ENDMARKER'
  await ui.key({ key: longText, in: 'composer' })
  await ui.resize({ columns: 24, rows: 12, in: 'composer' })

  const drawn = await ui.drawn({ in: 'composer' })
  expect(drawn).toBeDefined()

  const textElements = await ui.findAll({ type: 'Text', in: 'composer' })
  const visualRows = textElements.filter(t => t.props.mono === true)
  const concatenated = visualRows.map(t => t.text).join('')
  expect(visualRows.length).toBeGreaterThan(1)
  expect(visualRows.every(t => Array.from(t.text).length <= 24)).toBe(true)
  expect(concatenated).toBe(longText + ' ') // only the end caret adds a cell
  expect(concatenated.includes('…')).toBe(false)

  await ui.key({ key: 'return', in: 'composer' })
  await ui.unmount()
})

test('shift return preserves newline, editing keys, and final Enter fork', async ($, on) => {
  const prompts: string[] = []
  on('model.fork', (_, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: 'answer', usage: USAGE } }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.key({ key: 'line one', in: 'composer' })
  await ui.key({ key: 'return', shift: true, in: 'composer' })
  await ui.key({ key: 'line two extra', in: 'composer' })

  await ui.key({ key: 'backspace', in: 'composer' })
  await ui.key({ key: 'home', in: 'composer' })
  await ui.key({ key: 'right', in: 'composer' })
  await ui.key({ key: 'delete', in: 'composer' })

  await ui.key({ key: 'return', in: 'composer' })

  expect(prompts.length).toBe(1)
  expect(prompts[0]!.split('Current question:\n')[1]).toBe('line one\nlne two extr')
  await ui.unmount()
})

test('cursor navigation up/down, ctrl+a replacement, and undo/redo', async ($, on) => {
  const prompts: string[] = []
  on('model.fork', (_, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: 'answer', usage: USAGE } }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.key({ key: 'hello', in: 'composer' })
  await ui.key({ key: 'return', shift: true, in: 'composer' })
  await ui.key({ key: 'world', in: 'composer' })

  await ui.key({ key: 'up', in: 'composer' })
  await ui.key({ key: 'down', in: 'composer' })

  await ui.key({ key: 'a', ctrl: true, in: 'composer' })
  await ui.key({ key: 'replaced', in: 'composer' })

  await ui.key({ key: 'z', ctrl: true, in: 'composer' })
  await ui.key({ key: 'z', ctrl: true, shift: true, in: 'composer' })

  await ui.key({ key: 'return', in: 'composer' })
  expect(prompts.length).toBe(1)
  expect(prompts[0]!.split('Current question:\n')[1]).toBe('replaced')
  await ui.unmount()
})

test('parent redraw from state update via press clear preserves editor draft', async ($, on) => {
  const prompts: string[] = []
  on('model.fork', (_, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: 'answer', usage: USAGE } }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.key({ key: 'surviving draft', in: 'composer' })

  await ui.press({ key: 'clear' })

  const textElements = await ui.findAll({ type: 'Text', in: 'composer' })
  const concatenated = textElements.map(t => t.text).join('')
  expect(concatenated.includes('surviving draft')).toBe(true)

  await ui.key({ key: 'return', in: 'composer' })
  expect(prompts.length).toBe(1)
  expect(prompts[0]!.includes('surviving draft')).toBe(true)
  await ui.unmount()
})

test('post coalescing and dedup protocol', async ($, on) => {
  const prompts: string[] = []
  on('model.fork', (_, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: 'answer', usage: USAGE } }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.post(
    {
      clientId: 'test-client',
      revision: 1,
      draft: 'next draft',
      submissions: [{ sequence: 1, text: 'first question' }],
    },
    { in: 'composer' },
  )

  await ui.post(
    {
      clientId: 'test-client',
      revision: 2,
      draft: 'next draft 2',
      submissions: [
        { sequence: 1, text: 'first question' },
        { sequence: 2, text: 'second question' },
      ],
    },
    { in: 'composer' },
  )

  expect(prompts.length).toBe(2)
  expect(prompts[0]!.includes('first question')).toBe(true)
  expect(prompts[1]!.includes('second question')).toBe(true)
  expect(prompts[1]!.includes('first question')).toBe(true)
  expect(prompts[1]!.includes('answer')).toBe(true)
  await ui.post({ clientId: 'test-client', revision: 1, draft: 'stale',
    submissions: [{ sequence: 1, text: 'must not run' }] }, { in: 'composer' })
  expect(prompts.length).toBe(2)

  await ui.unmount()
})

test('invalid data object submissions wrong type or no draft triggers no fork and no throw', async ($, on) => {
  let calls = 0
  on('model.fork', () => {
    calls++
    return { value: { isAnswered: true, text: 'answer', usage: USAGE } }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.post({ clientId: '', revision: -1, draft: 123, submissions: 'invalid' }, { in: 'composer' })
  await ui.post(null, { in: 'composer' })
  await ui.post({ clientId: 'abc', revision: 0, draft: 'draft', submissions: [{ sequence: 0, text: '' }] }, { in: 'composer' })

  expect(calls).toBe(0)
  await ui.unmount()
})

test('wrapped viewport keeps every row accessible and the caret unique', async ($, on) => {
  let question = ''
  on('model.fork', (_, e) => {
    question = e.prompt.split('Current question:\n')[1] ?? ''
    return { value: { isAnswered: true, text: 'answer', usage: USAGE } }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const draft = 'a'.repeat(80) + '\n\n' + 'b'.repeat(80)
  await ui.key({ key: draft, in: 'composer' })
  await ui.resize({ columns: 12, rows: 3, in: 'composer' })
  let rows = (await ui.findAll({ type: 'Text', in: 'composer' })).filter(t => t.props.mono === true)
  expect(rows.length <= 3).toBe(true)
  expect(rows.map(r => r.text).join('').includes('b')).toBe(true)
  await ui.key({ key: 'home', ctrl: true, in: 'composer' })
  rows = (await ui.findAll({ type: 'Text', in: 'composer' })).filter(t => t.props.mono === true)
  expect(rows.map(r => r.text).join('').includes('a')).toBe(true)
  expect((await ui.findAll({ type: 'Text', in: 'composer' })).filter(t => t.props.inverse === true).length).toBe(1)
  await ui.key({ key: 'end', ctrl: true, in: 'composer' })
  await ui.key({ key: 'return', in: 'composer' })
  expect(question).toBe(draft)
  await ui.unmount()
})

test('click editing and Unicode preserve the submitted text', async ($, on) => {
  let question = ''
  on('model.fork', (_, e) => {
    question = e.prompt.split('Current question:\n')[1] ?? ''
    return { value: { isAnswered: true, text: 'answer', usage: USAGE } }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.key({ key: 'abcd', in: 'composer' })
  await ui.resize({ columns: 30, rows: 3, in: 'composer' })
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'composer' })
  await ui.key({ key: '界😀', in: 'composer' })
  await ui.key({ key: 'backspace', in: 'composer' })
  await ui.key({ key: 'return', in: 'composer' })
  expect(question).toBe('ab界cd')
  await ui.unmount()
})

test('an oversized edit preserves the draft and reports the limit', async ($, on) => {
  let question = ''
  on('model.fork', (_, e) => {
    question = e.prompt.split('Current question:\n')[1] ?? ''
    return { value: { isAnswered: true, text: 'answer', usage: USAGE } }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.key({ key: 'kept', in: 'composer' })
  await ui.key({ key: 'x'.repeat(24001), in: 'composer' })
  expect(await ui.find({ type: 'Text', text: /Draft limit reached/, in: 'composer' })).toBeDefined()
  await ui.key({ key: 'return', in: 'composer' })
  expect(question).toBe('kept')
  await ui.unmount()
})

test('native terminal stays Input', async ($, on) => {
  on('model.fork', () => ({
    value: { isAnswered: true, text: 'answer', usage: USAGE },
  }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Input' })).toBeDefined()
  await ui.input({ key: 'ask', text: 'terminal question' })

  expect((await ui.find({ type: 'Text', text: /answer/ }))?.text).toBe(
    '● answer',
  )
  await ui.unmount()
})

test('a blank submit forks nothing', async ($, on) => {
  let calls = 0
  on('model.fork', () => {
    calls++
    return { value: { isAnswered: true, text: 'unused', usage: USAGE } }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'ask', text: '   ' })

  expect(calls).toBe(0)
  await ui.unmount()
})
