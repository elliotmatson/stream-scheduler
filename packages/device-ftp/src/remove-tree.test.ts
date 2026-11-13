import { describe, expect, it } from 'vitest'
import { removeTree } from './index.js'

/** A folder tree, and the order things were deleted in. */
function fakeServer(tree: Record<string, string[]>) {
  const removed: string[] = []
  return {
    removed,
    entries: async (directory: string) =>
      (tree[directory] ?? []).map((name) => ({
        name: name.replace(/\/$/, ''),
        isDirectory: name.endsWith('/'),
      })),
    removeFile: async (path: string) => void removed.push(`DELE ${path}`),
    removeEmptyDirectory: async (path: string) => void removed.push(`RMD ${path}`),
  }
}

describe('removing a recording folder', () => {
  it('empties it by full path, deepest first, then removes it', async () => {
    // An ATEM ISO recording, as it sits on a card that has been near a Mac.
    const server = fakeServer({
      '/AND-College/2026-10-18 rec': ['Program.mp4', '._Program.mp4', 'Video ISO Files/'],
      '/AND-College/2026-10-18 rec/Video ISO Files': ['CAM 1.mp4', 'CAM 2.mp4'],
    })
    await removeTree(server, '/AND-College/2026-10-18 rec')
    expect(server.removed).toEqual([
      'DELE /AND-College/2026-10-18 rec/Program.mp4',
      'DELE /AND-College/2026-10-18 rec/._Program.mp4',
      'DELE /AND-College/2026-10-18 rec/Video ISO Files/CAM 1.mp4',
      'DELE /AND-College/2026-10-18 rec/Video ISO Files/CAM 2.mp4',
      'RMD /AND-College/2026-10-18 rec/Video ISO Files',
      'RMD /AND-College/2026-10-18 rec',
    ])
  })

  it('stops at the first refusal, and says so', async () => {
    const server = fakeServer({ '/card/rec': ['locked.mp4'] })
    server.removeFile = async () => {
      throw new Error('550 Permission denied')
    }
    await expect(removeTree(server, '/card/rec')).rejects.toThrow('550 Permission denied')
  })
})
