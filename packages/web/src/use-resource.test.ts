import { createElement } from 'react'
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { useResource } from './api.ts'

/**
 * The hook every screen loads through.
 *
 * What it gets wrong shows up as a screen that lies: "No events yet" while
 * the list is still on its way, a list that vanishes because one refresh
 * failed, or an old answer arriving late and replacing a newer one.
 */

// Tells React this is a test, so `act` waits for effects and state.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Seen = ReturnType<typeof useResource<string>>

/** A promise the test settles when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let renderer: ReactTestRenderer | undefined
let seen: Seen

function Probe({ load, deps }: { load: () => Promise<string>; deps: unknown[] }) {
  seen = useResource(load, deps)
  return null
}

async function mount(load: () => Promise<string>, deps: unknown[] = []) {
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe, { load, deps }))
  })
}

async function settle(fn: () => void) {
  await act(async () => {
    fn()
    await Promise.resolve()
  })
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

describe('loading', () => {
  it('says it is loading until the first answer arrives', async () => {
    const answer = deferred<string>()
    await mount(() => answer.promise)
    expect(seen).toMatchObject({ data: undefined, loading: true, error: undefined })

    await settle(() => answer.resolve('events'))
    expect(seen).toMatchObject({ data: 'events', loading: false, error: undefined })
  })

  it('reports a failure as a message, with nothing pretending to be data', async () => {
    const answer = deferred<string>()
    await mount(() => answer.promise)

    await settle(() => answer.reject(new Error('The server did not answer')))
    expect(seen).toMatchObject({
      data: undefined,
      loading: false,
      error: 'The server did not answer',
    })
  })
})

describe('reloading', () => {
  it('keeps the last good answer when a refresh fails', async () => {
    const answers = [deferred<string>(), deferred<string>()]
    let call = 0
    await mount(() => answers[call++]!.promise)
    await settle(() => answers[0]!.resolve('three events'))

    await act(async () => seen.reload())
    expect(seen.loading).toBe(true)
    await settle(() => answers[1]!.reject(new Error('offline')))

    expect(seen).toMatchObject({ data: 'three events', error: 'offline', loading: false })
  })

  it('clears the failure once a refresh works', async () => {
    const answers = [deferred<string>(), deferred<string>()]
    let call = 0
    await mount(() => answers[call++]!.promise)
    await settle(() => answers[0]!.reject(new Error('offline')))

    await act(async () => seen.reload())
    await settle(() => answers[1]!.resolve('back'))
    expect(seen).toMatchObject({ data: 'back', error: undefined, loading: false })
  })

  it('does not let a slow old answer replace a newer one', async () => {
    const slow = deferred<string>()
    const fast = deferred<string>()
    await mount(() => slow.promise, ['slot 1'])

    // Somebody picks another card before the first one has answered.
    await act(async () => {
      renderer!.update(createElement(Probe, { load: () => fast.promise, deps: ['slot 2'] }))
    })
    await settle(() => fast.resolve('slot 2 files'))
    await settle(() => slow.resolve('slot 1 files'))

    expect(seen.data).toBe('slot 2 files')
  })
})
