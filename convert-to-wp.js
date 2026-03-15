#!/usr/bin/env node

/**
 * Converts a Markdown blog post to WordPress-ready HTML.
 *
 * Handles:
 * - GFM tables → <table> with WordPress styling classes
 * - Code blocks → <pre><code> with language class for Prismatic
 * - Mermaid blocks → <pre class="mermaid"> for Mermaid.js (loaded via CDN)
 * - Callout blockquotes → styled <blockquote> with CSS classes
 * - Inline <a target="_blank"> → preserved as-is
 * - Series navigation → styled nav block
 *
 * Usage: node convert-to-wp.js part-1-nat-holepunching.md
 * Output: part-1-nat-holepunching.html (WordPress-pasteable HTML)
 */

const { marked } = require('marked')
const fs = require('fs')
const path = require('path')

const inputFile = process.argv[2]
if (!inputFile) {
  console.error('Usage: node convert-to-wp.js <markdown-file>')
  process.exit(1)
}

const md = fs.readFileSync(inputFile, 'utf-8')

// Configure marked for GFM (tables, etc.)
marked.setOptions({
  gfm: true,
  breaks: false,
  headerIds: true
})

// Custom renderer
const renderer = new marked.Renderer()

// --- CODE BLOCKS ---
// Mermaid blocks → MerPress-compatible div
// Regular code → Prismatic-compatible pre/code
renderer.code = function (code, language) {
  // Handle object-style args (marked v4+)
  if (typeof code === 'object') {
    language = code.lang
    code = code.text
  }

  if (language === 'mermaid') {
    // Use raw Mermaid.js — rendered client-side via CDN script
    // No WordPress plugin needed, just the <script> tag at the bottom
    return `\n<div class="mermaid-container"><pre class="mermaid">\n${code}\n</pre></div>\n\n`
  }

  // Strip title="..." from language string (e.g., 'js title="file.js"')
  let title = ''
  if (language && language.includes('title=')) {
    const match = language.match(/title="([^"]+)"/)
    if (match) title = match[1]
    language = language.replace(/\s*title="[^"]+"/, '').trim()
  }

  const langClass = language ? ` class="language-${language}"` : ''
  const titleBlock = title
    ? `<div class="code-filename">${title}</div>\n`
    : ''

  return `${titleBlock}<pre><code${langClass}>${escapeHtml(code)}</code></pre>\n\n`
}

// --- BLOCKQUOTES (callouts) ---
renderer.blockquote = function (quote) {
  // Handle object-style args — get raw text
  let raw = typeof quote === 'object' ? (quote.raw || quote.text || '') : quote

  // Strip leading '> ' from each line to get clean content
  const cleanRaw = raw.replace(/^>\s?/gm, '').trim()

  // Parse the inner Markdown to HTML (bold, links, inline code, etc.)
  const html = marked.parse(cleanRaw)

  // Detect callout type from the raw text (before HTML conversion)
  const calloutPatterns = [
    { pattern: /\*\*Key Insight:/, cssClass: 'callout-insight' },
    { pattern: /\*\*Gotcha:/, cssClass: 'callout-gotcha' },
    { pattern: /\*\*Terminology:/, cssClass: 'callout-term' },
    { pattern: /\*\*Feynman Moment:/, cssClass: 'callout-feynman' },
    { pattern: /\*\*Series:.*Holepunch/, cssClass: 'series-nav' }
  ]

  // Also check parsed HTML in case marked already processed it
  const combined = cleanRaw + html

  for (const { pattern, cssClass } of calloutPatterns) {
    if (pattern.test(combined)) {
      return `<blockquote class="${cssClass}">\n${html}</blockquote>\n\n`
    }
  }

  // Default blockquote (opening quote, etc.)
  return `<blockquote>\n${html}</blockquote>\n\n`
}

