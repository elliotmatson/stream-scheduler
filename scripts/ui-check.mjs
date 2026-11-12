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
import AxeBuilder from '@axe-core/playwright'
import { chromium } from 'playwright'
import { apiAt, reporter, seed, startHost, startSomething, waitForHealth } from './lib/harness.mjs'

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
      ['one date', () => oneDateOfAnEvent(browser, host.base, ids.sundayId)],
      ['create, skip, delete', () => makeSkipAndRemoveAnEvent(browser, host.base)],
      ['accessibility', () => nothingAxeCallsSerious(browser, host.base)],
      // Last: it sets a password, and every section after it would need one.
      ['sign-in', () => signingIn(browser, host.base)],
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

      // Nothing may scroll sideways at a laptop width, on any screen. Phone
      // width is checked separately, below — that is where this actually
      // goes wrong. Measured per screen: measured once after the loop, it
      // only ever looked at the last one.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      check(`${screen.name} does not overflow sideways in ${theme}`, overflow <= 1, `${overflow}px`)
    }

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

  // The tokens are offered rather than described, so they have to be there
  // and they have to carry the real text: a chip that reads one thing and
  // copies another puts a broken template on a broadcast.
  const tokens = page.locator('.token')
  await tokens.first().waitFor({ timeout: TIMEOUT })
  const offered = await tokens.allInnerTexts()
  check(
    'the template tokens are offered, not just described',
    offered.length >= 7,
    String(offered.length),
  )
  check(
    'each one carries the text it shows',
    offered.every((text) => /^\{\{.+\}\}$/.test(text)),
    offered.find((text) => !/^\{\{.+\}\}$/.test(text)) ?? '',
  )
  check(
    'a plan token is not offered on an event with no plan',
    !offered.some((text) => text.startsWith('{{plan.')),
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

  // A paired event does not run at a time this form decides. Left
  // editable, the date and start read as settings that do nothing.
  await field('Repeats').locator('select').selectOption('plan')
  const firstDate = field('First date').locator('input')
  await firstDate.waitFor({ timeout: TIMEOUT })
  check('a plan supplies the date, and the field says so', await firstDate.isDisabled())
  check('and the start time with it', await field('Start time').locator('input').isDisabled())
  // Length is not dead: a plan time is allowed to have no end, and this is
  // what fills in. Disabling it would take away the only thing that covers
  // that case.
  check('but the length stays editable', await field('Length (min)').locator('input').isEnabled())

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

  // A sticky box parks against the scrollport's *padding* edge rather than
  // its border edge, so `top: 0` on a drawer with 18px of padding left a
  // strip of panel above the head. Content scrolled up through that strip
  // and was clipped by the drawer's own edge, which on screen is a row of
  // labels sliced in half along its length. Nothing in CSS complains about
  // this and no unit test can see it, so it is measured here.
  const headOffset = await drawer.evaluate((panel) => {
    const head = panel.querySelector('.drawer-head')
    panel.scrollTop = 40
    return Math.round(head.getBoundingClientRect().top - panel.getBoundingClientRect().top)
  })
  check(
    'the drawer head covers the top of the panel while it scrolls',
    headOffset === 0,
    `head sits ${headOffset}px below the top of the drawer`,
  )
  if (headOffset !== 0) await shoot(page, 'drawer-head-not-flush')

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

  // Walking the card. The resolver can only ever land on one directory,
  // and a deck serves every mounted card at its root, so the way to the
  // others is through the browser — which lives entirely in the page and
  // is invisible to every other kind of test here.
  await files.getByRole('button', { name: 'Read the media' }).first().click()
  const crumb = files.locator('code').first()
  await crumb.waitFor({ timeout: TIMEOUT })

  const landed = (await crumb.textContent())?.trim() ?? ''
  check(
    'the panel says which directory it is showing',
    landed.startsWith('/') && landed !== '/',
    `showed "${landed}"`,
  )
  if (!landed.startsWith('/')) await shoot(page, 'files-no-breadcrumb')

  const up = files.getByRole('button', { name: /Up/ }).first()
  await up.click()
  await crumb
    .filter({ hasText: /^\/$/ })
    .waitFor({ timeout: TIMEOUT })
    .catch(() => undefined)
  const atRoot = (await crumb.textContent())?.trim() ?? ''
  check('going up reaches the root the deck serves', atRoot === '/', `showed "${atRoot}"`)
  if (atRoot !== '/') await shoot(page, 'files-up-did-not-reach-root')

  // And the root is a list of cards, each of which opens.
  const intoCard = files.locator('tbody button.linkish').first()
  const cardName = (await intoCard.textContent())?.replace(/\s*›\s*$/, '').trim() ?? ''
  await intoCard.click()
  await crumb
    .filter({ hasText: /\/./ })
    .waitFor({ timeout: TIMEOUT })
    .catch(() => undefined)
  const inside = (await crumb.textContent())?.trim() ?? ''
  check(
    'and a card at the root opens into it',
    inside === `/${cardName}`,
    `clicked "${cardName}", showed "${inside}"`,
  )
  if (inside !== `/${cardName}`) await shoot(page, 'files-folder-did-not-open')

  check('files: no console errors', problems.length === 0, problems.slice(0, 3).join(' | '))
  await context.close()
}

