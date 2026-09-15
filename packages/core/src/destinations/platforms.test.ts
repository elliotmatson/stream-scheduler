import { describe, expect, it } from 'vitest'
import { looksLikeKey, platformById, STREAMING_PLATFORMS } from './platforms.js'

/**
 * A catalogue is only useful if it is right, and only safe if being wrong
 * costs nothing. These tests are about both halves.
 */

describe('the platform catalogue', () => {
  it('has no two services sharing an id', () => {
    const ids = STREAMING_PLATFORMS.map((platform) => platform.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('says where to find the key for every one of them', () => {
    // The whole reason this list exists. A service with a URL and no
    // instructions leaves somebody exactly where they started.
    for (const platform of STREAMING_PLATFORMS) {
      expect(platform.whereToFind.length).toBeGreaterThan(10)
      expect(platform.name.length).toBeGreaterThan(0)
    }
  })

  it('only prefills a URL it can actually know', () => {
    // Vimeo, Kick and LinkedIn issue one per account or per broadcast.
    // Prefilling a plausible wrong URL is worse than prefilling nothing:
    // the mistake shows up as a stream that silently does not appear.
    for (const id of ['vimeo', 'kick', 'linkedin', 'resi', 'boxcast']) {
      expect(platformById(id)?.ingestUrl).toBeUndefined()
      expect(platformById(id)?.note ?? platformById(id)?.whereToFind).toMatch(/paste|per|issue/i)
    }
    expect(platformById('facebook')?.ingestUrl).toMatch(/^rtmps:\/\//)
    expect(platformById('twitch')?.ingestUrl).toMatch(/^rtmp:\/\//)
  })

  it('offers Twitch the automatic ingest first', () => {
    // Naming a region is a thing to do when you have measured it, not the
    // default. The automatic one picks the nearest.
    const twitch = platformById('twitch')
    expect(twitch?.servers?.[0]?.url).toBe(twitch?.ingestUrl)
    expect(twitch?.servers?.[0]?.label).toMatch(/automatic/i)
  })

  it('warns about the Facebook key that expires', () => {
    // The one on this list that reliably costs somebody a Sunday.
    expect(platformById('facebook')?.note).toMatch(/persistent|expire/i)
  })

  it('steers YouTube to the account connection rather than a key', () => {
    // A connected account makes the broadcast, sets the title and gives
    // the watch link beforehand. A key does none of that.
    expect(platformById('youtube')?.note).toMatch(/connect/i)
  })
})

describe('checking a key against its service', () => {
  it('recognises the shapes it knows', () => {
    expect(looksLikeKey('twitch', 'live_123456789_abcDEF123')).toBe('ok')
    expect(looksLikeKey('youtube', 'abcd-efgh-ijkl-mnop-qrst')).toBe('ok')
  })

  it('says so when a key is not that shape', () => {
    // The mistake it is really for: pasting the URL into the key box.
    expect(looksLikeKey('twitch', 'rtmp://live.twitch.tv/app')).toBe('unexpected')
    expect(looksLikeKey('youtube', 'live_123_abc')).toBe('unexpected')
  })

  it('does not guess for a service with no published format', () => {
    // Different from "that looks wrong", and a screen that showed them the
    // same way would cry wolf on most of the list.
    expect(looksLikeKey('facebook', 'anything at all')).toBe('unknown')
    expect(looksLikeKey('vimeo', 'anything at all')).toBe('unknown')
    expect(looksLikeKey('not-a-service', 'x')).toBe('unknown')
  })

  it('ignores surrounding whitespace, which is how keys arrive', () => {
    expect(looksLikeKey('twitch', '  live_123456789_abcDEF123\n')).toBe('ok')
  })
})
