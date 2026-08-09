/**
 * What a candidate can be exported as, and what to call the files (#31).
 *
 * Pure, and separate from the panel that renders it, because every question
 * here is answerable from the manifest alone: whether a candidate is a picture
 * or a clip, which of PRD §8's three files that makes possible, and whether
 * rewind would do anything. The panel asks; nothing here knows it exists.
 *
 * The Rust side answers the same questions again before it encodes anything
 * (`export::plan`). That is not duplication for its own sake — this side
 * decides what to *offer*, and refusing to offer an impossible export is a
 * different job from refusing to run one.
 */

import type { Generation } from '@/lib/recipe'

/** The three files PRD §8 promises, as the panel names them. */
export type Deliverable = 'mp4' | 'webm' | 'poster'

export const DELIVERABLES: readonly Deliverable[] = ['mp4', 'webm', 'poster']

/** Which of them this export wants. */
export type Formats = Readonly<Record<Deliverable, boolean>>

/**
 * What there is to export.
 *
 * `nothing` is a real state rather than an error: a candidate whose paid job
 * never landed has no file, and the panel says so instead of offering an export
 * that would fail at the last step.
 */
export type Medium = 'still' | 'clip' | 'nothing'

/**
 * The two containers `extension_for` can produce on the Rust side.
 *
 * Exactly those two, and no wider. This list decides what the preview element
 * plays as well as what the panel offers, so adding a container the app cannot
 * produce would change how an existing candidate renders in exchange for a case
 * that cannot arise.
 */
const VIDEO_EXTENSIONS: readonly string[] = ['mp4', 'webm']

/**
 * Whether an asset file is a clip.
 *
 * Its extension rather than its stage, deliberately — the manifest records a
 * file name and the stage separately, so asking the file means a candidate
 * saved before this shipped, or a manifest somebody has hand-edited, still
 * reads as whatever it actually holds.
 */
export function isVideoAsset(asset: string | null): boolean {
  if (asset === null) return false
  const extension = asset.split('.').at(-1)?.toLowerCase() ?? ''
  return VIDEO_EXTENSIONS.includes(extension)
}

export function mediumOf(generation: Generation | null): Medium {
  if (generation === null || generation.asset === null) return 'nothing'
  return isVideoAsset(generation.asset) ? 'clip' : 'still'
}

/**
 * What this candidate can produce.
 *
 * A still exports its poster and nothing else. Synthesising a one-frame video
 * from a picture is a file nobody wants — "a styled still is a legitimate final
 * deliverable" (#31) means the still itself, web-sized.
 */
export function availableFormats(medium: Medium): Formats {
  const video = medium === 'clip'
  return { mp4: video, webm: video, poster: medium !== 'nothing' }
}

/** Whether anything at all was asked for — the one selection that cannot run. */
export function anyRequested(formats: Formats): boolean {
  return DELIVERABLES.some(deliverable => formats[deliverable])
}

/**
 * What the export was asked for, narrowed to what this candidate can give.
 *
 * Belt and braces on the checkbox that was ticked before the selection moved
 * from a clip to a still: the panel disables it, and this makes the disabling
 * impossible to route around.
 */
export function requestedFormats(formats: Formats, medium: Medium): Formats {
  const possible = availableFormats(medium)
  return {
    mp4: formats.mp4 && possible.mp4,
    webm: formats.webm && possible.webm,
    poster: formats.poster && possible.poster,
  }
}

/**
 * Whether this candidate was generated with rewind asked for (PRD §4.5).
 *
 * The recipe's own answer, because rewind is recorded there like every other
 * option — so re-opening a project a week later exports the clip the way it was
 * meant to be exported, rather than the way the panel happens to default.
 *
 * The switch stays live afterwards. Ping-pong is a post-process, so changing
 * one's mind about it costs an encode rather than a generation, and forcing a
 * re-run to try the other reading would be charging money for an ffmpeg flag.
 */
export function rewindWanted(generation: Generation | null): boolean {
  return generation?.recipe.options.rewind === true
}

/**
 * Whether rewinding this clip buys anything (#45).
 *
 * The two mechanisms are not exclusive and combining them is defined rather
 * than forbidden: a clip that already returns to its first frame, played
 * forward and then backwards, is still a seamless loop — just twice as long and
 * twice as heavy for a loop it already had. Worth saying out loud, and not
 * worth refusing: a slow drift out and back reads differently from the same
 * drift looped, and which one is wanted is the user's call.
 */
export function rewindIsRedundant(
  generation: Generation | null,
  rewind: boolean
): boolean {
  return rewind && generation?.recipe.options.loop === true
}

/**
 * What the files are called, before the extension.
 *
 * Built from the project name and the candidate's own coordinates rather than
 * from its id: the export leaves the app and lands in somebody's `public/`
 * folder, where `atlas-hero-animate-2.mp4` is a name and
 * `9f1c8e4a-1111-2222-3333-444455556666.mp4` is a barcode.
 *
 * The stage word is the domain term, not a translated one — a file name that
 * changed with the app's language would break every link on the page that used
 * it. Rust filters this again before it becomes a file (`safe_base_name`);
 * slugging here is about producing a *good* name, not a safe one.
 */
export function exportBaseName(
  projectName: string,
  generation: Generation
): string {
  const slug = projectName
    .normalize('NFKD')
    .replaceAll(/[^\p{ASCII}]/gu, '')
    .replaceAll(/[^a-zA-Z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')

  const stem = slug === '' ? 'export' : slug
  return `${stem}-${generation.stage}-${String(generation.ordinal)}`
}
