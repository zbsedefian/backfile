# Backfile

An offline desktop workspace for journalists to extract, archive, and track every source cited in an article — so the links in your published work still resolve in ten years.

Nearly 40% of links cited in 2013 news articles now lead nowhere. Backfile is built around that problem.

Everything it records lives in a plain `sources.csv` next to your drafts — no hidden database, no account, nothing that only Backfile can read. It opens in Excel, it works with whatever backup or sync you already use, and it survives Backfile being uninstalled.

## What it does

Point Backfile at the folder where you keep your projects — one subfolder per
piece of journalism. For any project it will:

1. **Add article** — import one document at a time and read the external URLs
   it cites, with the text each was cited as. Nothing in a project folder is
   read until you explicitly import it: a downloaded reference piece sitting
   in the same folder as your drafts does not pollute your source list just by
   being there. Supported inputs:
   - `.docx` — including **footnotes and endnotes**, where most citations actually live
   - `.odt` and `.html` — the formats **Google Docs** exports
   - `.txt` / `.md` — plain link lists, including the `URL === SNAPSHOT` convention, so snapshots you captured by hand import as finished work
2. **Track archival status** at a glance, per source:
   - ○ &nbsp;not archived
   - ★ bronze — local copy only
   - ★ silver — archive.is snapshot secured
   - ★ gold — archive.is + Wayback + local copy
3. **Capture**, one click per source per service.
4. **Keep everything with the project.** Local captures are written to an `archive/` subfolder inside the project's own folder, and the record lives in `sources.csv` right next to your drafts.

## sources.csv is the source of truth

Backfile's database is `sources.csv`, to be opened in Excel. Each project folder gets one.

| status | title | url | anchor_text | archive_is | wayback | local_path | video_path | captured_at | found_in | article_source | excluded | excluded_reason | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

## Design decisions worth knowing

**archive.is captures are human-driven.** archive.is answers scripted requests with an immediate HTTP 429, for reads as well as writes, and no amount of backoff gets around it. Backfile opens a real browser window, you clear the CAPTCHA, and then it watches the navigation and records the resulting snapshot URL automatically. You never copy or paste a link.

**Headlines come off the disk, not the network.** A list of bare URLs is
unreadable at a glance. Backfile already loads each page in a real browser to
save it, so it records the headline at the same time — and for captures taken
before it did that, it reads the title back out of the saved file. No request
goes out for a title. Sources with only an archive.is snapshot have no local
copy to read, so they show none; a bot-check page captured by mistake shows none
either, which is a useful signal that the capture caught a wall rather than an
article.

**The row order holds still.** Sorting by status and re-running it live meant
every finished capture promoted its own row and shoved the rest down, under a
cursor halfway through the list. The order is recalculated when you change the
sort, the filter or the search, and when the set of rows changes — not when a
capture merely upgrades one.

**A batch run updates the table as it goes, not when it finishes.** Each
source's row reflects its own capture the moment that one source is done —
badge, checkmark, captured date — rather than the whole table sitting still
until every source in the run is finished. A batch of twenty used to look
completely idle for the length of the run, with nothing but the status line
hinting that anything was happening; now you can watch it work.

**The columns hold still too, even while you resize one.** archive.is, Local,
Wayback, Video and Captured run left to right in that order — Local ahead of
Wayback, since a self-contained file already sitting on disk is worth more
than a submission to a service Backfile does not control. Their widths are
fixed regardless of window size, and dragging the Source column's own resize
handle only ever changes the Source column: earlier, the table was stretched
to fill the window with `table-layout: fixed`, which sounds like it should
leave declared column widths alone but does not — Chromium distributes any
leftover space proportionally across every column, fixed ones included, so
resizing Source visibly stretched and shrank every button column beside it on
every pixel of the drag. The table is now sized to the exact sum of its own
columns, leaving nothing for the browser to redistribute.

**Local captures use a real browser.** A plain HTTP request gets 403 from the NYT, Reuters and the Telegraph, because it is not a browser. Backfile captures through the Chromium it already ships, saving one self-contained `.mhtml` per source with images and CSS inlined — a single file that still opens years later, even after the folder is moved.

**A local capture also takes a screenshot.** An MHTML file opens like a page,
not like a snapshot — telling two captures of the same URL apart, months
later, means actually opening each one. Backfile grabs a screenshot of the
rendered page alongside the `.mhtml` and shows it as a thumbnail at the
bottom of the detail pane, so a source is recognisable at a glance without
opening the file.

