/**
 * The fourth tab — a look, applied live, to whatever is selected (#36).
 *
 * **A tab, not a stage.** No model, no seed, no price, no queue, no batch of
 * four, no verdicts. Effects are instant, free and deterministic, so "generate
 * four and pick one" is the wrong interaction: you turn a knob and watch.
 *
 * **The picture is here; the controls are in the right sidebar.** That is the
 * layout every other tab already keeps — parameters live in one column and the
 * result lives in the other, so which pane to reach for never depends on which
 * tab you are on. See `EffectsParameters`, which is what the sidebar renders in
 * place of a stage's form while this tab is open.
 *
 * **What it operates on.** The current selection by default; "Treat this" pins a
 * specific candidate, and the pin is sticky — changing your selection elsewhere
 * must not silently move you onto a different generation's treatment mid-edit.
 *
 * **Where it renders.** WebGL2, in the webview, for the preview *and* the bake —
 * one program, so the exported file cannot disagree with what was on screen. The
 * two error-diffusion kernels are the deliberate exception: they decide each
 * pixel from pixels already decided, so they go to Rust, stills only.
 *
 * **Fit by default, 1:1 on demand.** Composition is judged at fit; a dither cell
 * is only judged honestly at pixel scale. The shader re-renders at whatever
 * zoom is showing, so 1:1 is *exact* rather than an upscaled approximation —
 * nothing here has to be labelled "approximate".
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { FieldDescription } from '@/components/ui/field'
import { cn } from '@/lib/utils'
import { isVideoAsset } from '@/lib/export'
import {
  isDiffusionKernel,
  seedTreatmentFrom,
  type EffectsLook,
  type Ink,
  type KnobValue,
} from '@/lib/effects'
import {
  sourcePresetById,
  stylePresetById,
  type Generation,
  type Preset,
} from '@/lib/recipe'
import { useTreatedStill } from '@/services/effects'
import { useEditorStore } from '@/store/editor-store'
import { useEffectsPreview } from './use-effects-preview'
import { useTreatmentTarget } from './use-treatment-target'
import { useGenerationName } from './naming'
import { assetSource } from './assets'
import { EmptyPreview } from './shared'

export function EffectsTab() {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const directory = useEditorStore(store => store.state.directory)
  const nameOf = useGenerationName()
  const target = useTreatmentTarget()

  const [actualSize, setActualSize] = useState(false)

  // Offered on every render, and refused by the reducer wherever a treatment
  // already exists — which is what makes "a seed, never a lock" a property of
  // the reducer rather than of this effect's dependency array.
  //
  // Here rather than in the shared hook, because this component is only mounted
  // while the tab is open: a sidebar that seeded a candidate the user was not
  // looking at would be a lock wearing a seed's clothes.
  const generation = target?.generation ?? null
  const library = target?.library
  const palette = target?.project.palette

  useEffect(() => {
    if (generation === null || generation.treatment !== null) return
    if (library === undefined || palette === undefined) return

    const seed = seedTreatmentFrom(presetOfRecipe(generation), library, palette)
    if (seed === null) return

    dispatch({
      type: 'seedTreatment',
      generationId: generation.id,
      treatment: seed,
    })
  }, [generation, library, palette, dispatch])

  if (target === null) return null

  if (target.generation === null) {
    return (
      <EmptyPreview
        aspect={target.project.aspect}
        messageKey="effects.nothingSelected"
      />
    )
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-medium">{nameOf(target.generation)}</h2>
        {target.pinned ? (
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
              dispatch({
                type: 'pinTreatment',
                generationId: target.generation?.id ?? '',
              })
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
        generation={target.generation}
        source={assetSource(directory, target.generation.asset)}
        look={target.look}
        values={target.values}
        inks={target.inks}
        projectId={target.project.id}
        aspect={target.project.aspect}
        actualSize={actualSize}
      />
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
