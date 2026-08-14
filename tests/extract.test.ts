import assert from 'node:assert/strict'
import test from 'node:test'
import { extractLinksFromText } from '../src/main/docx/extractFromText'
import { extractLinksFromHtml, unwrapRedirect } from '../src/main/docx/extractFromHtml'
import { isPermanentCitation, tierOf } from '../src/shared/types'
import { SourceLink } from '../src/shared/types'

function link(over: Partial<SourceLink> = {}): SourceLink {
  return {
    url: 'https://example.com',
    anchorText: '',
    foundIn: [],
    archiveIs: '',
    wayback: '',
    localPath: '',
    videoPath: '',
    capturedAt: '',
    notes: '',
    excluded: false,
    excludedReason: '',
    ...over
  }
}

// ---- plain text ----

test('extracts bare URLs from text', () => {
  const links = extractLinksFromText('see https://a.com/x and https://b.com/y')
  assert.deepEqual(
    links.map((l) => l.url),
    ['https://a.com/x', 'https://b.com/y']
  )
})

test('ignores comment lines', () => {
  assert.equal(extractLinksFromText('# https://a.com\nhttps://b.com').length, 1)
})

test('adopts a snapshot from the "URL === SNAPSHOT" convention', () => {
  const [l] = extractLinksFromText('https://a.com === https://archive.is/abcde')
  assert.equal(l.url, 'https://a.com')
  assert.equal(l.knownArchive, 'https://archive.is/abcde')
})

test('treats a self-referential === row as uncaptured', () => {
  const [l] = extractLinksFromText('https://a.com === https://a.com')
  assert.equal(l.knownArchive, undefined)
})

test('never files a snapshot as a source in its own right', () => {
  const links = extractLinksFromText('https://archive.is/abcde\nhttps://web.archive.org/web/1/x')
  assert.equal(links.length, 0)
})

test('strips trailing sentence punctuation from URLs', () => {
  const [l] = extractLinksFromText('as reported at https://a.com/story.')
  assert.equal(l.url, 'https://a.com/story')
})

// ---- html / google docs ----

test('unwraps the Google Docs link redirector', () => {
  assert.equal(
    unwrapRedirect('https://www.google.com/url?q=https%3A%2F%2Freal.com%2Fx&sa=D'),
    'https://real.com/x'
  )
})

test('unwraps Outlook safelinks', () => {
  assert.equal(
    unwrapRedirect(
      'https://eu01.safelinks.protection.outlook.com/?url=https%3A%2F%2Freal.com%2Fy&data=x'
    ),
    'https://real.com/y'
  )
})

test('leaves ordinary URLs untouched', () => {
  assert.equal(unwrapRedirect('https://a.com/url?q=1'), 'https://a.com/url?q=1')
})

test('extracts links and anchor text from a Google Docs HTML export', () => {
  const html =
    '<p>According to <a href="https://www.google.com/url?q=https%3A%2F%2Fnyt.com%2Fa&amp;sa=D">' +
    'the <span>Times</span></a>, things happened.</p>'
  const [l] = extractLinksFromHtml(html)
  assert.equal(l.url, 'https://nyt.com/a')
  assert.equal(l.anchorText, 'the Times')
})

test('deduplicates repeated links, keeping the first real anchor text', () => {
  const html = '<a href="https://a.com"></a><a href="https://a.com">named</a>'
  const links = extractLinksFromHtml(html)
  assert.equal(links.length, 1)
  assert.equal(links[0].anchorText, 'named')
})

test('ignores anchors that are not http links', () => {
  const html = '<a href="#section">jump</a><a href="mailto:x@y.com">mail</a>'
  assert.equal(extractLinksFromHtml(html).length, 0)
})

// ---- domain rules ----

test('recognises permanent citations that need no snapshot', () => {
  assert.ok(isPermanentCitation('https://doi.org/10.1007/abc'))
  assert.ok(isPermanentCitation('https://www.jstor.org/stable/123'))
  assert.ok(isPermanentCitation('https://link.springer.com/book/10.1007/x'))
  assert.ok(!isPermanentCitation('https://nytimes.com/a'))
})

test('does not treat a lookalike host as permanent', () => {
  assert.ok(!isPermanentCitation('https://doi.org.evil.com/x'))
})

test('tiers reflect which archives exist', () => {
  assert.equal(tierOf(link()), 'none')
  assert.equal(tierOf(link({ localPath: 'archive/a.mhtml' })), 'bronze')
  assert.equal(tierOf(link({ archiveIs: 'https://archive.ph/a' })), 'silver')
  assert.equal(
    tierOf(
      link({
        archiveIs: 'https://archive.ph/a',
        wayback: 'https://web.archive.org/web/1/a',
        localPath: 'archive/a.mhtml'
      })
    ),
    'gold'
  )
})

test('an excluded link reports as gold so it stops nagging', () => {
  assert.equal(tierOf(link({ excluded: true })), 'gold')
})
