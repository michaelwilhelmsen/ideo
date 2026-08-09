/**
 * The impure half of a run: ids, seeds, the clock, and putting the job on the
 * queue.
 *
 * The reducer stays pure by taking finished facts, and a paid run has none to
 * give it: the job may take a minute, and since #24 it may outlive the session
 * entirely, so running one dispatches nothing. The candidate appears when
 * `services/jobs` collects the finished job — from an event, or from the store
 * on the next launch.
 *
 * All three stages are paid now (#28, #29), and they share every line below.
 * That is the point rather than a coincidence: a restyle and an animation are
 * model calls like a source is, and the one thing they need that a source does
 * not — an input image — is named here and read on the Rust side, so no pixels
 * cross the IPC boundary to get to fal.
 */

import { useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import i18n from '@/i18n/config'
import { ensureFalApiKey } from '@/services/fal-api-key'
import { useUIStore } from '@/store/ui-store'
import {
  buildRequest,
  freezeRecipe,
  imageParamShape,
  modelById,
  planBatch,
  sentRecipe,
  MODEL_REGISTRY,
  type ModelCapabilities,
  type Project,
  type StageKind,
  type StageRecipe,
} from '@/lib/recipe'
import { useSubmitGeneration } from '@/services/jobs'
import type { GenerationError, ImageInput } from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import { generationErrorMessage } from './errors'

/** A candidate fal.ai never took, and why. */
interface RefusedSubmit {
  readonly generationId: string
  readonly error: GenerationError
}

/** A seed to pin when there is no generation to take one from. */
export function rollSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000)
}

/**
 * The gate the PRD puts on the *first generate* rather than on the app (§7).
 *
 * Browsing is free and requires nothing; spending money is what requires a
 * key. Blocking here means the refusal arrives before the submit rather than
 * as a failure partway through a job, and it arrives with the way out
 * attached — the toast opens the key pane, so nobody has to go hunting through
 * Settings for a field they have never seen.
 */
export async function requireFalApiKey(
  queryClient: QueryClient
): Promise<boolean> {
  if (await ensureFalApiKey(queryClient)) return true

  toast.error(i18n.t('generate.error.noApiKey'), {
    action: {
      label: i18n.t('generate.addKey'),
      onClick: () => useUIStore.getState().openPreferencesPane('apiKey'),
    },
  })

  return false
}

/**
 * What a stage needs to send its input image — three answers, not two.
 *
 * `needsNone` is a model with no `imageParam` at all, which is every source
 * model. `missing` is a model that *has* one and has no input generation to
 * point it at: the run is refused rather than submitted, because the Nano Banana
 * edit endpoints do not require their image field — so the same call without a
 * source is a paid text-to-image of whatever the prompt happens to say (#28).
 *
 * Told apart by a tag rather than by `null` versus a magic string, because the
 * two absences mean opposite things — one submits, one refuses — and a caller
 * that forgets which is which spends money on the difference.
 */
type ResolvedImageInput =
  | { readonly kind: 'needsNone' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'names'; readonly input: ImageInput }

function imageInputFor(
  model: ModelCapabilities,
  recipe: StageRecipe
): ResolvedImageInput {
  const shape = imageParamShape(model)
  if (model.imageParam === null || shape === null) return { kind: 'needsNone' }

  // Whichever candidate the stage is working from — a generated source or one
  // the user dropped in (#27). Both are a file in the assets folder named after
  // their generation, which is the whole reason the upload converged on that
  // shape and the reason this needs no branch for it.
  if (recipe.inputGenerationId === null) return { kind: 'missing' }

  return {
    kind: 'names',
    input: {
      generationId: recipe.inputGenerationId,
      param: model.imageParam,
      shape,
    },
  }
}

/**
 * Running a stage.
 *
 * All three submit jobs since #29, and every line below is stage-agnostic — the
 * registry says what goes on the wire, `freezeRecipe` says what the stage is
 * working from, and `imageInputFor` says which file to send and under what name.
 * The animate branch that used to mint a fixture candidate here is gone rather
 * than generalised: it was the last place a stage needed a special case.
 */
