# Backfile

An offline desktop workspace for journalists to extract, archive, and track every source cited in an article — so the links in your published work still resolve in ten years.

Nearly 40% of links cited in 2013 news articles now lead nowhere. Backfile is built around that problem.

## What it does

Point Backfile at the folder where you keep your article folders. For any article it will:

1. **Analyze links** — read every draft in the folder and pull out each external URL with the text it was cited as. Supported inputs:
   - `.docx` — including **footnotes and endnotes**, where most citations actually live
   - `.odt` and `.html` — the formats **Google Docs** exports
   - `.txt` / `.md` — plain link lists, including the `URL === SNAPSHOT` convention, so snapshots you captured by hand import as finished work
2. **Track archival status** at a glance, per source:
   - ○ &nbsp;not archived
   - ★ bronze — local copy only
   - ★ silver — archive.is snapshot secured
   - ★ gold — archive.is + Wayback + local copy
3. **Capture**, one click per source per service.
4. **Keep everything with the article.** Local captures are written to an `archive/` subfolder inside the article's own folder, and the record lives in `sources.csv` right next to your drafts.

## sources.csv is the source of truth

Backfile has no hidden database. Each article folder gets a `sources.csv`:

| status | url | anchor_text | archive_is | wayback | local_path | captured_at | found_in | excluded | excluded_reason | notes |
|---|---|---|---|---|---|---|---|---|---|---|

It opens in Excel, diffs cleanly in git, and remains completely readable if you ever uninstall this app.

## Design decisions worth knowing

**archive.is captures are human-driven.** archive.is answers scripted requests with an immediate HTTP 429, for reads as well as writes, and no amount of backoff gets around it. Backfile opens a real browser window, you clear the CAPTCHA, and then it watches the navigation and records the resulting snapshot URL automatically. You never copy or paste a link.

**Local captures use a real browser.** A plain HTTP request gets 403 from the NYT, Reuters and the Telegraph, because it is not a browser. Backfile captures through the Chromium it already ships, saving one self-contained `.mhtml` per source with images and CSS inlined — a single file that still opens years later, even after the folder is moved.

**Wayback is optional.** It is genuinely useful and genuinely flaky (frequent 503s). It is off unless you ask for it, and Backfile checks for an existing snapshot before submitting a new one.

**DOI links are excluded automatically.** DOI, Springer, JSTOR, PubMed and arXiv links resolve permanently by design. Chasing snapshots for them is busywork, so they are marked as needing no archive.

**Analysis never destroys work.** A source cut from a later draft keeps its row and its snapshots.

## Keyboard

Working through a hundred sources shouldn't need a mouse.

| Key | Action |
|---|---|
| `↑` `↓` | Move through sources |
| `Enter` | Open the source in the browser pane |
| `Shift+Enter` | Open its archive.is snapshot in your browser |
| `a` | Capture to archive.is |
| `d` | Download a local copy |
| `x` | Toggle "doesn't need archiving" |
| `/` or `Cmd+F` | Jump to search |
| `Esc` | Clear search / close dialog |

## Working from Google Docs

Export the doc into the article's folder: **File → Download → Microsoft Word
(.docx)**. `.odt` and `.html` exports work too.

Google's HTML export wraps every link in a `google.com/url?q=…` redirector;
Backfile unwraps those automatically so your citations point at the real source
rather than at Google.

## Running it

```bash
npm install
npm run dev
npm test
```

## Building an executable

```bash
npm run dist:mac
```

That produces, in `release/`:

- `Backfile-<version>-arm64.dmg` — the installer to hand to someone else
- `Backfile-<version>-arm64-mac.zip` — same app, zipped
- `mac-arm64/Backfile.app` — the app itself, drag it to Applications

Use `npm run dist:win` or `npm run dist:linux` for the other platforms — though each must be built on (or cross-compiled for) its own target.

**Two things to know about macOS builds:**

*Code signing.* Without a paid Apple Developer ID the app is unsigned, so macOS
quarantines it. See below for how to open it anyway.

*The python shim.* electron-builder's DMG step calls `python`, which modern macOS no longer ships — and `/usr/bin/python3` is an xcode-select stub that dispatches on the name it was invoked as, so symlinking it doesn't help either. `scripts/build-mac.sh` creates a small wrapper automatically, so `npm run dist:mac` just works.

## Opening an unsigned build

Backfile is not yet signed with an Apple Developer ID, so macOS will refuse it
on first launch — usually with **"Backfile is damaged and can't be opened"**,
which is misleading: the app is fine, it simply carries a quarantine flag
because it was downloaded rather than signed.

Any one of these works:

**Right-click to open.** In Finder, right-click (or Control-click) Backfile.app
→ **Open** → **Open** in the dialog. Only needed once.

**Allow it in Settings.** Try to open it normally, then go to **System Settings →
Privacy & Security**, scroll down, and click **Open Anyway** next to the message
about Backfile.

**Clear the quarantine flag** — the most reliable, especially for the "damaged"
error, which the first two options sometimes cannot clear:

```bash
xattr -dr com.apple.quarantine /Applications/Backfile.app
```

Only run that on software you trust.

**On Windows**, SmartScreen will show "Windows protected your PC" — click **More
info → Run anyway**.

## Regenerating the icon

The icon is drawn as SVG and rasterised with Electron's own Chromium, so there is no image toolchain to install:

```bash
npm run icon
```

Edit `build/icon.svg`, re-run that, and electron-builder derives the `.icns` and `.ico` from the PNG.

## Architecture

```
src/
  shared/types.ts        domain model, shared by main and renderer
  main/
    docx/                .docx link extraction (body + footnotes + endnotes)
    sources/             sources.csv read/write, analysis and reconciliation
    capture/             one adapter per preservation service
    project/             workspace and article folder discovery
  preload/               the only renderer↔OS bridge, one named channel per call
  renderer/              React UI
```

Capture services implement a single `CaptureAdapter` interface. Adding ArchiveBox, Webrecorder or Perma.cc means writing one adapter and registering it; nothing above that layer changes.

## Privacy

Backfile is an offline desktop application. It talks to exactly three places: the site you are archiving, archive.is, and the Wayback Machine — and only when you click a button. There is no account, no telemetry, and no server belonging to this project.

## Tests

```bash
npm test
```

Coverage is deliberately concentrated on the parts that touch a journalist's
files: the CSV round-trip, link extraction from every input format, and above
all the rewriter — the only component that produces a document you will publish.
Those tests build a real `.docx`, rewrite it, and read the result back, because
a silent corruption there would be found by a reader rather than by us.

## License

[Functional Source License 1.1, ALv2 Future License](LICENSE.md) — source
available, not open source.

**You may** use Backfile for any purpose including commercial journalism, read
and modify the source, and share your changes. **You may not** sell or offer a
product or service that competes with it. Two years after each release, that
version automatically becomes Apache 2.0.
