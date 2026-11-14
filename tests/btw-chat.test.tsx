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
    'answer 2',
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