export function useRunStage(
  project: Project,
  stage: StageKind,
  batch: number
): { run: () => void; isRunning: boolean } {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const submit = useSubmitGeneration()
  const queryClient = useQueryClient()

  // Tracked here rather than read off the mutation, because a batch is several
  // mutations on one observer and the observer only remembers the last.
  const [submitting, setSubmitting] = useState(false)

  return {
    // Only while the submits themselves are on the wire. Jobs already in
    // flight do *not* disable the button: three run at once and the rest queue
    // (PRD §3.3), so refusing a second click would be this app enforcing a
    // limit fal.ai and the semaphore already handle — and would stop someone
    // from queueing the next idea while the current one renders.
    isRunning: submitting,
    run: () => void submitWhenKeyed(),
  }

  async function submitWhenKeyed() {
    // Frozen once for the whole batch: every candidate of one run has to
    // describe itself identically, or the four-up would be four recipes. It
    // carries the draft's own prompt, exactly as the form has it — seeding a
    // preset into that box happened earlier and elsewhere (#28), so what is
    // sent is what is on screen.
    const recipe = freezeRecipe(project, stage)

    // `null` means the stage has no input selected at all. The button is
    // disabled in that state (`blockedReasonKey`), so this is the unreachable
    // path — said out loud rather than returned silently, because the one thing
    // it must never do is submit.
    if (recipe === null) {
      toast.error(t('generate.error.inputImageUnusable'))
      return
    }

    // The registry decides what goes on the wire (#25): the endpoint, the
    // aspect idiom, our defaults rather than fal's, a seed only where there is a
    // field for one, and — the reason a restyle needs nothing else here — a
    // negative only on a model with a `negativePromptParam` and a strength only
    // on one with a `strengthParam`, since a field the model does not declare is
    // dropped rather than concatenated into the prompt (PRD §9).
    // `modelById` throws on an id with no entry, so an unknown model fails here
    // rather than as a 422 after the charge (PRD §5 — no arbitrary model ids).
    const model = modelById(MODEL_REGISTRY, recipe.modelId)
    const built = buildRequest(model, project.aspect, recipe)

    // What is persisted is what went to fal, not what the form said (AC10): the
    // built body resolves our defaults, the project's locked ratio as this
    // model's own geometry field, and a pinned seed — and a recipe missing those
    // is not a recipe anybody could re-run.
    const sent = sentRecipe(recipe, built)

    // Before the key, because it costs nothing to check and because a run with
    // no source to restyle must not reach fal at all: on the models whose image
    // field is optional it would quietly succeed as text-to-image and charge for
    // it (#28).
    const imageInput = imageInputFor(model, recipe)
    if (imageInput.kind === 'missing') {
      // The same refusal Rust makes on the far side, in the same words: this is
      // simply the cheaper place to find out.
      toast.error(t('generate.error.inputImageNoneNamed'))
      return
    }

    // A job submitted without a key fails at fal.ai after the request is on the
    // wire, which reads as a broken app rather than as a missing setting.
    if (!(await requireFalApiKey(queryClient))) return

    // One job per candidate (#26, PRD §4.2). Rust still takes one call at a
    // time and the semaphore paces them, so this is a queue of `batch` jobs
    // rather than a batch request — three run, the rest wait (PRD §3.3).
    const planned = planBatch(batch)

    // Written down before the submits, because a job can settle before the
    // last `mutateAsync` has even resolved.
    dispatch({
      type: 'beginRun',
      runId: planned.runId,
      projectId: project.id,
      stage,
      generationIds: planned.generationIds,
      at: Date.now(),
    })

    setSubmitting(true)

    // `mutateAsync` per candidate rather than `mutate` with callbacks: one
    // mutation observer keeps only the most recent call's handlers, so three
    // refusals behind one success would have gone out silently.
    const settled = await Promise.allSettled(
      planned.generationIds.map(async generationId => {
        try {
          return await submit.mutateAsync({
            projectId: project.id,
            generationId,
            stage,
            recipe: sent,
            prompt: recipe.prompt,
            modelId: built.modelId,
            params: built.params,
            // The id, not the pixels — Rust reads the file and inlines it as
            // base64 (#28, `docs/research/models-gaps.md` §4).
            imageInput: imageInput.kind === 'names' ? imageInput.input : null,
          })
        } catch (error: unknown) {
          // `useSubmitGeneration` rejects with the reason Rust named, so the
          // refusal can be said in the user's own language (PRD §10.4).
          const refusal: RefusedSubmit = {
            generationId,
            error: error as GenerationError,
          }
          throw refusal
        }
      })
    )

    setSubmitting(false)

    const refused = settled.flatMap(result =>
      result.status === 'rejected' ? [result.reason as RefusedSubmit] : []
    )

    const first = refused.at(0)
    if (first === undefined) return

    // A submit that failed bought nothing and mints nothing, so the run stops
    // waiting for it: a candidate that will never arrive would otherwise hold
    // a place in the grid for the rest of the session.
    dispatch({
      type: 'abandonGenerations',
      generationIds: refused.map(failure => failure.generationId),
    })

    // One click, one refusal — but it has to say how much of the batch went
    // down, because "three of four could not be submitted" and "none of them
    // could" are different things to have just been charged for.
    const reason = generationErrorMessage(t, first.error)
    toast.error(
      refused.length === planned.generationIds.length
        ? reason
        : t('generate.error.someCandidates', {
            failed: refused.length,
            total: planned.generationIds.length,
            reason,
          })
    )
  }
}
