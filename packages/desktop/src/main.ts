import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from 'electron'
import { Application, createServer, isOnAir } from '@scheduler/core'
import { mockPlugin } from '@scheduler/plugin-mock'
import { safeStorageKeySource } from './key-source.js'

/**
 * The desktop shell.
 *
 * Deliberately thin: it constructs the same `Application` the headless
 * entrypoint does and adds a tray icon, a window, and the quit guard. All the
 * real UI is the web UI, so there is one interface to build and test.
 */

const PORT = Number(process.env.SCHEDULER_PORT ?? 8500)
const HOST = '127.0.0.1'
const here = dirname(fileURLToPath(import.meta.url))

let scheduler: Application | undefined
let stopServer: (() => Promise<void>) | undefined
let tray: Tray | undefined
let window: BrowserWindow | undefined
let quitting = false

async function boot(): Promise<void> {
  const configDir = app.getPath('userData')

  scheduler = Application.create({
    configDir,
    plugins: [mockPlugin()],
    // Honoured here too, though a desktop install listening on loopback
    // rarely wants one.
    uiPassword: process.env.SCHEDULER_UI_PASSWORD,
    // The OS keychain first, so a desktop user never has to think about a
    // master secret; the file and env sources in core remain the fallback.
    keySources: [safeStorageKeySource(configDir)],
  })

  const server = await createServer({
    app: scheduler,
    port: PORT,
    host: HOST,
    webRoot: join(here, '..', 'web'),
  })
  await scheduler.start()
  await server.listen({ port: PORT, host: HOST })
  stopServer = () => server.close()
}

function url(): string {
  return `http://${HOST}:${PORT}`
}

function openWindow(): void {
  if (window && !window.isDestroyed()) {
    window.show()
    window.focus()
    return
  }
  window = new BrowserWindow({
    width: 1180,
    height: 780,
    title: 'Stream Scheduler',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  void window.loadURL(url())

  // Closing the window leaves the scheduler running in the tray. A closed
  // window must never stop a broadcast.
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    window?.hide()
  })
}

function buildTray(): void {
  // An empty image still yields a usable tray entry on every platform; a real
  // icon is dropped in at packaging time.
  tray = new Tray(nativeImage.createEmpty())
  tray.setToolTip('Stream Scheduler')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Stream Scheduler', click: () => openWindow() },
      { label: 'Open in browser', click: () => void shell.openExternal(url()) },
      { type: 'separator' },
      {
        label: 'Start at login',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => void requestQuit() },
    ]),
  )
  tray.on('click', () => openWindow())
}

/** Quitting mid-broadcast needs a confirmation, not a silent stop. */
async function requestQuit(): Promise<void> {
  // Every run inside its window, whether or not an output happens to be on
  // air this minute: quitting at 10:30 on a Sunday abandons the 11:00
  // service just as surely as it abandons the 9:00 one.
  const live = scheduler?.store.listActiveRuns().filter((run) => isOnAir(run.state)) ?? []

  if (live.length > 0) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Keep running', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      message: live.length === 1 ? 'An event is running.' : `${live.length} events are running.`,
      detail:
        'Quitting stops the scheduler. Encoders already streaming will keep going, but nothing will stop them ' +
        'at the scheduled time.',
    })
    if (response === 0) return
  }

  quitting = true
  await stopServer?.()
  await scheduler?.stop()
  app.quit()
}

// One instance only: two schedulers against one config directory would fight
// over the same runs and the same hardware.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => openWindow())

  app.whenReady().then(
    async () => {
      try {
        await boot()
      } catch (error) {
        dialog.showErrorBox(
          'Stream Scheduler could not start',
          error instanceof Error ? error.message : String(error),
        )
        app.quit()
        return
      }
      buildTray()
      openWindow()
    },
    (error: unknown) => {
      dialog.showErrorBox('Stream Scheduler could not start', String(error))
      app.quit()
    },
  )

  // The tray app outlives its window on every platform: closing the window is
  // not a request to stop the scheduler.
  app.on('window-all-closed', () => {})
  app.on('before-quit', () => {
    quitting = true
  })
}
