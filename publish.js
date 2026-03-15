#!/usr/bin/env node

/**
 * Publishes markdown blog posts to WordPress via the REST API.
 *
 * Converts MD → HTML (reusing convert-to-wp.js pipeline), then
 * creates or updates the post on WordPress. Tracks post IDs in
 * .wp-manifest.json so subsequent runs update rather than duplicate.
 *
 * Auth: WordPress Application Passwords (WP 5.6+).
 *       Configure in .wp-config.json (see .wp-config.json.example).
 *
 * Usage:
 *   node publish.js md/part-1-nat-holepunching.md           # publish as draft
 *   node publish.js md/part-1-nat-holepunching.md --publish  # publish live
 *   node publish.js md/part-1-nat-holepunching.md --status   # check status
 *   node publish.js --all                                    # publish all md/ posts
 *   node publish.js --all --publish                          # publish all live
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

// --- Config & Manifest ---

const CONFIG_PATH = path.join(__dirname, '.wp-config.json')
const MANIFEST_PATH = path.join(__dirname, '.wp-manifest.json')

function loadConfig () {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Missing .wp-config.json — copy .wp-config.json.example and fill in your credentials.')
    console.error('')
    console.error('  cp .wp-config.json.example .wp-config.json')
    console.error('')
    console.error('WordPress Application Passwords:')
    console.error('  WP Admin → Users → Profile → Application Passwords')
    process.exit(1)
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  if (!config.site || !config.username || !config.password) {
    console.error('.wp-config.json must have: site, username, password')
    process.exit(1)
  }
  // Normalize: strip trailing slash
  config.site = config.site.replace(/\/+$/, '')
  return config
}

function loadManifest () {
  if (!fs.existsSync(MANIFEST_PATH)) return { posts: {} }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'))
}

function saveManifest (manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
}

// --- Markdown Parsing ---

function parseMd (filePath) {
  const md = fs.readFileSync(filePath, 'utf-8')

  // Title: first H1
  const titleMatch = md.match(/^#\s+(.+)$/m)
  const title = titleMatch ? titleMatch[1].trim() : path.basename(filePath, '.md')

  // Excerpt: **Excerpt:** line
  const excerptMatch = md.match(/\*\*Excerpt:\*\*\s*(.+?)(?:\n|$)/)
  const excerpt = excerptMatch ? excerptMatch[1].trim() : ''

  // Part number for ordering
  const partMatch = path.basename(filePath).match(/part-(\d+)/)
  const partNumber = partMatch ? parseInt(partMatch[1], 10) : null

  // Series detection
  const isSeries = md.includes('Series Navigation') || md.includes('Series:')

  return { title, excerpt, partNumber, isSeries, raw: md }
}

// --- HTML Generation ---

function generateHtml (mdFile) {
  // Reuse convert-to-wp.js to generate HTML, then read the output
  const htmlFile = mdFile.replace(/^md\//, 'html/').replace(/\.md$/, '.html')
  const htmlPath = path.join(__dirname, htmlFile)
  const mdPath = path.join(__dirname, mdFile)

  // Run the converter
  execFileSync('node', [path.join(__dirname, 'convert-to-wp.js'), mdPath], {
    cwd: __dirname,
    stdio: 'pipe'
  })

  // Read and clean the generated HTML
  let html = fs.readFileSync(htmlPath, 'utf-8')

  // Strip the WordPress import instructions comment block
  html = html.replace(/<!--\s*WORDPRESS IMPORT INSTRUCTIONS[\s\S]*?-->\s*/, '')

  return html.trim()
}

// --- WordPress API ---

function authHeader (config) {
  const token = Buffer.from(`${config.username}:${config.password}`).toString('base64')
  return `Basic ${token}`
}

async function wpRequest (config, method, endpoint, body) {
  const url = `${config.site}/wp-json/wp/v2${endpoint}`
  const options = {
    method,
    headers: {
      Authorization: authHeader(config),
      'Content-Type': 'application/json',
      'User-Agent': 'heartit-blog-publisher/1.0'
    }
  }

  if (body) {
    options.body = JSON.stringify(body)
  }

  const res = await fetch(url, options)
  const data = await res.json()

  if (!res.ok) {
    const msg = data.message || JSON.stringify(data)
    throw new Error(`WordPress API error (${res.status}): ${msg}`)
  }

  return data
}

async function getCategories (config) {
  const categories = []
  let page = 1
  while (true) {
    const batch = await wpRequest(config, 'GET', `/categories?per_page=100&page=${page}`)
    categories.push(...batch)
    if (batch.length < 100) break
    page++
  }
  return categories
}

async function getOrCreateCategory (config, name, parentId) {
  const existing = await getCategories(config)
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

  const match = existing.find(c => c.slug === slug)
  if (match) return match.id

  const body = { name, slug }
  if (parentId) body.parent = parentId
  const created = await wpRequest(config, 'POST', '/categories', body)
  return created.id
}

async function getTags (config) {
  const tags = []
  let page = 1
  while (true) {
    const batch = await wpRequest(config, 'GET', `/tags?per_page=100&page=${page}`)
    tags.push(...batch)
    if (batch.length < 100) break
    page++
  }
  return tags
}

