/**
 * Where a generation's file is, as far as the webview is concerned.
 *
 * A module of its own since #36, and for a mechanical reason worth stating: the
 * effects tab needs the same URL for a different purpose — it uploads the file
 * as a texture rather than showing it — and `shared.tsx` may only export
 * components if fast refresh is to keep working. Two callers building the same
 * path two ways is how one of them ends up wrong about where assets live, so it
 * moved here rather than being written twice.
 */

import { convertFileSrc } from '@tauri-apps/api/core'

/**
 * The webview URL for a generation's file, or `null` when there is no file.
 *
 * The manifest stores a bare name and the folder comes from wherever the
 * manifest was found, so a project folder that has moved still resolves.
 */
export function assetSource(
  directory: string | null,
  asset: string | null
): string | null {
  if (directory === null || directory === '' || asset === null) return null
  return convertFileSrc(`${directory}/assets/${asset}`)
}
