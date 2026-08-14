/**
 * The fourth tab — a look, applied live, to whatever is selected (#36).
 *
 * **A tab, not a stage.** No model, no seed, no price, no queue, no batch of
 * four, no verdicts. Effects are instant, free and deterministic, so "generate
 * four and pick one" is the wrong interaction: you turn a knob and watch.
 *
 * **What it operates on.** The current selection by default; "Treat this" pins a
 * specific candidate, and the pin is sticky — changing your selection elsewhere
 * must not silently move you onto a different generation's treatment mid-edit.
 *
 * **Where it renders.** WebGL2, in the webview, for the preview *and* (later)
 * the bake — one program, so the exported file cannot disagree with what was on
 * screen. The two error-diffusion kernels are the deliberate exception: they
 * decide each pixel from pixels already decided, so they go to Rust, stills
 * only, and the picker disables them on a clip with the reason attached rather
 * than hiding them or silently substituting blue noise.
 *
 * **Fit by default, 1:1 on demand.** Composition is judged at fit; a dither cell
 * is only judged honestly at pixel scale. The shader re-renders at whatever
 * zoom is showing, so 1:1 is *exact* rather than an upscaled approximation —
 * nothing here has to be labelled "approximate".
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { isVideoAsset } from '@/lib/export'
import {
  BUILT_IN_LOOKS,
  inksFor,
  isDiffusionKernel,
  lookFor,
  rampBetween,
  resolveTreatment,
  seedTreatmentFrom,
  type EffectsLook,
  type Ink,
  type KnobValue,
} from '@/lib/effects'
import {
  generationById,
  selectedGeneration,
  sourcePresetById,
  stylePresetById,
  type Generation,
  type Preset,
  type Project,
  type StageKind,
} from '@/lib/recipe'
import { useLookLibrary, useTreatedStill } from '@/services/effects'
import { useEditorStore } from '@/store/editor-store'
import { EffectKnob } from './EffectKnobs'
import { useEffectsPreview } from './use-effects-preview'
import { useGenerationName } from './naming'
import { assetSource } from './assets'
import { EmptyPreview } from './shared'

export function EffectsTab({
  project,
  stage,
}: {
  project: Project
  stage: StageKind
}) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const directory = useEditorStore(store => store.state.directory)
  const pinned = useEditorStore(store => store.state.treatmentTarget)
  const nameOf = useGenerationName()
  const library = useLookLibrary()

  const [actualSize, setActualSize] = useState(false)

  // The pin wins where it names something this project still has; otherwise the
  // tab follows the selection, which is what it does before anybody pins
  // anything.
  const target =
    (pinned === null ? null : generationById(project, pinned)) ??
    selectedGeneration(project, stage)

  const treatment = target?.treatment ?? null
  const look = lookFor(treatment, library)

  // Offered on every render, and refused by the reducer wherever a treatment
  // already exists — which is what makes "a seed, never a lock" a property of
  // the reducer rather than of this effect's dependency array.
  useEffect(() => {
    if (target === null || target.treatment !== null) return

    const seed = seedTreatmentFrom(
      presetOfRecipe(target),
      library,
      project.palette
    )
    if (seed === null) return

    dispatch({
      type: 'seedTreatment',
      generationId: target.id,
      treatment: seed,
    })
  }, [target, library, project.palette, dispatch])

  if (target === null) {
    return (
      <EmptyPreview
        aspect={project.aspect}
        messageKey="effects.nothingSelected"
      />
    )
  }

  const values =
    treatment !== null && look !== null
      ? resolveTreatment(treatment, look, project.palette)
      : null

  const source = assetSource(directory, target.asset)
  const isClip = isVideoAsset(target.asset)

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-medium">{nameOf(target)}</h2>
        {pinned === target.id ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => dispatch({ type: 'unpinTreatment' })}
          >
            {t('effects.unpin')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              dispatch({ type: 'pinTreatment', generationId: target.id })
            }
          >
            {t('effects.treatThis')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ms-auto"
          onClick={() => setActualSize(current => !current)}
        >
          {t(actualSize ? 'effects.zoom.fit' : 'effects.zoom.actual')}
        </Button>
      </header>

      <TreatedPreview
        generation={target}
        source={source}
        look={look}
        values={values}
        inks={values === null ? [] : inksOf(project, values)}
        projectId={project.id}
        aspect={project.aspect}
        actualSize={actualSize}
      />

      <LookPicker
        library={library}
        look={look}
        modified={treatment?.lookModified === true}
        onChoose={next =>
          dispatch({
            type: 'chooseLook',
            generationId: target.id,
            look: next,
          })
        }
      />

      {look !== null && values !== null && (
        <div className="space-y-3">
          {look.knobs.map(knob => (
            <EffectKnob
              key={knob.key}
              knob={knob}
              value={values[knob.key] as KnobValue}
              refused={
                // Error diffusion crawls between frames; blue noise holds
                // still. Disabled with the reason rather than hidden or
                // silently substituted — an export that did not match the
                // control on screen would be the worse failure.
                knob.kind === 'choice' && knob.key === 'kernel' && isClip
                  ? {
                      values: knob.options.filter(isDiffusionKernel),
                      reasonKey: 'effects.reason.diffusionOnClip',
                    }
                  : undefined
              }
              onChange={value =>
                dispatch({
                  type: 'setKnob',
                  generationId: target.id,
                  look,
                  key: knob.key,
                  value,
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The picture, however it has to be produced.
 *
 * Three states, and the component's whole job is choosing between them: no
 * treatment at all shows the original, a diffusion kernel shows what Rust sent
 * back, and everything else is the shader.
 */
