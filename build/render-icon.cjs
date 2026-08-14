/**
 * Render build/icon.svg to build/icon.png at 1024x1024.
 *
 * Uses the Chromium that Electron already ships rather than adding an image
 * dependency for a file that changes about once a year. electron-builder
 * derives the .icns and .ico from this PNG.
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SIZE = 1024
const OUT = path.join(__dirname, 'icon.png')

// Never let a headless render wedge a build; fail loudly instead.
const bail = setTimeout(() => {
  console.error('render timed out')
  process.exit(1)
}, 45000)

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8')
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    webPreferences: { backgroundThrottling: false }
  })

  const html =
    '<html><body style="margin:0;padding:0;background:transparent;overflow:hidden">' +
    svg +
    '</body></html>'
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 800))

  const image = await win.webContents.capturePage()
  fs.writeFileSync(OUT, image.toPNG())
  console.log('wrote build/icon.png', JSON.stringify(image.getSize()))

  clearTimeout(bail)
  win.destroy()
  app.exit(0)
})
