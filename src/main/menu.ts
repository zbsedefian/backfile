/**
 * The application menu.
 *
 * Electron ships a bare default menu with nothing app-specific in it, which is
 * why File appeared empty. Everything the toolbar can do is mirrored here, both
 * because that is where macOS users look for it and because it is the only way
 * these actions get discoverable keyboard shortcuts.
 *
 * Menu items do not act directly: they post a named action to the renderer,
 * which owns the state needed to carry it out.
 */

import { app, BrowserWindow, Menu, MenuItemConstructorOptions, shell } from 'electron'
import type { TimestampMode } from './evidence/timestamp'

export type MenuAction =
  | 'open-workspace'
  | 'add-article'
  | 'publish'
  | 'capture-all-archive'
  | 'capture-all-local'
  | 'stop-capture'
  | 'reveal-article'
  | 'focus-search'
  | 'toggle-sidebar'
  | 'toggle-detail'
  | 'toggle-browser'
  | 'theme-system'
  | 'theme-light'
  | 'theme-dark'
  | 'video-cookies-off'
  | 'video-cookies-chrome'
  | 'video-cookies-safari'
  | 'video-cookies-firefox'
  | 'video-cookies-edge'
  | 'video-cookies-brave'
  | 'evidence-refresh-manifest'
  | 'evidence-verify'
  | 'evidence-timestamp-off'
  | 'evidence-timestamp-opentimestamps'
  | 'evidence-timestamp-rfc3161'
  | 'evidence-configure-tsa'
  | 'support-email'

const DONATE_URL = 'https://buymeacoffee.com/zacharysedefian'
const SOURCE_URL = 'https://github.com/zbsedefian/backfile'

function send(action: MenuAction): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send('menu:action', action)
}

function item(
  label: string,
  action: MenuAction,
  accelerator?: string
): MenuItemConstructorOptions {
  return { label, accelerator, click: () => send(action) }
}

/**
 * Build (or rebuild) the application menu.
 *
 * Takes the current Video Cookies choice so its submenu can show a radio dot
 * on the active entry — a settings submenu with no visible state reads as six
 * commands rather than one choice, and the only way to learn which browser
 * was active would be trial and error. Electron menus are static once set, so
 * the caller rebuilds whenever the choice changes.
 */
export function buildMenu(
  videoCookiesBrowser: string | null = null,
  timestampMode: TimestampMode = 'off'
): void {
  const isMac = process.platform === 'darwin'

  const cookieChoice = (
    label: string,
    action: MenuAction,
    value: string | null
  ): MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: videoCookiesBrowser === value,
    click: () => send(action)
  })

  const timestampChoice = (
    label: string,
    action: MenuAction,
    value: TimestampMode
  ): MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: timestampMode === value,
    click: () => send(action)
  })

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              item('Email Support…', 'support-email'),
              {
                label: 'Donate…',
                click: () => shell.openExternal(DONATE_URL)
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : []),

    {
      label: 'File',
      submenu: [
        item('Open Projects Folder…', 'open-workspace', 'CmdOrCtrl+O'),
        { type: 'separator' },
        // Not Cmd+R: the View menu's reload role already claims that, and two
        // items with one accelerator means one of them silently loses it.
        item('Add Article…', 'add-article', 'CmdOrCtrl+I'),
        item('Export Archived Copy…', 'publish', 'CmdOrCtrl+Shift+P'),
        { type: 'separator' },
        item('Reveal Article in Folder', 'reveal-article', 'CmdOrCtrl+Shift+O'),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },

    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('Find in Sources', 'focus-search', 'CmdOrCtrl+F')
      ]
    },

    {
      label: 'Capture',
      submenu: [
        item('Capture All to archive.is', 'capture-all-archive', 'CmdOrCtrl+Shift+A'),
        item('Download All Local Copies', 'capture-all-local', 'CmdOrCtrl+Shift+D'),
        { type: 'separator' },
        item('Stop Capturing', 'stop-capture', 'CmdOrCtrl+.'),
        { type: 'separator' },
        {
          // Off by default and its own submenu rather than a checkbox: this is
          // the one setting that reads a real, logged-in browser session, and
          // it exists only for the age-gated or sign-in-required video that
          // cannot be fetched anonymously at all. Everything else in Backfile
          // stays account-free.
          label: 'Video Cookies',
          submenu: [
            cookieChoice('Off (age-gated videos will fail)', 'video-cookies-off', null),
            { type: 'separator' },
            cookieChoice('Chrome', 'video-cookies-chrome', 'chrome'),
            cookieChoice('Safari', 'video-cookies-safari', 'safari'),
            cookieChoice('Firefox', 'video-cookies-firefox', 'firefox'),
            cookieChoice('Edge', 'video-cookies-edge', 'edge'),
            cookieChoice('Brave', 'video-cookies-brave', 'brave')
          ]
        }
      ]
    },

    {
      label: 'Evidence',
      submenu: [
        item('Update Manifest', 'evidence-refresh-manifest'),
        item('Verify Captures', 'evidence-verify'),
        { type: 'separator' },
        {
          // Off by default, like Video Cookies: this is the one other feature
          // that makes a network request per capture, and turning it on
          // should be a decision someone made. See evidence/timestamp.ts.
          label: 'Timestamping',
          submenu: [
            timestampChoice('Off', 'evidence-timestamp-off', 'off'),
            { type: 'separator' },
            timestampChoice(
              'OpenTimestamps (free, anchored in Bitcoin)',
              'evidence-timestamp-opentimestamps',
              'opentimestamps'
            ),
            timestampChoice('RFC 3161 authority…', 'evidence-timestamp-rfc3161', 'rfc3161'),
            { type: 'separator' },
            item('Configure RFC 3161 Authority URL…', 'evidence-configure-tsa')
          ]
        }
      ]
    },

    {
      label: 'View',
      submenu: [
        item('Toggle Projects Panel', 'toggle-sidebar', 'CmdOrCtrl+1'),
        item('Toggle Detail Panel', 'toggle-detail', 'CmdOrCtrl+2'),
        item('Toggle Browser Pane', 'toggle-browser', 'CmdOrCtrl+3'),
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: [
            item('Match System', 'theme-system'),
            item('Light', 'theme-light'),
            item('Dark', 'theme-dark')
          ]
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' }
      ]
    },

    {
      label: 'Window',
      submenu: isMac
        ? [
            { role: 'minimize' },
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'front' }
          ]
        : [{ role: 'minimize' }, { role: 'close' }]
    },

    {
      role: 'help',
      submenu: [
        {
          label: 'Backfile on GitHub',
          click: () => shell.openExternal(SOURCE_URL)
        },
        item('Email Support…', 'support-email'),
        { type: 'separator' },
        {
          label: 'Donate…',
          click: () => shell.openExternal(DONATE_URL)
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
