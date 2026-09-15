#!/usr/bin/env node
/**
 * Loads the built app in a real browser and drives it.
 *
 * Typecheck catches type errors and the smoke test drives the API, but
 * nothing else asks for a page. A React runtime error, a screen that renders
 * blank, or a style rule that quietly stops matching all pass CI otherwise.
 *
 * Two bugs during development were only ever caught this way:
 *
 *  - Form fields were selected as `input[type='text']`, which does not match
 *    an `<input>` with no `type` attribute — and most of this app's text
 *    fields have none. Those fields silently fell back to the browser's own
 *    chrome, a grey bar ignoring the theme.
 *  - The weekday chips on the event form were seeded at mount and never
 *    followed the chosen first date, so picking Sunday and then "Every week"
 *    scheduled Tuesdays.
 *
 * Neither is the kind of thing that stays fixed on its own.
 *
 * Every wait here is an assertion about the page, never a sleep. A suite
 * built on fixed delays is one that goes flaky and then gets switched off.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { reporter, seed, startHost, startSomething, waitForHealth } from './lib/harness.mjs'

const PORT = Number(process.env.UI_CHECK_PORT ?? 8598)
/** A browser Playwright did not install itself — a system Chromium, or one
 *  a sandbox already has. CI installs its own and leaves this unset. */
const BROWSER = process.env.UI_CHECK_BROWSER
const ARTIFACTS = process.env.UI_CHECK_ARTIFACTS ?? 'ui-check-artifacts'
const TIMEOUT = 15_000

const tally = reporter()
const check = (name, condition, detail = '') => tally.check(name, condition, detail)

/** Every screen, and something to see on each that is not just "no error". */
const SCREENS = [
  { route: '/', name: 'Now', sees: 'h1:text-is("Now")' },
  { route: '/schedule', name: 'Schedule', sees: '.calendar' },
  { route: '/events', name: 'Events', sees: 'h1:text-is("Events")' },
  { route: '/devices', name: 'Devices', sees: 'h1:text-is("Devices")' },
  { route: '/services', name: 'Services', sees: 'h1:text-is("Services")' },
  { route: '/runs', name: 'Runs', sees: 'h1:text-is("Runs")' },
  { route: '/notifications', name: 'Notifications', sees: 'h1:text-is("Notifications")' },
  { route: '/settings', name: 'Settings', sees: 'h1:text-is("Settings")' },
]

/**
 * Failures the page is entitled to produce.
 *
 * Signing in with the wrong password is a 401 by design, and the browser
 * logs every failed fetch. Allowing it by URL keeps the check strict about
 * everything else.
 */
const ALLOWED_FAILURES = [/\/api\/login/]

function watch(page, problems, where) {
  page.on('pageerror', (error) => problems.push(`${where}: ${String(error)}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (ALLOWED_FAILURES.some((allowed) => allowed.test(text))) return
    problems.push(`${where}: console ${text}`)
  })
  page.on('response', (response) => {
    if (response.status() < 400) return
    if (ALLOWED_FAILURES.some((allowed) => allowed.test(response.url()))) return
    problems.push(`${where}: ${response.status()} from ${response.url()}`)
  })
}

async function main() {
  const host = startHost({ port: PORT })
  let browser
  try {
    await waitForHealth(host)
    const ids = await seed(host.base)
    const started = await startSomething(host.base)
    check('the app boots and seeds', Boolean(ids.sundayId && started.runId))

    browser = await chromium.launch(BROWSER ? { executablePath: BROWSER } : {})

    // Each section stands alone: one broken screen should not hide the
    // state of every screen after it.
    for (const [name, run] of [
      ['screens', () => everyScreenRenders(browser, host.base)],
      ['theme', () => themeBehaves(browser, host.base)],
      ['form fields', () => formFieldsAreStyled(browser, host.base)],
      ['forms', () => discoveryAndPreview(browser, host.base)],
      ['run timeline', () => theRunTimeline(browser, host.base, started.runId)],
      ['file browser', () => theFileBrowser(browser, host.base)],
      ['device list', () => theDeviceList(browser, host.base)],
      ['phone', () => nothingOverflowsOnAPhone(browser, host.base)],
    ]) {
      try {
        await run()
      } catch (error) {
        tally.fail(`${name}: ${String(error).split('\n')[0]}`)
      }
    }
  } catch (error) {
    tally.fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.stdout.write(host.output())
  } finally {
    await browser?.close().catch(() => undefined)
    host.stop()
  }
}

/** Every screen, in both themes, with nothing in the console. */
async function everyScreenRenders(browser, base) {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: theme,
    })
    const page = await context.newPage()
    const problems = []
    watch(page, problems, theme)

    for (const screen of SCREENS) {
      try {
        await page.goto(`${base}/#${screen.route}`)
        await page.locator(screen.sees).first().waitFor({ timeout: TIMEOUT })
        check(`${screen.name} renders in ${theme}`, true)
      } catch (error) {
        check(`${screen.name} renders in ${theme}`, false, String(error).split('\n')[0])
        await shoot(page, `${screen.name}-${theme}`)
      }
    }

    // Nothing may scroll sideways at a laptop width. Phone width is
    // checked separately, below — that is where this actually goes wrong.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    check(`nothing overflows sideways in ${theme}`, overflow <= 1, `${overflow}px`)

    check(`${theme}: no console errors`, problems.length === 0, problems.slice(0, 3).join(' | '))
    if (problems.length > 0) await shoot(page, `console-${theme}`)
    await context.close()
  }
}

