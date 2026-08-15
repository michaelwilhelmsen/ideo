/**
 * A four-line file server whose only job is turning a POST into a PNG.
 *
 *   node spikes/contact-sheet/write-sheets.mjs
 *
 * The sheets are rendered in a browser, because the shaders are — and a
 * browser cannot write to the repo. The alternative was pulling multi-megabyte
 * data URLs back through the automation channel, which works and is horrible.
 *
 * Localhost only, one directory, `.png` only, and the name is stripped to a
 * slug before it touches the filesystem. It is a throwaway, but a throwaway
 * that accepts arbitrary paths from a browser is still a throwaway that writes
 * anywhere.
 */

import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 5199
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out')

mkdirSync(OUT, { recursive: true })

createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', '*')

  if (request.method === 'OPTIONS') {
    response.writeHead(204).end()
    return
  }

  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`)
  if (request.method !== 'POST' || url.pathname !== '/write') {
    response.writeHead(404).end()
    return
  }

  // Everything that is not a plain slug goes, so no name can name a path.
  const name = (url.searchParams.get('name') ?? 'sheet')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 64)

  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const file = join(OUT, `${name}.png`)
    writeFileSync(file, Buffer.concat(chunks))
    console.log(`wrote ${file} (${Buffer.concat(chunks).length} bytes)`)
    response.writeHead(200).end('ok')
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`writing sheets to ${OUT} — POST /write?name=…`)
})
