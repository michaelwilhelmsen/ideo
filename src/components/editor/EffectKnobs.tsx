/**
 * The controls a look's knob descriptors draw.
 *
 * Nothing here knows what a duotone is. A look declares its knobs once — name,
 * kind, range, step, default — and that one declaration drives the control, the
 * validation of a hand-edited fork and the shader's uniform binding. Adding a
 * look is data plus (maybe) a shader, never data plus a shader plus a form.
 *
 * So this file is a `switch` on `kind` and nothing else. If it ever grows a
 * branch on a knob's *key*, the declaration has stopped being the single source
 * and something has gone wrong upstream.
 *
 * A genuinely bespoke control — a curve editor, a paired ink swatch — gets an
 * escape hatch when one earns it. Not up front.
 */

import { useTranslation } from 'react-i18next'
import {
  ColorPicker,
  ColorPickerEyeDropper,
  ColorPickerHue,
  ColorPickerSelection,
} from '@/components/kibo-ui/color-picker'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { isHex } from '@/lib/recipe'
import type { KnobDescriptor, KnobValue } from '@/lib/effects'

/** Which options are unavailable here, and the one reason they all share. */
export interface KnobRefusal {
  readonly values: readonly string[]
  /** A translation key, shown under the control (PRD §10.1). */
  readonly reasonKey: string
}

export function EffectKnob({
  knob,
  value,
  refused,
  onChange,
}: {
  knob: KnobDescriptor
  value: KnobValue
  refused?: KnobRefusal
  onChange: (next: KnobValue) => void
}) {
  const { t } = useTranslation()
  const id = `effect-knob-${knob.key}`
  // The label is a translation key built from the knob's own identifier, so a
  // look that grows a knob gets a label by adding one string to `/locales`. The
  // key itself is the fallback, which is what a fork with a knob we have no
  // word for renders as — legible, and obviously ours to fix.
  const label = t(`effects.knob.${knob.key}`, { defaultValue: knob.key })

  switch (knob.kind) {
    case 'slider':
      return (
        <Field>
          <FieldLabel htmlFor={id}>
            {label}
            {/* The number beside the name, because a slider with no readout
                cannot be set to a value somebody wrote down. */}
            <span className="ms-auto font-mono text-xs text-muted-foreground">
              {formatNumber(Number(value), knob.step)}
            </span>
          </FieldLabel>
          <Slider
            id={id}
            min={knob.min}
            max={knob.max}
            step={knob.step}
            value={[Number(value)]}
            onValueChange={([next]) => {
              if (next !== undefined) onChange(next)
            }}
          />
        </Field>
      )

    case 'angle':
      return (
        <Field>
          <FieldLabel htmlFor={id}>
            {label}
            <span className="ms-auto font-mono text-xs text-muted-foreground">
              {`${Math.round(Number(value))}°`}
            </span>
          </FieldLabel>
          {/* A full turn, and the ends meet: 360 is 0, so dragging past either
              end is not a wall — `coerceKnobValue` wraps whatever arrives. */}
          <Slider
            id={id}
            min={0}
            max={360}
            step={1}
            value={[Number(value) % 360]}
            onValueChange={([next]) => {
              if (next !== undefined) onChange(next)
            }}
          />
        </Field>
      )

    case 'colour': {
      const hex = isHex(value) ? value : '#000000'
      return (
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <div className="flex items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  id={id}
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={t('effects.pickColour', { name: label })}
                  className="shrink-0 rounded-sm"
                  // The one place a hex is a colour rather than a word. Inline
                  // because it is data, and a class cannot hold a value.
                  style={{ backgroundColor: hex }}
                />
              </PopoverTrigger>
              <PopoverContent className="w-64">
                {/* Mounted only while open, so it re-reads the current value
                    each time rather than drifting from it. */}
                <ColorPicker
                  className="gap-3"
                  defaultValue={hex}
                  onChange={([red, green, blue]) =>
                    onChange(hexFrom(red, green, blue))
                  }
                >
                  <ColorPickerSelection className="h-32" />
                  <div className="flex items-center gap-2">
                    <ColorPickerEyeDropper />
                    <ColorPickerHue />
                  </div>
                </ColorPicker>
              </PopoverContent>
            </Popover>
            <span className="font-mono text-xs text-muted-foreground">
              {hex}
            </span>
          </div>
        </Field>
      )
    }

    case 'choice': {
      const blocked = refused?.values ?? []
      return (
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Select value={String(value)} onValueChange={next => onChange(next)}>
            <SelectTrigger id={id} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {knob.options.map(option => (
                <SelectItem
                  key={option}
                  value={option}
                  // Disabled with the reason under the control rather than
                  // hidden (PRD §10.1): a knob that quietly loses two entries
                  // between a still and its own animation looks broken, and
                  // silently substituting one would mean an export that does
                  // not match what is on screen.
                  disabled={blocked.includes(option)}
                >
                  {t(`effects.option.${knob.key}.${option}`, {
                    defaultValue: option,
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {blocked.length > 0 && refused !== undefined && (
            <FieldDescription>{t(refused.reasonKey)}</FieldDescription>
          )}
        </Field>
      )
    }

    case 'toggle':
      return (
        <Field>
          <div className="flex items-center gap-2">
            <Switch
              id={id}
              checked={value === true}
              onCheckedChange={next => onChange(next)}
            />
            <Label htmlFor={id}>{label}</Label>
          </div>
        </Field>
      )
  }
}

/**
 * The value, at the precision its own step can express.
 *
 * A step of 1 has no decimals and a step of 0.01 has two — derived rather than
 * hardcoded, so a knob declaring a finer step reads correctly without anything
 * here changing.
 */
function formatNumber(value: number, step: number): string {
  const places = Math.max(0, Math.ceil(-Math.log10(step)))
  return value.toFixed(Math.min(places, 4))
}

function hexFrom(red: number, green: number, blue: number): string {
  const byte = (channel: number): string =>
    Math.round(Math.min(255, Math.max(0, channel)))
      .toString(16)
      .padStart(2, '0')
  return `#${byte(red)}${byte(green)}${byte(blue)}`.toUpperCase()
}
