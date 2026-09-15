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

/** One conversation with a device's file server. */
export interface FtpSession {
  list(directory: string): Promise<RemoteFile[]>
  /** Removes one file. Throws if the server refuses. */
  remove(path: string): Promise<void>
  close(): Promise<void>
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

  return {
    list: async (directory) =>
      (await client.list(directory))
        // Directories are not media. A deck puts its clips at the top of
        // each card, and a folder somebody made is theirs to manage.
        .filter((entry) => entry.isFile)
        .map((entry) => ({
          name: entry.name,
          size: entry.size,
          ...(entry.modifiedAt === undefined ? {} : { modifiedAt: entry.modifiedAt.getTime() }),
        })),
    remove: async (path) => {
      await client.remove(path)
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
