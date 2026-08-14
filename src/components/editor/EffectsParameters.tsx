/**
 * The effects tab's controls, in the right sidebar (#36).
 *
 * Here rather than under the picture because that is where every other tab
 * keeps its parameters: the right column is what this stage would generate and
 * what its selection would export, and a look is one more thing you set about
 * the thing in front of you. Putting the knobs in the main pane would have made
 * which column to reach for depend on which tab you were on.
 *
 * It replaces `StageParameters` rather than sitting beside it, for the reason
 * the effects tab is a tab at all: while you are treating a candidate there is
 * no model, no seed and no price to set, so a stage form under the knobs would
 * be a form about something you are not looking at. The export panel stays
 * below, because export is available from every tab and it is what a treatment
 * is *for*.
 */

import { useTranslation } from 'react-i18next'
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
import { isVideoAsset } from '@/lib/export'
import {
  BUILT_IN_LOOKS,
  isDiffusionKernel,
  type EffectsLook,
  type KnobValue,
} from '@/lib/effects'
import { useEditorStore } from '@/store/editor-store'
import { EffectKnob } from './EffectKnobs'
import { useTreatmentTarget } from './use-treatment-target'
import { useGenerationName } from './naming'

export function EffectsParameters() {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const nameOf = useGenerationName()
  const target = useTreatmentTarget()

  if (target === null) return null

  const generation = target.generation
  const { look, values } = target
  const isClip = isVideoAsset(generation?.asset ?? null)

  return (
    <section className="flex flex-col gap-4 p-4">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold">{t('effects.title')}</h2>
        <p className="text-xs text-muted-foreground">
          {generation === null
            ? t('effects.nothingSelected')
            : t('effects.treating', { name: nameOf(generation) })}
        </p>
      </header>

      {generation !== null && (
        <>
          <LookPicker
            library={target.library}
            look={look}
            modified={target.treatment?.lookModified === true}
            onChoose={next =>
              dispatch({
                type: 'chooseLook',
                generationId: generation.id,
                look: next,
              })
            }
          />

          {look !== null && values !== null && (
            <div className="flex flex-col gap-4">
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
                      generationId: generation.id,
                      look,
                      key: knob.key,
                      value,
                    })
                  }
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
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