/**
 * One date of a repeating event, and changing only that one.
 *
 * The bug this page exists to prevent: sending every box on save pinned
 * the untouched templates to today's values, and later changes to the
 * event then never reached this date. So the check is on what the server
 * kept, not on what the page shows.
 */
async function oneDateOfAnEvent(browser, base, seriesId) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const problems = []
  watch(page, problems, 'one date')

  const from = Date.now()
  const occurrences = await apiAt(
    base,
    'GET',
    `/api/occurrences?from=${from}&to=${from + 60 * 86_400_000}`,
  )
  const one = occurrences.find((o) => o.seriesId === seriesId && o.status === 'pending')
  check('there is a Sunday to open', Boolean(one))
  if (!one) return

  await page.goto(`${base}/#/occurrences/${one.id}`)
  await page.locator('h1', { hasText: 'Sunday // Anderson' }).waitFor({ timeout: TIMEOUT })
  check('the date opens on its own page', true)

  const outputs = page.locator('.card', { has: page.locator('h2:text-is("What goes out")') })
  await outputs.waitFor({ timeout: TIMEOUT })
  const listed = await outputs.innerText()
  check(
    'it lists what goes out that morning',
    listed.includes('9:00') && listed.includes('Archive'),
    listed.slice(0, 120),
  )

  const called = page
    .locator('label.field', { has: page.locator('span.field-label:text-is("Called")') })
    .locator('input')
  await called.fill('Easter Sunday')
  await page.getByRole('button', { name: 'Save just this one' }).click()
  await page.locator('h1', { hasText: 'Easter Sunday' }).waitFor({ timeout: TIMEOUT })
  check('a rename shows straight away', true)

  const saved = await apiAt(base, 'GET', `/api/occurrences/${one.id}`)
  check('the new name is kept', saved.overrides.label === 'Easter Sunday')
  check(
    'and nothing else was pinned to this date',
    saved.overrides.templates === undefined,
    JSON.stringify(saved.overrides),
  )

  check('one date: no console errors', problems.length === 0, problems.slice(0, 3).join(' | '))
  if (problems.length > 0) await shoot(page, 'one-date')
  await context.close()
}

/**
 * The whole of an event's life, through the page rather than the API.
 *
 * Everything else here looks; this is the one place that changes things,
 * on the throwaway instance the check runs against. It makes an event with
 * its stream in one go, skips its date, and removes it.
 */
