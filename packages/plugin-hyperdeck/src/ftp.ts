import { Client } from 'basic-ftp'

/**
 * Deleting a file off a HyperDeck.
 *
 * Its control protocol on 9993 lists clips and cannot remove them — there
 * is no delete verb in the documented protocol at all. The card is served
 * over FTP, anonymously, which is the same path the Files link on the
 * device page opens. So a sweep is a second connection over a second
 * protocol, and that is why this lives in its own file rather than beside
 * the transport commands.
 *
 * Anonymous, like the control port: the deck has no notion of a user, and
 * that is the device's design rather than something this adapter can fix.
 * The same advice applies — put the gear on a trusted control VLAN.
 */

/** One conversation with the deck's file server. */
export interface FtpSession {
  /** Removes one file, by the name the listing gave. */
  remove(path: string): Promise<void>
  /** Names on the card, so a delete can be checked rather than assumed. */
  list(directory: string): Promise<string[]>
  close(): Promise<void>
}

export type FtpConnect = (options: { host: string; port?: number }) => Promise<FtpSession>

/** The real one. Swapped out in tests, which have no FTP server. */
export const connectFtp: FtpConnect = async ({ host, port }) => {
  const client = new Client(FTP_TIMEOUT_MS)
  await client.access({
    host,
    ...(port === undefined ? {} : { port }),
    // The deck's own defaults. It has no accounts to log in to.
    user: 'anonymous',
    password: 'anonymous',
    secure: false,
  })

  return {
    remove: async (path) => {
      await client.remove(path)
    },
    list: async (directory) => (await client.list(directory)).map((entry) => entry.name),
    close: async () => {
      client.close()
    },
  }
}

/**
 * Long enough for a deck that is busy writing, short enough that a sweep
 * cannot hang the tick it runs on.
 */
export const FTP_TIMEOUT_MS = 15_000