/**
 * The theme control.
 *
 * Worth this much detail because it is stored, read before first paint, and
 * has three states — every one of which has been wrong at some point.
 */
async function themeBehaves(browser, base) {
  const applied = (page) =>
    page.evaluate(() => ({
      attribute: document.documentElement.dataset.theme ?? null,
      dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
      background: getComputedStyle(document.body).backgroundColor,
    }))

  // A fresh install follows the OS and writes nothing down.
  const fresh = await browser.newContext({ colorScheme: 'dark' })
  const first = await fresh.newPage()
  await first.goto(`${base}/#/`)
  await first.locator('h1:text-is("Now")').waitFor({ timeout: TIMEOUT })
  const untouched = await applied(first)
  const stored = await first.evaluate(() => window.localStorage.getItem('scheduler.theme'))
  check('a fresh install follows the system', untouched.attribute === null && untouched.dark)
  check('a fresh install writes no preference', stored === null, String(stored))

  // An explicit choice sticks, and is applied before the first paint — a
  // theme applied after React mounts is a flash of the wrong one.
  await first.getByRole('button', { name: 'Light' }).click()
  await first.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  const lightBackground = (await applied(first)).background
  await first.reload()
  await first.locator('h1:text-is("Now")').waitFor({ timeout: TIMEOUT })
  const afterReload = await applied(first)
  check('an explicit choice survives a reload', afterReload.attribute === 'light')
  check('and is applied before first paint', afterReload.background === lightBackground)

  // The OS changing mid-session is followed only while on "system".
  await first.emulateMedia({ colorScheme: 'light' })
  check('a pinned theme ignores the system', (await applied(first)).attribute === 'light')

  await first.getByRole('button', { name: 'Match the system setting' }).click()
  await first.waitForFunction(() => document.documentElement.dataset.theme === undefined)
  await first.emulateMedia({ colorScheme: 'dark' })
  await first
    .waitForFunction(() => getComputedStyle(document.body).backgroundColor !== 'rgb(255, 255, 255)')
    .catch(() => undefined)
  const followed = await applied(first)
  check('"system" hands control back to the OS', followed.attribute === null && followed.dark)

  await fresh.close()
}

/**
 * No form field left on the browser's own chrome.
 *
 * The exact regression: `input[type='text']` does not match an `<input>`
 * with no type attribute, and most of this app's text fields have none. In
 * dark mode those fields were grey bars ignoring the theme entirely.
 */
async function formFieldsAreStyled(browser, base) {
  const context = await browser.newContext({ colorScheme: 'dark' })
  const page = await context.newPage()
  await page.goto(`${base}/#/devices`)
  await page.getByRole('button', { name: 'Add a device' }).click()
  await page.locator('.card input').first().waitFor({ timeout: TIMEOUT })

  const unstyled = await page.evaluate(() => {
    // What the app says a field should look like. Comparing against this
    // rather than against a guess at the browser's default is the whole
    // point: the browser's default is a moving target, and in a dark
    // `color-scheme` it is a dark grey that no naive "is it white" test
    // would catch — which is how this regression shipped in the first place.
    const expected = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()
    const probe = document.createElement('div')
    probe.style.backgroundColor = expected
    document.body.appendChild(probe)
    const wanted = getComputedStyle(probe).backgroundColor
    probe.remove()

    const out = []
    for (const field of document.querySelectorAll('input, select, textarea')) {
      if (['checkbox', 'radio', 'range', 'file'].includes(field.type)) continue
      const style = getComputedStyle(field)
      if (style.backgroundColor !== wanted) {
        out.push(
          `${field.tagName.toLowerCase()}${field.type ? `[type=${field.type}]` : ''} is ${style.backgroundColor}, wanted ${wanted}`,
        )
      }
    }
    return out
  })
  check('every form field is styled by the app', unstyled.length === 0, unstyled.join(', '))
  if (unstyled.length > 0) await shoot(page, 'unstyled-fields')
  await context.close()
}

