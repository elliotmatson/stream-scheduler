import { useState } from 'react'
import type { ReactNode } from 'react'
import { api, type TaggableKind } from './api.ts'

/**
 * Labels on a thing, edited in place.
 *
 * No colour picker, no tag manager, no rename: a tag is its text, and one
 * nobody has put on anything stops existing. Everything here is either
 * typing a word or clicking one off.
 */
export function TagEditor({
  kind,
  id,
  tags,
  onChanged,
}: {
  kind: TaggableKind
  id: string
  tags: string[]
  onChanged: (next: string[]) => void
}): ReactNode {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()

  const save = async (next: string[]): Promise<void> => {
    setBusy(true)
    setProblem(undefined)
    try {
      // What comes back is what was stored — trimmed, de-duplicated and
      // sorted — so the screen never has to guess whether its input
      // survived being tidied.
      const saved = await api.setTags(kind, id, next)
      onChanged(saved.tags)
      setDraft('')
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tag-editor">
      {tags.map((tag) => (
        <span key={tag} className="tag">
          {tag}
          <button
            className="tag-remove"
            aria-label={`Remove ${tag}`}
            title={`Remove ${tag}`}
            disabled={busy}
            onClick={() => void save(tags.filter((kept) => kept !== tag))}
          >
            ×
          </button>
        </span>
      ))}

      {/* Wrapped because the base input rule is a four-`:not()` chain that
          sets every field to full width, and out-specifying it here would
          mean repeating that chain. The wrapper decides the size; the
          input fills it. */}
      <span className="tag-input-wrap">
        <input
          className="tag-input"
          value={draft}
          placeholder="Add a tag"
          aria-label="Add a tag"
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter commits, because that is what every tag field does.
            if (event.key === 'Enter' && draft.trim() !== '') {
              event.preventDefault()
              void save([...tags, draft])
            }
          }}
          onBlur={() => {
            if (draft.trim() !== '') void save([...tags, draft])
          }}
        />
      </span>

      {problem ? <span className="bad">{problem}</span> : null}
    </div>
  )
}

/** Read-only, for a row that is not being edited. */
export function TagList({ tags }: { tags: string[] }): ReactNode {
  if (tags.length === 0) return null
  return (
    <span className="tag-list">
      {tags.map((tag) => (
        <span key={tag} className="tag">
          {tag}
        </span>
      ))}
    </span>
  )
}

/**
 * Narrowing a list: free text, and the tags actually in use.
 *
 * The tag choices come from the server rather than from the rows on
 * screen, so filtering to a tag does not remove the other tags from the
 * control that got you there.
 */
export function FilterBar({
  query,
  onQuery,
  tags,
  chosen,
  onChosen,
  sort,
  sorts,
  onSort,
  count,
  total,
}: {
  query: string
  onQuery: (next: string) => void
  tags: { tag: string; count: number }[]
  chosen: string[]
  onChosen: (next: string[]) => void
  sort: string
  sorts: { id: string; label: string }[]
  onSort: (next: string) => void
  count: number
  total: number
}): ReactNode {
  const toggle = (tag: string): void =>
    onChosen(chosen.includes(tag) ? chosen.filter((kept) => kept !== tag) : [...chosen, tag])

  return (
    <div className="filter-bar">
      <input
        className="filter-search"
        type="search"
        value={query}
        placeholder="Search"
        aria-label="Search"
        onChange={(event) => onQuery(event.target.value)}
      />

      <label className="row" style={{ gap: 6 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          Sort
        </span>
        <select value={sort} onChange={(event) => onSort(event.target.value)}>
          {sorts.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {tags.length > 0 ? (
        <div className="filter-tags">
          {tags.map((entry) => (
            <button
              key={entry.tag}
              className="tag tag-toggle"
              aria-pressed={chosen.includes(entry.tag)}
              title={`${entry.count} tagged "${entry.tag}"`}
              onClick={() => toggle(entry.tag)}
            >
              {entry.tag}
              <span className="muted"> {entry.count}</span>
            </button>
          ))}
          {chosen.length > 0 ? (
            <button className="link" onClick={() => onChosen([])}>
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Only when it is actually hiding something: "12 of 12" on every
          screen is noise that teaches people to stop reading it. */}
      {count !== total ? (
        <span className="muted" style={{ fontSize: 12 }}>
          {count} of {total}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Does this row survive the filter?
 *
 * Tags are AND, not OR: picking "sanctuary" and "deck" means the deck in
 * the sanctuary, which is what somebody narrowing a list is looking for.
 * Text matches the label or any tag, case-insensitively.
 */
export function matches(
  row: { label: string; tags?: string[] },
  query: string,
  chosen: string[],
): boolean {
  const tags = row.tags ?? []
  if (!chosen.every((tag) => tags.some((have) => have.toLowerCase() === tag.toLowerCase()))) {
    return false
  }
  const text = query.trim().toLowerCase()
  if (text === '') return true
  return (
    row.label.toLowerCase().includes(text) || tags.some((tag) => tag.toLowerCase().includes(text))
  )
}
