import { describe, expect, it } from 'vitest'
import { controlRoomOf, siteOf } from './watch-links.ts'

describe('the control room for a broadcast', () => {
  it.each([
    'https://www.youtube.com/watch?v=ye2-l5thRLU',
    'https://youtu.be/ye2-l5thRLU',
    'https://www.youtube.com/live/ye2-l5thRLU?feature=share',
    'https://m.youtube.com/watch?v=ye2-l5thRLU&t=30',
  ])('goes from %s to YouTube Studio', (watch) => {
    expect(controlRoomOf(watch)).toBe('https://studio.youtube.com/video/ye2-l5thRLU/livestreaming')
  })

  it('has none for a site without one', () => {
    expect(controlRoomOf('https://www.twitch.tv/gracebible')).toBeUndefined()
    expect(controlRoomOf('not a url')).toBeUndefined()
  })
})

describe('naming where a link goes', () => {
  it('names the sites it knows', () => {
    expect(siteOf('https://youtu.be/abc')).toBe('YouTube')
    expect(siteOf('https://www.twitch.tv/gracebible')).toBe('Twitch')
    expect(siteOf('https://example.org/live')).toBe('the stream')
  })
})