**A local capture opens inside Backfile, not in whatever the OS hands it to.** The ✓ in the table and the filename in the detail pane both open the file in Backfile's own embedded pane, which reads MHTML natively — the exact reason captures are saved in that format. Handing the file to the OS instead is one click away as **Open externally**, but it depends on whatever that machine has registered for the extension, and on macOS with Microsoft Office installed that is sometimes Word — which cannot open a Chromium-written MHTML's stylesheet parts and fails with a wall of unreadable `Missing file: cid:css-…` errors that have nothing to do with the capture itself.

A capture waits for the page's own `load` event, but a news site's ad stack
routinely embeds a tracking iframe or a consent-sync beacon directly in the
page, each looping through redirects that Chromium eventually cuts off — and
the spec has `load` wait for exactly those, so the article can be fully
rendered and readable while `load` never fires at all. Backfile only fails a
capture over its own main document; a broken ad pixel elsewhere on the page is
not a reason to give up on an article a reader's own browser renders without
complaint. And if `load` is taking unusually long, Backfile falls back to
`DOMContentLoaded` after a few seconds — the point at which the article is
already readable — rather than waiting the full timeout on a page that will
never truly finish loading.

**Wayback is optional.** It is genuinely useful and genuinely flaky (frequent 503s). It is off unless you ask for it, and Backfile checks for an existing snapshot before submitting a new one.

**A local capture of a video page is not the video.** MHTML preserves the
page's title, description and surrounding text, but the video itself streams
separately and is not part of what got saved. The **Video** column downloads
the actual file with `yt-dlp` for any source, since `yt-dlp` recognises well
over a thousand sites and there is no reliable way to tell in advance which
of a given batch of links actually have a video — a source with none simply
fails quickly rather than being pre-filtered out. Selecting several rows and
picking **Download video** from the selection bar runs it across all of them
at once, the same way archive.is/Local/Wayback already do. The ✓ once
downloaded opens the file with whatever the OS already plays video with —
there is no MHTML-shaped reason to route it through Backfile's own pane the
way a local capture is.

**yt-dlp does not require a terminal.** "brew install yt-dlp" is a fine
instruction for a technical minority and a dead end for everyone else. If
yt-dlp is not found, **Capture all… › Videos** turns into an **Install
yt-dlp** button — it downloads yt-dlp's own published binary straight from
GitHub into Backfile's own folder (not a system-wide install) and confirms it
actually runs before calling the job done. Still not bundled and not pinned,
for the same reason as always (see below) — this only runs when you click it,
same as typing the brew command would have.

Three distinct video failures get an actionable hint rather than a bare
yt-dlp error, checked in an order where each rules out the next — giving two
pieces of contradictory advice on one error is worse than picking wrong.

- A 403, or "confirm you're not a bot", almost always means the installed
  yt-dlp predates a recent YouTube change — the message says to update it
  (`yt-dlp -U`, or `brew upgrade yt-dlp` on macOS), and it is not bundled with
  Backfile for exactly this reason: a pinned copy would just guarantee it
  eventually fails this way with no fix available until the journalist
  updates it themselves.
- An age-gated or otherwise sign-in-required video is different: no amount of
  updating yt-dlp fetches it anonymously, since it genuinely requires a
  logged-in YouTube session. **Capture › Video Cookies** in the menu bar is
  off by default — Backfile is otherwise account-free — and turning it on for
  Chrome, Safari, Firefox, Edge or Brave lets yt-dlp read that browser's real
  login cookies for exactly this case, and only this case; every other
  capture in Backfile still makes a plain anonymous request.
- With Video Cookies already on, a failure can instead mean macOS itself is
  refusing yt-dlp access to the browser's cookies rather than anything wrong
  with the video. Safari's cookie database needs Full Disk Access granted to
  Backfile (System Settings › Privacy & Security); Chrome, Edge and Brave
  decrypt cookies through the macOS Keychain, which shows its own unlock
  prompt the first time. The message names which one applies and where to go
  fix it, rather than handing back yt-dlp's raw, unexplained error.

**DOI links are excluded automatically.** DOI, Springer, JSTOR, PubMed and arXiv links resolve permanently by design. Chasing snapshots for them is busywork, so they are marked as needing no archive.