/** Device discovery, and the event form's preview of what it would produce. */
async function discoveryAndPreview(browser, base) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const problems = []
  watch(page, problems, 'forms')

  await page.goto(`${base}/#/devices`)
  await page.getByRole('button', { name: 'Add a device' }).click()
  // Only a plugin that can discover offers the button, and the form opens on
  // whichever plugin is first.
  await page
    .locator('label.field', { has: page.locator('span.field-label:text-is("Type")') })
    .first()
    .locator('select')
    .selectOption('mock')
  await page.getByRole('button', { name: 'Scan the network' }).click()
  await page.locator('.discovered li').first().waitFor({ timeout: TIMEOUT })
  check('discovery lists what it found', (await page.locator('.discovered li').count()) > 0)

  await page.goto(`${base}/#/events`)
  await page.getByRole('button', { name: 'Add an event' }).click()
  const field = (label) =>
    page
      .locator('label.field', { has: page.locator(`span.field-label:text-is("${label}")`) })
      .first()

  await field('Name').locator('input').fill('Sunday Service')
  await field('First date').locator('input').fill('2026-09-20')
  await field('Start time').locator('input').fill('09:30')
  await field('Repeats').locator('select').selectOption('weekly')

  // The weekday chip regression: picking a Sunday first date and then
  // "every week" must select Sunday, not whatever the form opened on.
  const sunday = page.getByRole('button', { name: 'Sun', exact: true })
  await sunday.waitFor({ timeout: TIMEOUT })
  check(
    'the weekday follows the first date',
    (await sunday.getAttribute('aria-pressed')) === 'true',
  )

  await field('Broadcast title').locator('input').fill('{{event.name}} — {{date "MMMM d"}}')
  await page.locator('.preview-list li').first().waitFor({ timeout: TIMEOUT })
  check(
    'the preview renders a typed template',
    (await page.locator('.preview-list').innerText()).includes('Sunday Service —'),
  )

  await field('Broadcast title').locator('input').fill('{{event.name}} — {{dat "MMMM d"}}')
  await page.locator('.preview-list li', { hasText: 'dat' }).first().waitFor({ timeout: TIMEOUT })
  check('a bad token is flagged while typing', true)

  check('forms: no console errors', problems.length === 0, problems.slice(0, 3).join(' | '))
  await context.close()
}

/** The run's own page: the detailed view, with its charts. */
async function theRunTimeline(browser, base, runId) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const problems = []
  watch(page, problems, 'timeline')

  await page.goto(`${base}/#/runs/${runId}`)
  await page.locator('.step').first().waitFor({ timeout: TIMEOUT })
  check('the run timeline renders its steps', (await page.locator('.step').count()) > 0)

  // The outputs' own cards, which carry the numbers and the charts.
  const cards = await page.locator('.card h2').count()
  check('each output has a card of its own', cards > 0, `${cards} cards`)

  check('timeline: no console errors', problems.length === 0, problems.slice(0, 3).join(' | '))
  if (problems.length > 0) await shoot(page, 'timeline')
  await context.close()
}

/**
 * Every screen on a phone, which is where somebody checks on a Sunday.
 *
 * There was already an overflow check and it ran at 1280px, where nothing
 * has ever overflowed. The device rows on the status screen pushed the page
 * 309px wider than a 390px phone — a flex row of facts with no way to wrap
 * — and it reached a real install before anybody saw it.
 *
 * Reported per screen rather than as one number, because "something
 * overflows" without saying where is a bug report you have to redo.
 */
async function nothingOverflowsOnAPhone(browser, base) {
  // An iPhone in portrait, which is what is in somebody's hand.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const problems = []
  watch(page, problems, 'phone')

  for (const screen of SCREENS) {
    await page.goto(`${base}/#${screen.route}`)
    await page.locator(screen.sees).first().waitFor({ timeout: TIMEOUT })

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    // Name the widest offender, so a failure says what to look at.
    const worst = await page.evaluate(() => {
      const width = document.documentElement.clientWidth
      const out = [...document.querySelectorAll('*')]
        .map((el) => ({ el, right: el.getBoundingClientRect().right }))
        .filter((entry) => entry.right > width + 1)
        .sort((a, b) => b.right - a.right)[0]
      if (!out) return ''
      const name = out.el.className ? `.${String(out.el.className).split(' ')[0]}` : ''
      return `${out.el.tagName.toLowerCase()}${name} reaches ${Math.round(out.right)}px`
    })

    check(`${screen.name} fits a phone`, overflow <= 1, `${overflow}px over — ${worst}`)
    if (overflow > 1) await shoot(page, `overflow-${screen.name}`)
  }

  check('phone: no console errors', problems.length === 0, problems.slice(0, 3).join(' | '))
  await context.close()
}

