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
  freezeDraft,
  imageParamShape,
  loopsOnEndFrame,
  modelById,
  planRun,
  sentRecipe,
  MODEL_REGISTRY,
  type DraftNode,
  type ModelCapabilities,
  type Project,
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
 * What a stage needs to send its input images — a list, or a refusal.
 *
 * `missing` earns its own variant because it is not an empty list: a source
 * model legitimately sends no image, while a model that *has* an image field and
 * no input generation to point it at must not submit at all. The Nano Banana
 * edit endpoints do not require their image field, so the same call without a
 * source is a paid text-to-image of whatever the prompt happens to say (#28) —
 * and a caller reading an empty list would not be able to tell the two apart.
 */
type ResolvedImageInputs =
  | { readonly kind: 'names'; readonly inputs: readonly ImageInput[] }
  | { readonly kind: 'missing' }

/**
 * The image fields this run fills, in the order the model reads them.
 *
 * Empty on a source model, one entry on every other stage — and two on a
 * looping animate: PRD §4.5's seamless loop is the start still sent again as
 * the end frame, so both entries name the *same* generation and differ only in
 * the field they go in. Rust encodes it once.
 */
function imageInputsFor(
  model: ModelCapabilities,
  recipe: StageRecipe
): ResolvedImageInputs {
  const shape = imageParamShape(model.imageParam)
  if (model.imageParam === null || shape === null) {
    return { kind: 'names', inputs: [] }
  }

  // Whichever candidate the stage is working from — a generated source or one
  // the user dropped in (#27). Both are a file in the assets folder named after
  // their generation, which is the whole reason the upload converged on that
  // shape and the reason this needs no branch for it.
  const generationId = recipe.inputGenerationId
  if (generationId === null) return { kind: 'missing' }

  const inputs: ImageInput[] = [
    { generationId, param: model.imageParam, shape },
  ]

  // Derived rather than read off `options.loop` alone (#30): the first/last-
  // frame endpoints loop whether or not the switch was touched, and a model
  // with no end-frame field does not loop even when a carried-over `true` says
  // it should. `loopsOnEndFrame` is the one place that judgement is made.
  //
  // The end frame is the *same* still. That is the whole mechanism — no ffmpeg,
  // no provider-side blend — and it is why both entries carry one generation id.
  const endShape = imageParamShape(model.endFrameParam)
  if (
    model.endFrameParam !== null &&
    endShape !== null &&
    loopsOnEndFrame(model, recipe.options)
  ) {
    inputs.push({
      generationId,
      param: model.endFrameParam,
      shape: endShape,
    })
  }

  return { kind: 'names', inputs }
}

/**
 * Running a node, across every model it fans out to (ADR 0005).
 *
 * Every line below is kind-agnostic — the registry says what goes on the wire,
 * `freezeDraft` says what the node is working from, and `imageInputsFor` says
 * which file to send and under what name.
 *
 * What ADR 0005 changed here is the arity. `freezeDraft` is now called **once
 * per model**, because a fan-out is several recipes rather than one recipe sent
 * several times: each candidate records the model that made it and the
 * parameter bag reconciled for that model. Everything downstream of that —
 * one `runId` across the lot, one job per candidate, one grid to choose from —
 * is the batching machinery #26 already had, given more to batch.
 *
 * `perModel` rather than `batch`, and the distinction is the money: three models
 * at two candidates each is six paid calls, and a parameter named `batch` would
 * have read as two.
 */
export function useRunNode(
  project: Project,
  node: DraftNode,
  perModel: number
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
    // One job per candidate, `perModel` candidates per model (#26, PRD §4.2,
    // ADR 0005). Rust still takes one call at a time and the semaphore paces
    // them, so this is a queue rather than a batch request — three run, the rest
    // wait (PRD §3.3).
    const planned = planRun(node.draft.modelIds, perModel)

    // Frozen **per model**, and everything a submit needs is resolved with it.
    // Each candidate of one run has to describe itself completely and
    // separately, because a fan-out is several recipes: they share a prompt and
    // a seed setting, and they disagree about the model, the parameter names and
    // the endpoint. Each carries the draft's own prompt exactly as the form has
    // it — seeding a preset into that box happened earlier and elsewhere (#28),
    // so what is sent is what is on screen.
    const prepared = planned.candidates.map(candidate => {
      const recipe = freezeDraft(
        MODEL_REGISTRY,
        project,
        node,
        candidate.modelId
      )
      if (recipe === null) return null

      // The registry decides what goes on the wire (#25): the endpoint, the
      // aspect idiom, our defaults rather than fal's, a seed only where there is
      // a field for one, and — the reason a restyle needs nothing else here — a
      // negative only on a model with a `negativePromptParam` and a strength
      // only on one with a `strengthParam`, since a field the model does not
      // declare is dropped rather than concatenated into the prompt (PRD §9).
      // `modelById` throws on an id with no entry, so an unknown model fails
      // here rather than as a 422 after the charge (PRD §5).
      const model = modelById(MODEL_REGISTRY, recipe.modelId)
      const built = buildRequest(model, project.aspect, recipe)

      return {
        generationId: candidate.generationId,
        recipe,
        // What is persisted is what went to fal, not what the form said (AC10):
        // the built body resolves our defaults, the project's locked ratio as
        // this model's own geometry field, and a pinned seed — and a recipe
        // missing those is not a recipe anybody could re-run.
        sent: sentRecipe(recipe, built),
        built,
        // Before the key, because it costs nothing to check and because a run
        // with no source to restyle must not reach fal at all: on the models
        // whose image field is optional it would quietly succeed as
        // text-to-image and charge for it (#28).
        inputs: imageInputsFor(model, recipe),
      }
    })

    // Any refusal takes the **whole** run with it rather than submitting the
    // rest. The refusals here are all about the node — no input to work from, no
    // file to send — so they are true for every model in the fan-out at once,
    // and a partial submit would charge for half a comparison nobody asked for.
    const head = prepared.at(0)
    if (head === undefined || prepared.some(entry => entry === null)) {
      toast.error(t('generate.error.inputImageUnusable'))
      return
    }
    if (prepared.some(entry => entry?.inputs.kind === 'missing')) {
      // The same refusal Rust makes on the far side, in the same words: this is
      // simply the cheaper place to find out.
      toast.error(t('generate.error.inputImageNoneNamed'))
      return
    }

    // A job submitted without a key fails at fal.ai after the request is on the
    // wire, which reads as a broken app rather than as a missing setting.
    if (!(await requireFalApiKey(queryClient))) return

    // Written down before the submits, because a job can settle before the
    // last `mutateAsync` has even resolved.
    dispatch({
      type: 'beginRun',
      runId: planned.runId,
      projectId: project.id,
      nodeId: node.id,
      generationIds: planned.candidates.map(entry => entry.generationId),
      at: Date.now(),
    })

    setSubmitting(true)

    // `mutateAsync` per candidate rather than `mutate` with callbacks: one
    // mutation observer keeps only the most recent call's handlers, so three
    // refusals behind one success would have gone out silently.
    const settled = await Promise.allSettled(
      prepared.map(async entry => {
        // Narrowed above — every entry is non-null and every input list is
        // `names` by this point, or the run was refused whole.
        if (entry === null || entry.inputs.kind === 'missing') return null

        try {
          return await submit.mutateAsync({
            projectId: project.id,
            generationId: entry.generationId,
            stage: node.kind,
            recipe: entry.sent,
            prompt: entry.recipe.prompt,
            modelId: entry.built.modelId,
            params: entry.built.params,
            // The ids, not the pixels — Rust reads the file and inlines it as
            // base64 (#28, `docs/research/models-gaps.md` §4), once per
            // generation however many fields name it (#30).
            imageInputs: [...entry.inputs.inputs],
          })
        } catch (error: unknown) {
          // `useSubmitGeneration` rejects with the reason Rust named, so the
          // refusal can be said in the user's own language (PRD §10.4).
          const refusal: RefusedSubmit = {
            generationId: entry.generationId,
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

    // One click, one refusal — but it has to say how much of the run went down,
    // because "three of six could not be submitted" and "none of them could"
    // are different things to have just been charged for.
    const reason = generationErrorMessage(t, first.error)
    toast.error(
      refused.length === planned.candidates.length
        ? reason
        : t('generate.error.someCandidates', {
            failed: refused.length,
            total: planned.candidates.length,
            reason,
          })
    )
  }
}
