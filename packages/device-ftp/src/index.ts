import { Client } from 'basic-ftp'

/**
 * Reading and removing files on a device that serves its media over FTP.
 *
 * Shared because it is the same story on every Blackmagic box worth
 * pointing this scheduler at. A HyperDeck's control protocol lists clips
 * and has no delete verb at all; an ATEM's has neither. Both serve the
 * recording media over anonymous FTP, which is the path their own web
 * pages use, and so it is the only way to see a file's size or when it was
 * made — the control protocols report neither.
 *
 * Its own package rather than a copy in each adapter: plugins may depend
 * on the SDK and nothing else, and this is not the SDK's business. The
 * SDK says what an action means; this is one way of carrying it out.
 *
 * Anonymous, because the devices have no notion of an account. That is
 * their design, not something an adapter can fix, and the advice that
 * goes with it is the same as for the control ports: put the gear on a
 * trusted control VLAN.
 */

export interface RemoteFile {
  name: string
  /** Bytes, as the server reports them. */
  size: number
  /**
   * When the server says it was written, where it says at all.
   *
   * The reason this path exists for listing at all: a HyperDeck's `disk
   * list` names its clips and will not say when any of them was made.
   */
  modifiedAt?: number
}

/** A file or a directory, as the server named it. */
export interface RemoteEntry extends RemoteFile {
  isDirectory: boolean
}

/** One conversation with a device's file server. */
export interface FtpSession {
  /**
   * The media in a directory: recordings, whether each is one file or a
   * folder of them, and nothing the card keeps for its own purposes.
   */
  list(directory: string): Promise<RemoteEntry[]>
  /** Everything in a directory, exactly as the server listed it. */
  entries(directory: string): Promise<RemoteEntry[]>
  /** Removes one file. Throws if the server refuses. */
  remove(path: string): Promise<void>
  /** Removes a directory and everything inside it. */
  removeDirectory(path: string): Promise<void>
  close(): Promise<void>
}

/**
 * Whether an entry is the card's business rather than a recording.
 *
 * Every card that has ever been plugged into a Mac carries its
 * housekeeping: `.Spotlight-V100`, `.fseventsd`, and an AppleDouble
 * sidecar for each file. On a real ATEM drive that sidecar — `._.`, four
 * kilobytes, no date — was the *only* plain file among the recordings, so
 * a listing that kept files and dropped directories showed it and nothing
 * else: one row of junk where a month of services should have been.
 *
 * Leading dot, which is what every one of them has in common and what
 * every file manager hides them by.
 */
export function isHousekeeping(name: string): boolean {
  return name.startsWith('.')
}

export type FtpConnect = (options: { host: string; port?: number }) => Promise<FtpSession>

/**
 * Long enough for a device that is busy writing, short enough that a
 * listing cannot hang the caller that asked for it.
 */
export const FTP_TIMEOUT_MS = 15_000

/** The real one. Swapped out in tests, which have no FTP server. */
export const connectFtp: FtpConnect = async ({ host, port }) => {
  const client = new Client(FTP_TIMEOUT_MS)
  await client.access({
    host,
    ...(port === undefined ? {} : { port }),
    user: 'anonymous',
    password: 'anonymous',
    secure: false,
  })

  const entries = async (directory: string): Promise<RemoteEntry[]> =>
    (await client.list(directory)).map((entry) => ({
      name: entry.name,
      size: entry.size,
      isDirectory: entry.isDirectory,
      ...(entry.modifiedAt === undefined ? {} : { modifiedAt: entry.modifiedAt.getTime() }),
    }))

  return {
    entries,
    // Directories are kept, because on an ATEM recording in ISO mode the
    // recording *is* a directory: a folder per take holding the programme
    // file, the ISO files and the project. Dropping them as "not media"
    // hid every ATEM recording this scheduler had ever made. A deck's
    // clips are plain files and are unaffected — but a folder somebody
    // else put on the card shows up now, which is what the panel says it
    // shows: everything on the media.
    list: async (directory) =>
      (await entries(directory)).filter((entry) => !isHousekeeping(entry.name)),
    remove: async (path) => {
      await client.remove(path)
    },
    removeDirectory: async (path) => {
      // Recursive, because a recording folder is never empty and RMD on a
      // directory with contents is refused by every server worth the name.
      await client.removeDir(path)
    },
    close: async () => {
      client.close()
    },
  }
}

/** Joins a directory and a name without doubling or dropping the slash. */
export function ftpPath(directory: string, name: string): string {
  const base = directory.endsWith('/') ? directory.slice(0, -1) : directory
  return `${base}/${name}`
}

/**
 * Where a device actually keeps its clips.
 *
 * Blackmagic boxes do not put recordings at the FTP root. The root holds
 * one directory per mounted volume — named after the card, so a HyperDeck
 * with an SD in slot 2 serves it as `/Untitled` or whatever the card is
 * called — and the clips are inside. Listing the root therefore comes back
 * with directories and no files at all, which, once the directories were
 * filtered out as "not media", looked exactly like a device whose FTP
 * server does not work: an empty list, no error, every time, on every
 * device.
 *
 * So: use `root` if it has files in it, and otherwise go one level down.
 * `prefer` is how the caller says which volume it meant — the deck's own
 * name for the slot, and the slot number after it, since a device that
 * does number its folders should not land on whichever card happens to
 * sort first. Falling back to the only directory there is stays right for
 * a switcher with one disk, which is the common case.
 *
 * One directory, not a merge of several: a delete has to resolve to the
 * same place this listing came from, and two cards can hold files with
 * the same name.
 */
export async function mediaDirectory(
  session: FtpSession,
  root: string,
  prefer: (string | undefined)[] = [],
): Promise<string> {
  // Housekeeping is filtered before anything is decided from it. A Mac
  // leaves an AppleDouble sidecar at the top of the card too, and one
  // stray `._.` at the root was enough to make this call the root a card
  // and stop looking — which is a listing of the wrong directory, and
  // reads on screen exactly like an empty one.
  const entries = (await session.entries(root)).filter((entry) => !isHousekeeping(entry.name))
  // Clips at the root means this is already a card, not a list of cards.
  if (entries.some((entry) => !entry.isDirectory)) return root

  const directories = entries.filter((entry) => entry.isDirectory)
  if (directories.length === 0) return root

  for (const wanted of prefer) {
    if (wanted === undefined || wanted === '') continue
    const match = directories.find(
      (entry) => entry.name.localeCompare(wanted, undefined, { sensitivity: 'base' }) === 0,
    )
    if (match) return ftpPath(root, match.name)
  }
  return ftpPath(root, directories[0]!.name)
}