/**
 * The device list, which is read by scanning down it.
 *
 * The status pill sizes itself to its word, and "disconnected" is half
 * again as wide as "connected" — so without a fixed column the names sat
 * on a ragged edge the eye has to re-find on every row. A CSS rule is the
 * only thing holding that, and CSS rules stop matching quietly.
 */
async function theDeviceList(browser, base) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const problems = []
  watch(page, problems, 'device list')

  await page.goto(`${base}/#/devices`)
  await page.locator('.device-row-item').first().waitFor({ timeout: TIMEOUT })

  const lefts = await page
    .locator('.device-row-item .device-row-name')
    .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)))
  check(
    'device names line up whatever the status says',
    new Set(lefts).size === 1,
    lefts.join(', '),
  )
  if (new Set(lefts).size !== 1) await shoot(page, 'device-names-ragged')

  // The drawer opens on what is wrong, not on an input nobody came for.
  await page.locator('.device-row-item', { hasText: 'Chapel encoder' }).first().click()
  const drawer = page.locator('aside.drawer')
  await drawer.waitFor({ timeout: TIMEOUT })
  const banner = drawer.locator('.banner.error').first()
  const tags = drawer.locator('.field-label:text-is("Tags")').first()
  await banner.waitFor({ timeout: TIMEOUT }).catch(() => undefined)
  const bannerTop = await banner.evaluate((n) => n.getBoundingClientRect().top).catch(() => -1)
  const tagsTop = await tags.evaluate((n) => n.getBoundingClientRect().top).catch(() => -1)
  check(
    'the drawer leads with the failure, not the tag box',
    bannerTop > 0 && tagsTop > bannerTop,
    `banner ${bannerTop}, tags ${tagsTop}`,
  )

  check('device list: no console errors', problems.length === 0, problems.slice(0, 3).join(' | '))
  await context.close()
}

/**
 * The file browser on a recorder, on a page nobody has touched yet.
 *
 * The regression: the card picker came from the live channel alone, which
 * only carries states a device has pushed since the page opened. A deck
 * sitting still pushes nothing, so on a fresh load there were no slots and
 * the picker was hidden — it appeared only once something else made the
 * deck emit, which from the outside looks like the picker turning up after
 * you change slots somewhere else entirely.
 *
 * So this check is deliberately cold: load, open, look. Touching anything
 * that moves the deck first would hide the bug.
 */
async function theFileBrowser(browser, base) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const problems = []
  watch(page, problems, 'files')

  await page.goto(`${base}/#/devices`)
  await page.locator('.device-row-item', { hasText: 'HyperDeck — archive' }).first().click()
  const drawer = page.locator('aside.drawer')
  await drawer.waitFor({ timeout: TIMEOUT })

  const files = drawer.locator('.card', { has: page.locator('h2:text-is("Files")') }).first()
  await files.waitFor({ timeout: TIMEOUT })

  const picker = files.locator('select').first()
  await picker.waitFor({ timeout: TIMEOUT }).catch(() => undefined)
  const offered = await picker.count()
  check('the card picker is there before anything has moved', offered === 1)
  if (offered !== 1) await shoot(page, 'files-no-slot-picker')

  if (offered === 1) {
    const names = await picker.locator('option').allInnerTexts()
    check('and it offers every card the deck has', names.length === 2, names.join(', '))
  }

  check('files: no console errors', problems.length === 0, problems.slice(0, 3).join(' | '))
  await context.close()
}

/** A picture of whatever just failed. A CI-only failure with no artifact is
 *  close to undebuggable. */
async function shoot(page, name) {
  try {
    mkdirSync(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), fullPage: true })
  } catch {
    // A screenshot that cannot be taken must not replace the real failure.
  }
}

await main()

process.stdout.write(
  tally.failures === 0
    ? '\nui-check: all checks passed\n'
    : `\nui-check: ${tally.failures} check(s) failed\n`,
)
process.exit(tally.failures === 0 ? 0 : 1)