async function makeSkipAndRemoveAnEvent(browser, base) {
  const NAME = 'UI check event'
  const context = await browser.newContext()
  const page = await context.newPage()
  const problems = []
  watch(page, problems, 'create')
  const field = (label) =>
    page.locator('label.field', { has: page.locator(`span.field-label:text-is("${label}")`) })

  await page.goto(`${base}/#/events`)
  await page.getByRole('button', { name: 'Add an event' }).click()
  await field('Name').first().locator('input').fill(NAME)

  // The stream goes in before the event exists.
  await page.getByRole('button', { name: 'Add a stream' }).click()
  await field('Name').last().locator('input').fill('Main')
  await field('Streams to').locator('select').selectOption({ index: 1 })
  await field('Runs on').locator('select').selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  const create = page.getByRole('button', { name: 'Create with 1 output' })
  await create.waitFor({ timeout: TIMEOUT })
  check('Create says what it is about to make', true)
  await create.click()
  // Saving keeps the form open on the new event, so its outputs can still
  // be changed; the list catches up once it is closed.
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  const card = page.locator('.card', { has: page.locator('h2', { hasText: NAME }) })
  await card.first().waitFor({ timeout: TIMEOUT })
  const series = (await apiAt(base, 'GET', '/api/series')).find((s) => s.label === NAME)
  const outputs = series ? await apiAt(base, 'GET', `/api/series/${series.id}/outputs`) : []
  const outputList = Array.isArray(outputs) ? outputs : (outputs.outputs ?? [])
  check('the event and its stream were made together', outputList.length === 1)
  if (!series) return

  // Skipping its one date, from the schedule's list.
  await page.goto(`${base}/#/schedule`)
  await page.getByRole('button', { name: 'List', exact: true }).click()
  const row = page.locator('tr', { hasText: NAME }).first()
  await row.waitFor({ timeout: TIMEOUT })
  await row.getByRole('button', { name: 'Skip', exact: true }).click()
  await row
    .getByRole('button', { name: 'Skip', exact: true })
    .waitFor({ state: 'detached', timeout: TIMEOUT })
  const from = Date.now() - 86_400_000
  const dates = await apiAt(
    base,
    'GET',
    `/api/occurrences?from=${from}&to=${from + 40 * 86_400_000}`,
  )
  const mine = dates.filter((o) => o.seriesId === series.id)
  check(
    'skipping leaves that date skipped',
    mine.length > 0 && mine.every((o) => o.status === 'skipped'),
    mine.map((o) => o.status).join(', '),
  )

  // And removing it, which asks first.
  await page.goto(`${base}/#/events`)
  const remove = card.first().getByRole('button', { name: 'Remove' })
  await remove.click()
  await card
    .first()
    .getByRole('button', { name: /^Remove it/ })
    .click()
  await card.first().waitFor({ state: 'detached', timeout: TIMEOUT })
  const left = (await apiAt(base, 'GET', '/api/series')).some((s) => s.label === NAME)
  check('removing it removes it', !left)

  check('create: no console errors', problems.length === 0, problems.slice(0, 3).join(' | '))
  if (problems.length > 0) await shoot(page, 'create-skip-remove')
  await context.close()
}

/**
 * Every screen through axe, in both themes.
 *
 * Only what axe calls serious or critical fails the check: missing names
 * on controls, contrast too low to read, and the like. Each failure names
 * the rule and the first element, so it can be found without rerunning.
 */
async function nothingAxeCallsSerious(browser, base) {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: theme,
      // A link fading between colours on a route change reads as low
      // contrast to axe. Reduced motion makes the fade instant.
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    for (const screen of SCREENS) {
      await page.goto(`${base}/#${screen.route}`)
      await page.locator(screen.sees).first().waitFor({ timeout: TIMEOUT })
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
      const serious = violations.filter((v) => ['serious', 'critical'].includes(v.impact))
      check(
        `${screen.name} passes axe in ${theme}`,
        serious.length === 0,
        serious
          .map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target.join(' ')}`)
          .join(' | '),
      )
      if (serious.length > 0) await shoot(page, `axe-${screen.name}-${theme}`)
    }
    await context.close()
  }
}

/**
 * The sign-in screen, once a password is set.
 *
 * A wrong password has to say so, and the right one has to land on the
 * app — the only screen nobody can work around if it breaks.
 */
async function signingIn(browser, base) {
  const PASSWORD = 'ui-check-password'
  await apiAt(base, 'POST', '/api/password', { password: PASSWORD })

  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.goto(`${base}/#/`)
  const password = page.locator('input[type="password"]')
  await password.waitFor({ timeout: TIMEOUT })
  check('a password shows the sign-in screen', true)

  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  const serious = violations.filter((v) => ['serious', 'critical'].includes(v.impact))
  check('the sign-in screen passes axe', serious.length === 0, serious.map((v) => v.id).join(', '))

  await password.fill('not-the-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('alert').waitFor({ timeout: TIMEOUT })
  check('a wrong password says so', true)

  await password.fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.locator('h1:text-is("Now")').waitFor({ timeout: TIMEOUT })
  check('the right one lands on the app', true)
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