**Which documents count is a choice, not a guess.** A project folder collects
more than drafts — a rival's piece saved for reference, a filing, a press
release — and reading one of those files' links into `sources.csv` alongside
your own citations leaves nothing to tell them apart afterwards. So nothing is
read automatically. **Add article**, next to the project title, opens a file
picker aimed at the project's own folder — it cannot browse anywhere else — and
importing a document reads its links immediately. A folder you have never
touched starts empty; a new file appearing in it later stays untouched until
you explicitly import it. The list of what has been imported is stored per
folder in Backfile's own settings rather than in the project folder itself, so
it does not follow the folder to another machine.

Every source row remembers which imported document it came from
(`article_source` in `sources.csv`), and the dropdown at the left of the
toolbar — labelled with whichever document is selected, or **All articles** —
filters the list down to just one import's worth of sources. Useful the moment
a folder holds more than one imported document: a draft and a later revision,
say, each with its own citations.

Importing never asks twice before reading a file, so the same dropdown lists a
small **×** beside each import to undo one. Nothing is deleted — the sources it
contributed keep their rows and snapshots, they just stop claiming to be cited,
which is what lands them in the **orphaned** filter for cleanup.

**Analysis never destroys work.** A source cut from a later draft keeps its row
and its snapshots. It stops claiming to be cited, which is what lands it in the
**orphaned** filter — where you can select the strays and remove them in one go.

**Exporting never assumes which document you mean.** A project can hold more
than one imported `.docx` — a draft and a later revision, say — so **Export…**
opens straight to a picker at the top of the modal rather than a toolbar
dropdown left over from before you clicked it. Nothing is chosen by default,
and the preview below it, along with the write button, stays empty until you
pick one — so exporting the wrong revision by clicking straight through is not
something that can happen by accident.

## Keyboard

Working through a hundred sources shouldn't need a mouse.

| Key | Action |
|---|---|
| `↑` `↓` | Move through sources |
| `Shift+↑` `Shift+↓` | Extend the selection |
| `Cmd+A` | Select every source shown |
| `Enter` | Open the source in the browser pane |
| `Shift+Enter` | Open its archive.is snapshot in your browser |
| `a` | Capture to archive.is |
| `d` | Download a local copy |
| `x` | Toggle "doesn't need archiving" |
| `/` or `Cmd+F` | Jump to search |
| `Esc` | Narrow the selection / clear search / close dialog |

**Selecting several at once.** Cmd-click (Ctrl on Windows and Linux) adds or
removes one row; shift-click takes everything between the last row you clicked
and this one. `a`, `d` and `x` then act on the whole selection, and the toolbar
switches to the same actions plus Remove — in the row it already occupies, so
the table underneath stays put. One row in the selection keeps an accent stripe:
that is the one the detail pane on the right is showing.

Selection-wide captures go through the same queue as "capture everything", so
they inherit its pacing and its single archive.is CAPTCHA rather than firing a
burst of requests.

**Copying a link.** Each row has a small ⧉ button next to its title — always
present, quiet until the row is hovered or the button itself is focused. It
copies the full URL, not the truncated host shown in the row.

**Resizing the Source column.** Drag the divider at the right edge of the
Source header. The width is remembered across restarts, like the other panes.

## Working from Google Docs

Export the doc into the project's folder: **File → Download → Microsoft Word
(.docx)**, then import it with **Add article**. `.odt` and `.html` exports work
too.

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
    project/             workspace and project folder discovery
  preload/               the only renderer↔OS bridge, one named channel per call
  renderer/              React UI
```

Capture services implement a single `CaptureAdapter` interface. Adding ArchiveBox, Webrecorder or Perma.cc means writing one adapter and registering it; nothing above that layer changes.

## When something fails

A status-bar message is one line, and the next status message erases it — so a
batch run with a handful of failures scattered through it left only the last
one visible by the time the run finished, with no way to hand the others to
anyone. Every capture, analyze and publish failure is kept instead: a red
**N failures** badge appears at the bottom of the window, and clicking it opens
the full list — each entry with its URL, its exact error message, and a
**Copy** button, plus a **Copy all** button that formats the whole run into one
block of text meant to be pasted somewhere else entirely. The list survives
until you clear it.

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