function TreatedPreview({
  generation,
  source,
  look,
  values,
  inks,
  projectId,
  aspect,
  actualSize,
}: {
  generation: Generation
  source: string | null
  look: EffectsLook | null
  values: Readonly<Record<string, KnobValue>> | null
  inks: readonly Ink[]
  projectId: string
  aspect: string
  actualSize: boolean
}) {
  const { t } = useTranslation()
  const frame = useRef<HTMLDivElement>(null)

  const kernel = values?.kernel
  const onCpu =
    typeof kernel === 'string' &&
    isDiffusionKernel(kernel) &&
    !isVideoAsset(generation.asset)

  const still = useTreatedStill(
    onCpu && look !== null && values !== null
      ? {
          projectId,
          generationId: generation.id,
          effect: {
            inks: inks.map(ink => ink.hex),
            kernel: kernel as 'floydSteinberg' | 'atkinson',
            paletteShaped: values.levelPlacement !== 'even',
          },
        }
      : null
  )

  const { canvas, unsupported } = useEffectsPreview({
    frame,
    source,
    look,
    values,
    inks,
    actualSize,
    // The GPU path stands down entirely while Rust owns the picture, rather
    // than drawing something and being covered up — a shader running under an
    // image nobody sees is a frame's work per tick for nothing.
    enabled: !onCpu,
    isClip: isVideoAsset(generation.asset),
  })

  if (source === null) {
    return <EmptyPreview aspect={aspect} messageKey="effects.noFile" />
  }

  return (
    <div className="space-y-2">
      <div
        ref={frame}
        className={cn(
          'flex justify-center rounded-md border border-border bg-muted/30',
          actualSize ? 'overflow-auto' : 'overflow-hidden'
        )}
      >
        {look === null ? (
          // Untreated is a real state and shows the original, rather than an
          // empty box that reads as a broken preview.
          <img src={source} alt="" className="max-w-full" />
        ) : onCpu ? (
          still.data === undefined ? (
            <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
              {t(still.isError ? 'effects.failed' : 'effects.rendering')}
            </div>
          ) : (
            <img
              src={still.data}
              alt=""
              className={actualSize ? 'max-w-none' : 'max-w-full'}
            />
          )
        ) : (
          <canvas
            ref={canvas}
            className={actualSize ? 'max-w-none' : 'max-w-full'}
          />
        )}
      </div>

      {unsupported && look !== null && !onCpu && (
        <FieldDescription>{t('effects.noWebgl')}</FieldDescription>
      )}
    </div>
  )
}

function LookPicker({
  library,
  look,
  modified,
  onChoose,
}: {
  library: readonly EffectsLook[]
  look: EffectsLook | null
  modified: boolean
  onChoose: (look: EffectsLook | null) => void
}) {
  const { t } = useTranslation()

  const mine = library.filter(
    entry => !BUILT_IN_LOOKS.some(builtIn => builtIn.id === entry.id)
  )

  return (
    <Field>
      <FieldLabel htmlFor="effects-look">
        {t('effects.look')}
        {modified && (
          <span className="ms-auto text-xs text-muted-foreground">
            {t('effects.modified')}
          </span>
        )}
      </FieldLabel>
      <Select
        value={look?.id ?? NONE}
        onValueChange={id =>
          onChoose(
            id === NONE ? null : (library.find(e => e.id === id) ?? null)
          )
        }
      >
        <SelectTrigger id="effects-look" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {/* "None" is a look you can choose rather than a clear button, so
              "give me the untreated plate" is one gesture in the same control
              that took you away from it. */}
          <SelectItem value={NONE}>{t('effects.none')}</SelectItem>
          <SelectGroup>
            <SelectLabel>{t('effects.builtIn')}</SelectLabel>
            {BUILT_IN_LOOKS.map(entry => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectGroup>
          {mine.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t('effects.yours')}</SelectLabel>
              {mine.map(entry => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      {look?.blurb != null && <FieldDescription>{look.blurb}</FieldDescription>}
    </Field>
  )
}

/** A `Select` cannot hold an empty value, so "no look" needs a word. */
const NONE = 'none'

/**
 * The inks this frame reduces to.
 *
 * A duotone is a **ramp between its two inks**, built here rather than in the
 * shader so the CPU path and the GPU path reduce to the same colours — the
 * shader interpolates the same two endpoints, and Rust is handed the ramp
 * already resolved. A palette reduction takes the project's own entries, which
 * is #46's palette doing the job it exists for.
 */
function inksOf(
  project: Project,
  values: Readonly<Record<string, KnobValue>>
): readonly Ink[] {
  if (typeof values.entries === 'number') {
    return inksFor(project.palette, values.entries)
  }

  const dark = typeof values.inkDark === 'string' ? values.inkDark : null
  const light = typeof values.inkLight === 'string' ? values.inkLight : null
  if (dark === null || light === null) return []

  const levels = typeof values.levels === 'number' ? values.levels : 2
  return rampBetween(dark, light, levels)
}

/**
 * The preset a candidate's recipe names, from whichever composing library holds
 * it.
 *
 * Both are asked because a recipe records one id and this tab does not know
 * which stage produced it — the same reason `presetById` asks all three. Only a
 * `Preset` carries #53's declarations, so a movement resolves to `null` here
 * rather than to an error.
 */
function presetOfRecipe(generation: Generation): Preset | null {
  const id = generation.recipe.presetId
  if (id === null) return null
  return stylePresetById(id) ?? sourcePresetById(id)
}
