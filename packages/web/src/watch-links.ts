/**
 * Where to manage a broadcast, worked out from where it is watched.
 *
 * YouTube's watch page and its live control room are different places,
 * and the control room is the one somebody wants mid-service: health,
 * chat, the end button. Only YouTube has one we can link to.
 */
export function controlRoomOf(watchUrl: string): string | undefined {
  let url: URL
  try {
    url = new URL(watchUrl)
  } catch {
    return undefined
  }
  const host = url.hostname.replace(/^www\.|^m\./, '')
  const id =
    host === 'youtube.com'
      ? (url.searchParams.get('v') ?? /^\/live\/([\w-]+)/.exec(url.pathname)?.[1])
      : host === 'youtu.be'
        ? url.pathname.slice(1)
        : undefined
  return id && /^[\w-]+$/.test(id)
    ? `https://studio.youtube.com/video/${id}/livestreaming`
    : undefined
}

/** "YouTube", "Twitch", or "the stream" — for a button that says where it goes. */
export function siteOf(watchUrl: string): string {
  try {
    const host = new URL(watchUrl).hostname.replace(/^www\.|^m\./, '')
    if (host === 'youtube.com' || host === 'youtu.be') return 'YouTube'
    if (host === 'twitch.tv') return 'Twitch'
  } catch {
    // Not a URL; fall through.
  }
  return 'the stream'
}
