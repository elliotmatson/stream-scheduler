/**
 * The services people actually stream to, and what each one needs.
 *
 * Not integrations. A handful of services issue a broadcast per event
 * through an API — YouTube is the one this app implements — and the rest
 * hand out a fixed ingest URL and a key that you paste in once. The
 * difference between those two is real and this file is about the second
 * kind: it does not make anybody's broadcast, it just means adding one
 * stops being "find the RTMP URL on a forum and hope".
 *
 * Every entry is a prompt, never a gate. Ingest hostnames change, key
 * formats change, and a scheduler that refuses a perfectly good key at
 * 08:55 on a Sunday because a regex is eighteen months out of date is
 * worse than one that says nothing. `keyPattern` warns. Nothing here
 * refuses.
 *
 * Where a service issues the URL per account or per broadcast — Vimeo,
 * Kick, LinkedIn, every enterprise platform — there is deliberately no
 * `ingestUrl`. Prefilling a plausible-looking wrong URL is worse than
 * prefilling nothing, because the mistake only shows up as a stream that
 * silently does not appear.
 */

export interface PlatformServer {
  label: string
  url: string
}

export interface StreamingPlatform {
  id: string
  name: string
  /**
   * The ingest URL, where it is the same for everybody.
   *
   * Absent when the service issues one per account or per broadcast, in
   * which case the form asks for it rather than guessing.
   */
  ingestUrl?: string
  /** Alternatives, where the service publishes several. */
  servers?: PlatformServer[]
  /** Where the key lives, in that service's own words. */
  whereToFind: string
  /** A deep link to that page, where the service has a stable one. */
  findKeyUrl?: string
  /**
   * What a key for this service usually looks like.
   *
   * Used to say "that does not look like a Twitch key" beside the box.
   * Never to refuse one.
   */
  keyPattern?: string
  /** The thing about this service that catches people out. */
  note?: string
}

/**
 * Ordered roughly by how often a church actually uses them, because this
 * list is read top to bottom by somebody who already knows which one they
 * want.
 */
