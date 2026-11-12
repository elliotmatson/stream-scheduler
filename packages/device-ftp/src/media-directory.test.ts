import { describe, expect, it } from 'vitest'
import {
  ftpPath,
  isHousekeeping,
  mediaDirectory,
  parentOf,
  type FtpSession,
  type RemoteEntry,
} from './index.js'

/**
 * A file server as a tree, because the real ones are.
 *
 * Every Blackmagic box that serves its media over FTP puts one directory
 * per mounted volume at the root and the clips inside it. This models
 * that so the resolver is tested against the layout it exists for, rather
 * than against a flat list that would agree with anything.
 */
function server(tree: Record<string, RemoteEntry[]>): FtpSession {
  const at = (directory: string): RemoteEntry[] => tree[directory === '' ? '/' : directory] ?? []
  return {
    entries: async (directory) => at(directory),
    // The same rule the real session applies, so the fake cannot agree
    // with a resolver the real one would disagree with.
    list: async (directory) => at(directory).filter((entry) => !isHousekeeping(entry.name)),
    remove: async () => {},
    removeDirectory: async () => {},
    close: async () => {},
  }
}

const file = (name: string): RemoteEntry => ({ name, size: 1_000, isDirectory: false })
const folder = (name: string): RemoteEntry => ({ name, size: 0, isDirectory: true })

describe('finding where a device keeps its clips', () => {
  it('goes one level down when the root is a list of cards', () => {
    // The bug this exists for: the root has no files at all, so filtering
    // directories out as "not media" left an empty listing and no error —
    // which looked exactly like a device whose FTP server does not work.
    const session = server({
      '/': [folder('Sunday')],
      '/Sunday': [file('service.mov')],
    })
    return expect(mediaDirectory(session, '/')).resolves.toBe('/Sunday')
  })

  it('stays at the root when the clips are already there', () => {
    const session = server({ '/': [file('service.mov')] })
    return expect(mediaDirectory(session, '/')).resolves.toBe('/')
  })

  it('picks the card the caller named', async () => {
    const session = server({
      '/': [folder('Archive'), folder('Sunday')],
      '/Archive': [file('old.mov')],
      '/Sunday': [file('service.mov')],
    })
    await expect(mediaDirectory(session, '/', ['Sunday'])).resolves.toBe('/Sunday')
    // Case is the operator's business, not something to fail over.
    await expect(mediaDirectory(session, '/', ['sunday'])).resolves.toBe('/Sunday')
  })

  it('tries each preference in turn', async () => {
    // The deck's own name for the card first, then the slot number, for
    // firmware that numbers its folders instead of naming them.
    const session = server({ '/': [folder('1'), folder('2')], '/2': [file('service.mov')] })
    await expect(mediaDirectory(session, '/', ['Sunday', '2'])).resolves.toBe('/2')
  })

  it('falls back to the only card there is', async () => {
    // A switcher with one disk, whose volume name nobody asked about.
    const session = server({ '/': [folder('Untitled')], '/Untitled': [file('a.mp4')] })
    await expect(mediaDirectory(session, '/', [undefined, ''])).resolves.toBe('/Untitled')
  })

  it('leaves an empty root alone rather than inventing a path', async () => {
    await expect(mediaDirectory(server({ '/': [] }), '/')).resolves.toBe('/')
  })

  it('does not double the slash', () => {
    expect(ftpPath('/', 'a.mov')).toBe('/a.mov')
    expect(ftpPath('/Sunday', 'a.mov')).toBe('/Sunday/a.mov')
    expect(ftpPath('/Sunday/', 'a.mov')).toBe('/Sunday/a.mov')
  })
})

describe('what counts as media', () => {
  it('ignores the housekeeping a Mac leaves on a card', () => {
    // Every one of these was on the real drive.
    expect(isHousekeeping('._.')).toBe(true)
    expect(isHousekeeping('.Spotlight-V100')).toBe(true)
    expect(isHousekeeping('.fseventsd')).toBe(true)
    expect(isHousekeeping('._2026-10-18_08-57-59_and-college-atem 01.mp4')).toBe(true)
    expect(isHousekeeping('2026-10-18_08-57-59_and-college-atem')).toBe(false)
  })

  it('does not mistake a sidecar at the root for a card full of clips', async () => {
    // What actually happened: the only plain file on the drive was an
    // AppleDouble sidecar, so the root looked like it held clips and the
    // resolver stopped there instead of descending to the volume.
    const session = server({
      '/': [file('._.'), folder('AND-College')],
      '/AND-College': [folder('2026-10-18_08-57-59_and-college-atem')],
    })

    expect(await mediaDirectory(session, '/')).toBe('/AND-College')
  })
})

describe('stepping back up a card', () => {
  it('knows what is above a directory', () => {
    expect(parentOf('/AND-College/2026-10-18_08-57-59_and-college-atem')).toBe('/AND-College')
    expect(parentOf('/AND-College')).toBe('/')
    expect(parentOf('/AND-College/')).toBe('/')
  })

  it('stops at the top, because the root has nothing above it', () => {
    // A way up from `/` would ask the server for the empty string, and no
    // two FTP servers agree on what that means.
    expect(parentOf('/')).toBeUndefined()
    expect(parentOf('')).toBeUndefined()
  })
})
