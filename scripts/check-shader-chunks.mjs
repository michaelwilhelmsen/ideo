/**
 * Every `#include <chunk>` in the ported gradient shaders must name a chunk
 * three actually ships.
 *
 * three's `resolveIncludes` throws on an unknown name, and it does so at
 * program-compile time — which is the first frame of a look the user just
 * switched to, not startup. The shaders were written against three <= 0.150 and
 * reference `uv2_*` chunks that were removed after it, so this is a real
 * failure mode and not a hypothetical one: a three upgrade can silently remove
 * a chunk and the only symptom is one look going black.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ShaderChunk } from 'three'

const DIR = join(
  import.meta.dirname,
  '..',
  'src',
  'lib',
  'effects',
  'three',
  'glsl'
)

const missing = []
const resolved = new Set()

for (const file of readdirSync(DIR).filter(name => name.endsWith('.glsl'))) {
  const source = readFileSync(join(DIR, file), 'utf8')
  for (const [, chunk] of source.matchAll(/^[ \t]*#include <([\w]+)>/gm)) {
    resolved.add(chunk)
    if (ShaderChunk[chunk] === undefined) missing.push(`${file}: <${chunk}>`)
  }
}

if (missing.length > 0) {
  console.error(
    `Unresolvable shader chunks against three r${process.env.THREE_REVISION ?? ''}:`
  )
  for (const line of missing) console.error(`  ${line}`)
  process.exit(1)
}

console.log(`ok — ${resolved.size} distinct chunks, all resolve`)