// --- TABLES ---
renderer.table = function (header, body) {
  // Handle object-style args
  const headerText = typeof header === 'object' ? header.header : header
  const bodyText = typeof header === 'object' ? header.rows
    ? header.rows.map(row => `<tr>${row.map(cell => `<td>${cell.text}</td>`).join('')}</tr>`).join('\n')
    : body
    : body

  const headerHtml = typeof header === 'object' && header.header
    ? `<tr>${header.header.map(cell => `<th>${cell.text}</th>`).join('')}</tr>`
    : headerText

  return `<figure class="wp-block-table"><table>\n<thead>\n${headerHtml}\n</thead>\n<tbody>\n${typeof header === 'object' ? bodyText : bodyText}\n</tbody>\n</table></figure>\n\n`
}

// --- HEADINGS (add IDs for anchor links) ---
renderer.heading = function (text, level) {
  // Handle object-style args
  if (typeof text === 'object') {
    level = text.depth
    text = text.text
  }
  const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  return `<h${level} id="${id}">${text}</h${level}>\n\n`
}

function escapeHtml (str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

marked.use({ renderer })

// Convert
let html = marked.parse(md)

// Remove HTML comments EXCEPT WordPress block markers (<!-- wp: -->)
html = html.replace(/<!--(?!\s*\/?wp:)[\s\S]*?-->/g, '')

// Count mermaid diagrams
const mermaidCount = (html.match(/<pre class="mermaid">/g) || []).length

// Append Mermaid.js CDN if there are diagrams
const mermaidScript = mermaidCount > 0
  ? `\n<!-- Mermaid.js — renders <pre class="mermaid"> blocks -->\n<script type="module">\nimport mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';\nmermaid.initialize({\n  startOnLoad: true,\n  theme: 'dark',\n  themeVariables: {\n    primaryColor: '#2d333b',\n    primaryTextColor: '#8b949e',\n    primaryBorderColor: '#373e47',\n    lineColor: '#539bf5',\n    secondaryColor: '#22272e',\n    tertiaryColor: '#1b1f24',\n    noteBkgColor: '#2d333b',\n    noteTextColor: '#8b949e',\n    noteBorderColor: '#986ee2',\n    actorBkg: '#2d333b',\n    actorBorder: '#373e47',\n    actorTextColor: '#cdd9e5',\n    actorLineColor: '#373e47',\n    signalColor: '#539bf5',\n    signalTextColor: '#8b949e',\n    sequenceNumberColor: '#1b1f24'\n  }\n});\n</script>\n`
  : ''

// Wrap in a container for easy copy-paste
const output = `<!--
  WORDPRESS IMPORT INSTRUCTIONS
  ==============================
  1. Create a new Post in WordPress
  2. Switch to the Code Editor (⋮ menu > Code editor)
  3. Select ALL text below this comment block and paste
  4. Switch back to Visual Editor to verify

  Plugins required:
  - Prismatic (syntax highlighting)

  Mermaid diagrams are loaded via CDN (no plugin needed).
  The <script> tag at the bottom handles rendering.
-->

${html}${mermaidScript}`

// Write output — if input is from md/, output goes to html/
const baseName = path.basename(inputFile, '.md') + '.html'
const inputDir = path.dirname(inputFile)
const outDir = inputDir.endsWith('/md') || inputDir === 'md'
  ? inputDir.replace(/\/?md$/, 'html')
  : inputDir
const outFile = path.join(outDir, baseName)
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(outFile, output, 'utf-8')
console.log(`✓ Converted: ${inputFile} → ${outFile}`)
console.log(`  Word count: ~${md.split(/\s+/).length}`)
console.log(`  Tables: ${(html.match(/<table/g) || []).length}`)
console.log(`  Code blocks: ${(html.match(/<pre/g) || []).length}`)
console.log(`  Mermaid diagrams: ${mermaidCount}`)
console.log(`  Callout blockquotes: ${(html.match(/callout-/g) || []).length}`)
console.log(`\n  Next: Open ${outFile}, copy everything, paste into WP Code Editor`)