export const STREAMING_PLATFORMS: StreamingPlatform[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    ingestUrl: 'rtmps://a.rtmp.youtube.com/live2',
    whereToFind: 'YouTube Studio → Go live → Stream settings, under "Stream key".',
    findKeyUrl: 'https://studio.youtube.com/channel/UC/livestreaming',
    keyPattern: '^[a-z0-9]{4}(-[a-z0-9]{4}){4}$',
    note:
      'Connecting a YouTube account above is better than a key: it makes the broadcast for each ' +
      'event, sets the title and description from your templates, and gives you the watch link ' +
      'beforehand. Use a key only for a channel you cannot connect.',
  },
  {
    id: 'facebook',
    name: 'Facebook Live',
    ingestUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    whereToFind: 'Facebook Live Producer → Streaming software, under "Stream key".',
    findKeyUrl: 'https://www.facebook.com/live/producer',
    note:
      'A key from Live Producer is single-use and expires: it goes dead once that broadcast ends. ' +
      'Turn on "Use a persistent stream key" when you create it, or this needs replacing every week.',
  },
  {
    id: 'twitch',
    name: 'Twitch',
    ingestUrl: 'rtmp://live.twitch.tv/app',
    servers: [
      { label: 'Automatic (recommended)', url: 'rtmp://live.twitch.tv/app' },
      { label: 'US East — New York', url: 'rtmp://jfk.contribute.live-video.net/app' },
      { label: 'US West — Los Angeles', url: 'rtmp://lax.contribute.live-video.net/app' },
      { label: 'US Central — Dallas', url: 'rtmp://dfw.contribute.live-video.net/app' },
      { label: 'Europe — London', url: 'rtmp://lhr.contribute.live-video.net/app' },
      { label: 'Europe — Frankfurt', url: 'rtmp://fra.contribute.live-video.net/app' },
    ],
    whereToFind: 'Twitch Creator Dashboard → Settings → Stream, under "Primary Stream key".',
    findKeyUrl: 'https://dashboard.twitch.tv/settings/stream',
    keyPattern: '^live_\\d+_[A-Za-z0-9]+$',
    note:
      'Connecting a Twitch account above is better than a key: it sets the channel title and ' +
      'category from your templates before each service and reads the key itself, so a reset key ' +
      'fixes itself. Twitch has no per-broadcast video, so unlike YouTube there is no watch link ' +
      'made in advance. The automatic URL here picks the nearest ingest and is the right answer ' +
      'almost always; name a region only if you have measured that it is better.',
  },
  {
    id: 'vimeo',
    name: 'Vimeo',
    whereToFind:
      'Vimeo → your live event → Set up, under "RTMP". Vimeo gives you a URL and a key together.',
    findKeyUrl: 'https://vimeo.com/manage/videos',
    note:
      'Vimeo issues the URL per event rather than publishing one for everybody, so paste the URL ' +
      'it gives you alongside the key. A recurring event set up as "recurring" in Vimeo keeps the ' +
      'same URL; a one-off does not.',
  },
  {
    id: 'restream',
    name: 'Restream',
    ingestUrl: 'rtmp://live.restream.io/live',
    whereToFind: 'Restream → Stream settings, under "Stream key".',
    findKeyUrl: 'https://restream.io/dashboard',
    note:
      'One stream out of the encoder, several services out of Restream. Worth it when the encoder ' +
      'has one output and you want three platforms, and not worth the extra hop otherwise.',
  },
  {
    id: 'kick',
    name: 'Kick',
    whereToFind: 'Kick → Creator Dashboard → Settings → Stream Key.',
    findKeyUrl: 'https://kick.com/dashboard/settings/stream',
    note: 'The ingest URL has your own account in the hostname, so paste the one Kick shows you.',
  },
  {
    id: 'linkedin',
    name: 'LinkedIn Live',
    whereToFind: 'LinkedIn → create the live event, then its "Stream" settings.',
    note:
      'The URL and key are issued per event and only exist once the event has been created, so ' +
      'there is nothing to prefill. A page must be approved for LinkedIn Live before any of it ' +
      'appears.',
  },
  {
    id: 'boxcast',
    name: 'BoxCast',
    ingestUrl: 'rtmp://rtmp.boxcast.com/live',
    whereToFind:
      'BoxCast dashboard → Sources → your RTMP source. It shows a Server URL and a Stream Key ' +
      'with copy buttons beside each.',
    findKeyUrl: 'https://dashboard.boxcast.com/sources',
    note:
      'The stream key changes with every broadcast unless your account has the static RTMP ' +
      'feature switched on — without it this needs replacing each week. Ask BoxCast for a static ' +
      'source if you are scheduling a recurring service against it.',
  },
  {
    id: 'owncast',
    name: 'Owncast or another self-hosted server',
    whereToFind: 'Your own server’s admin page. For Owncast it is under Configuration → Server.',
    note:
      'Usually rtmp://your-server:1935/live with the streaming key you set yourself. Use rtmps ' +
      'if the server offers it: a stream key over plain RTMP crosses the network in the clear.',
  },
  {
    id: 'custom',
    name: 'Something else',
    whereToFind: 'Whatever the service calls its RTMP or SRT ingest, and its stream key.',
  },
]

export function platformById(id: string): StreamingPlatform | undefined {
  return STREAMING_PLATFORMS.find((platform) => platform.id === id)
}

/**
 * Whether a key looks like one of this service's, as far as anybody knows.
 *
 * Three answers, not two. "We have no pattern for this service" is not the
 * same as "that looks wrong", and a screen that showed them the same way
 * would cry wolf on every service without a published format.
 */
export function looksLikeKey(platformId: string, key: string): 'ok' | 'unexpected' | 'unknown' {
  const platform = platformById(platformId)
  if (!platform?.keyPattern) return 'unknown'
  try {
    return new RegExp(platform.keyPattern).test(key.trim()) ? 'ok' : 'unexpected'
  } catch {
    // A pattern this file got wrong must not take the form down with it.
    return 'unknown'
  }
}
