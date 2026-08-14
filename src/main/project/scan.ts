/**
 * Discover article folders under a workspace root.
 *
 * The rule is deliberately loose: an article is any folder that contains at
 * least one .docx. Real folders in the wild are named inconsistently and hold
 * drafts, edits, image subfolders and stray photos, so imposing a naming
 * convention would just lock people out of their own archives.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Article } from '../../shared/types'
import { readSources, SOURCES_FILENAME } from '../sources/csv'
import { isTextSource } from '../docx/extractFromText'
import { isHtmlSource, isOdtSource } from '../docx/extractFromHtml'

/** Word writes ~$foo.docx lock files while a document is open; they are not drafts. */
function isRealDocx(name: string): boolean {
  return name.toLowerCase().endsWith('.docx') && !name.startsWith('~$') && !name.startsWith('.')
}

/**
 * Anything Backfile can pull links out of: Word drafts, Google Docs exports
 * (.docx / .odt / .html), and plain-text link lists.
 */
export function isSourceDocument(name: string): boolean {
  return isRealDocx(name) || isTextSource(name) || isHtmlSource(name) || isOdtSource(name)
}

async function listDocuments(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && isSourceDocument(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function toArticle(dir: string, name: string): Promise<Article | null> {
  let documents: string[]
  try {
    documents = await listDocuments(dir)
  } catch {
    return null
  }
  const hasSourcesFile = await exists(path.join(dir, SOURCES_FILENAME))
  // A folder with neither drafts nor a sources file is not an article.
  if (documents.length === 0 && !hasSourcesFile) return null
  return {
    name,
    path: dir,
    documents,
    hasSourcesFile,
    sources: hasSourcesFile ? await readSources(dir) : []
  }
}

export async function scanWorkspace(root: string): Promise<Article[]> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const articles: Article[] = []

  // The root itself may be a single article folder rather than a container.
  const self = await toArticle(root, path.basename(root))
  if (self) articles.push(self)

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const article = await toArticle(path.join(root, entry.name), entry.name)
    if (article) articles.push(article)
  }

  return articles.sort((a, b) => a.name.localeCompare(b.name))
}

export async function reloadArticle(articlePath: string): Promise<Article | null> {
  return toArticle(articlePath, path.basename(articlePath))
}