async function getOrCreateTag (config, name) {
  const existing = await getTags(config)
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

  const match = existing.find(t => t.slug === slug)
  if (match) return match.id

  const created = await wpRequest(config, 'POST', '/tags', { name, slug })
  return created.id
}

// Topic folder → category mapping
const TOPIC_CATEGORIES = {
  'p2p-system': { name: 'P2P Systems', tags: ['holepunch', 'p2p', 'distributed-systems'] },
  'tech-opinion': { name: 'Tech Opinion', tags: ['opinion'] }
}

async function resolveTopicMeta (config, topicFolder) {
  const topicKey = path.basename(topicFolder)
  const meta = TOPIC_CATEGORIES[topicKey] || { name: topicKey, tags: [] }

  const categoryId = await getOrCreateCategory(config, meta.name)
  const tagIds = []
  for (const tag of meta.tags) {
    tagIds.push(await getOrCreateTag(config, tag))
  }

  return { categoryId, tagIds }
}

async function createPost (config, { title, content, excerpt, status, categoryId, tagIds }) {
  const body = {
    title,
    content,
    excerpt,
    status: status || 'draft',
    categories: [categoryId],
    tags: tagIds,
    format: 'standard'
  }
  return wpRequest(config, 'POST', '/posts', body)
}

async function updatePost (config, postId, { title, content, excerpt, status, categoryId, tagIds }) {
  const body = {
    title,
    content,
    excerpt,
    categories: [categoryId],
    tags: tagIds
  }
  if (status) body.status = status
  return wpRequest(config, 'POST', `/posts/${postId}`, body)
}

async function getPost (config, postId) {
  return wpRequest(config, 'GET', `/posts/${postId}?context=edit`)
}

// --- Main ---

async function publishFile (mdFile, flags) {
  const config = loadConfig()
  const manifest = loadManifest()

  const status = flags.publish ? 'publish' : 'draft'
  const meta = parseMd(path.join(__dirname, mdFile))
  const { categoryId, tagIds } = await resolveTopicMeta(config, __dirname)

  // Check status only
  if (flags.status) {
    const entry = manifest.posts[mdFile]
    if (!entry) {
      console.log(`  ${mdFile}: not published yet`)
      return
    }
    try {
      const post = await getPost(config, entry.id)
      console.log(`  ${mdFile}:`)
      console.log(`    ID:     ${post.id}`)
      console.log(`    Status: ${post.status}`)
      console.log(`    URL:    ${post.link}`)
      console.log(`    Modified: ${post.modified}`)
    } catch (err) {
      console.log(`  ${mdFile}: error fetching (${err.message})`)
    }
    return
  }

  // Generate HTML
  console.log(`  Converting ${mdFile}...`)
  const html = generateHtml(mdFile)

  const existing = manifest.posts[mdFile]

  if (existing) {
    // Update existing post
    console.log(`  Updating WP post #${existing.id}...`)
    const post = await updatePost(config, existing.id, {
      title: meta.title,
      content: html,
      excerpt: meta.excerpt,
      status: flags.publish ? 'publish' : undefined, // only change status if --publish
      categoryId,
      tagIds
    })
    manifest.posts[mdFile] = {
      id: post.id,
      status: post.status,
      url: post.link,
      updated: new Date().toISOString()
    }
    saveManifest(manifest)
    console.log(`  ✓ Updated: ${post.link} [${post.status}]`)
  } else {
    // Create new post
    console.log(`  Creating new ${status} post...`)
    const post = await createPost(config, {
      title: meta.title,
      content: html,
      excerpt: meta.excerpt,
      status,
      categoryId,
      tagIds
    })
    manifest.posts[mdFile] = {
      id: post.id,
      status: post.status,
      url: post.link,
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    }
    saveManifest(manifest)
    console.log(`  ✓ Created: ${post.link} [${post.status}]`)
  }
}

async function main () {
  const args = process.argv.slice(2)
  const flags = {
    publish: args.includes('--publish'),
    status: args.includes('--status'),
    all: args.includes('--all')
  }
  const files = args.filter(a => !a.startsWith('--'))

  if (files.length === 0 && !flags.all) {
    console.log('Usage:')
    console.log('  node publish.js md/<file>.md              # create/update as draft')
    console.log('  node publish.js md/<file>.md --publish     # create/update as published')
    console.log('  node publish.js md/<file>.md --status      # check post status')
    console.log('  node publish.js --all                      # draft all posts')
    console.log('  node publish.js --all --publish            # publish all posts')
    console.log('  node publish.js --all --status             # check all statuses')
    process.exit(0)
  }

  // Resolve file list
  let mdFiles = files
  if (flags.all) {
    const mdDir = path.join(__dirname, 'md')
    mdFiles = fs.readdirSync(mdDir)
      .filter(f => f.endsWith('.md') && f !== 'README.md')
      .sort()
      .map(f => `md/${f}`)
  }

  console.log(`\n${flags.status ? 'Checking' : 'Publishing'} ${mdFiles.length} post(s)...\n`)

  for (const file of mdFiles) {
    const fullPath = path.join(__dirname, file)
    if (!fs.existsSync(fullPath)) {
      console.error(`  ✗ File not found: ${file}`)
      continue
    }
    try {
      await publishFile(file, flags)
    } catch (err) {
      console.error(`  ✗ ${file}: ${err.message}`)
    }
    console.log('')
  }

  console.log('Done.')
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
