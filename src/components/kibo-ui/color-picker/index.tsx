'use client'

/**
 * Kibo UI's colour picker — `npx shadcn@latest add
 * https://www.kibo-ui.com/r/color-picker.json` — **with two fixes**.
 *
 * Vendored rather than depended on, which is shadcn's whole model, so these are
 * ours to make. Both are marked `PATCHED` inline. Re-running the `add` command
 * overwrites this file and silently reinstates both, so the diff is worth
 * reading before accepting an update.
 *
 * 1. **Greys and blacks came out red.** The initial hue, saturation and
 *    lightness were read with `||` fallbacks, which treat a legitimate `0` as
 *    missing. `#808080` opened as `#FF0101` and `#333333` as `#660000`. Three of
 *    this app's six palette roles — `ink`, `paper`, `neutral` — are exactly the
 *    colours that breaks.
 * 2. **The `value` prop did not work.** Its sync effect read the incoming colour
 *    as RGB and then assigned red to hue, green to saturation and blue to
 *    lightness, then emitted the result through `onChange` — which changed
 *    `value`, which re-ran the effect. Removed along with the prop rather than
 *    repaired: a control that cannot be controlled is better absent than
 *    documented, and this app mounts a fresh picker per popover anyway, which is
 *    what makes `defaultValue` sufficient.
 *
 * Worth reporting upstream.
 */

import Color from 'color'
import { PipetteIcon } from 'lucide-react'
import { Slider } from 'radix-ui'
import {
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

interface ColorPickerContextValue {
  hue: number
  saturation: number
  lightness: number
  alpha: number
  mode: string
  setHue: (hue: number) => void
  setSaturation: (saturation: number) => void
  setLightness: (lightness: number) => void
  setAlpha: (alpha: number) => void
  setMode: (mode: string) => void
}

const ColorPickerContext = createContext<ColorPickerContextValue | undefined>(
  undefined
)

export const useColorPicker = () => {
  const context = useContext(ColorPickerContext)

  if (!context) {
    throw new Error('useColorPicker must be used within a ColorPickerProvider')
  }

  return context
}

// PATCHED — `HTMLAttributes<HTMLDivElement>` already declares an `onChange`,
// so intersecting left callers with a union of that and this one, and no way to
// destructure `[r, g, b]` from it. The div's is omitted: a colour picker's
// `onChange` reports a colour.
export type ColorPickerProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'onChange'
> & {
  defaultValue?: Parameters<typeof Color>[0]
  onChange?: (value: ColorPickerValue) => void
}

// PATCHED — was `Parameters<typeof Color.rgb>[0]`, i.e. `ColorLike`: a union
// wide enough to include objects and strings, so a caller could not destructure
// the channels. What this actually emits is four numbers, red/green/blue 0–255
// and alpha 0–1.
export type ColorPickerValue = readonly [number, number, number, number]

export const ColorPicker = ({
  defaultValue = '#000000',
  onChange,
  className,
  ...props
}: ColorPickerProps) => {
  const initial = Color(defaultValue)

  // PATCHED — `hue() || 0`, `saturationl() || 100`, `lightness() || 50`.
  // Every one of those treats a legitimate 0 as "absent": a neutral grey has
  // saturation 0, so it opened at saturation 100 and #808080 arrived as
  // #FF0101. Black has lightness 0, so it opened at 50 and became pure red.
  // Greys and near-blacks are three of this app's six palette roles.
  const [hue, setHue] = useState(initial.hue())
  const [saturation, setSaturation] = useState(initial.saturationl())
  const [lightness, setLightness] = useState(initial.lightness())
  const [alpha, setAlpha] = useState(initial.alpha() * 100)
  const [mode, setMode] = useState('hex')

  // PATCHED — `onChange` was in this effect's dependency list, so any caller
  // passing an inline closure (the ordinary way to use it) span forever: the
  // effect fires, the parent sets state, the closure gets a new identity, the
  // effect fires again. Held in a ref instead, so the effect depends only on
  // the colour, which is the thing it is actually reporting.
  const notify = useRef(onChange)

  useEffect(() => {
    notify.current = onChange
  })

  // Notify parent of changes
  useEffect(() => {
    const color = Color.hsl(hue, saturation, lightness).alpha(alpha / 100)
    const rgba = color.rgb().array()

    notify.current?.([rgba[0] ?? 0, rgba[1] ?? 0, rgba[2] ?? 0, alpha / 100])
  }, [hue, saturation, lightness, alpha])

  return (
    <ColorPickerContext.Provider
      value={{
        hue,
        saturation,
        lightness,
        alpha,
        mode,
        setHue,
        setSaturation,
        setLightness,
        setAlpha,
        setMode,
      }}
    >
      <div
        className={cn('flex size-full flex-col gap-4', className)}
        {...props}
      />
    </ColorPickerContext.Provider>
  )
}

export type ColorPickerSelectionProps = HTMLAttributes<HTMLDivElement>

export const ColorPickerSelection = memo(
  ({ className, ...props }: ColorPickerSelectionProps) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const [isDragging, setIsDragging] = useState(false)
    const [positionX, setPositionX] = useState(0)
    const [positionY, setPositionY] = useState(0)
    const { hue, setSaturation, setLightness } = useColorPicker()

    const backgroundGradient = useMemo(() => {
      return `linear-gradient(0deg, rgba(0,0,0,1), rgba(0,0,0,0)),
            linear-gradient(90deg, rgba(255,255,255,1), rgba(255,255,255,0)),
            hsl(${hue}, 100%, 50%)`
    }, [hue])

    const handlePointerMove = useCallback(
      (event: PointerEvent) => {
        if (!(isDragging && containerRef.current)) {
          return
        }
        const rect = containerRef.current.getBoundingClientRect()
        const x = Math.max(
          0,
          Math.min(1, (event.clientX - rect.left) / rect.width)
        )
        const y = Math.max(
          0,
          Math.min(1, (event.clientY - rect.top) / rect.height)
        )
        setPositionX(x)
        setPositionY(y)
        setSaturation(x * 100)
        const topLightness = x < 0.01 ? 100 : 50 + 50 * (1 - x)
        const lightness = topLightness * (1 - y)

        setLightness(lightness)
      },
      [isDragging, setSaturation, setLightness]
    )

    useEffect(() => {
      const handlePointerUp = () => setIsDragging(false)

      if (isDragging) {
        window.addEventListener('pointermove', handlePointerMove)
        window.addEventListener('pointerup', handlePointerUp)
      }

      return () => {
        window.removeEventListener('pointermove', handlePointerMove)
        window.removeEventListener('pointerup', handlePointerUp)
      }
    }, [isDragging, handlePointerMove])

    return (
      <div
        className={cn('relative size-full cursor-crosshair rounded', className)}
        onPointerDown={e => {
          e.preventDefault()
          setIsDragging(true)
          handlePointerMove(e.nativeEvent)
        }}
        ref={containerRef}
        style={{
          background: backgroundGradient,
        }}
        {...props}
      >
        <div
          className="-translate-x-1/2 -translate-y-1/2 pointer-events-none absolute h-4 w-4 rounded-full border-2 border-white"
          style={{
            left: `${positionX * 100}%`,
            top: `${positionY * 100}%`,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
          }}
        />
      </div>
    )
  }
)

ColorPickerSelection.displayName = 'ColorPickerSelection'

export type ColorPickerHueProps = ComponentProps<typeof Slider.Root>

export const ColorPickerHue = ({
  className,
  ...props
}: ColorPickerHueProps) => {
  const { hue, setHue } = useColorPicker()

  return (
    <Slider.Root
      className={cn('relative flex h-4 w-full touch-none', className)}
      max={360}
      // PATCHED — this repo builds with `noUncheckedIndexedAccess`, so a
      // destructured slider value is `number | undefined`.
      onValueChange={([hue]) => setHue(hue ?? 0)}
      step={1}
      value={[hue]}
      {...props}
    >
      <Slider.Track className="relative my-0.5 h-3 w-full grow rounded-full bg-[linear-gradient(90deg,#FF0000,#FFFF00,#00FF00,#00FFFF,#0000FF,#FF00FF,#FF0000)]">
        <Slider.Range className="absolute h-full" />
      </Slider.Track>
      <Slider.Thumb className="block h-4 w-4 rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50" />
    </Slider.Root>
  )
}

export type ColorPickerAlphaProps = ComponentProps<typeof Slider.Root>

export const ColorPickerAlpha = ({
  className,
  ...props
}: ColorPickerAlphaProps) => {
  const { alpha, setAlpha } = useColorPicker()

  return (
    <Slider.Root
      className={cn('relative flex h-4 w-full touch-none', className)}
      max={100}
      onValueChange={([alpha]) => setAlpha(alpha ?? 100)}
      step={1}
      value={[alpha]}
      {...props}
    >
      <Slider.Track className="relative my-0.5 h-3 w-full grow rounded-full bg-[url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVQ4T2NkYGAQYcAP3uCTZhw1gGGYhAGBZIA/nYDCgBDAm9BGDWAAJyRCgLaBCAAgXwixzAS0pgAAAABJRU5ErkJggg==')] bg-center bg-repeat-x dark:bg-[url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALklEQVR4nGP8+vWrCAMewM3N/QafPBM+SWLAqAGDwQBGQgoIpZOB98KoAVQwAADxzQcSVIRCfQAAAABJRU5ErkJggg==')]">
        <div className="absolute inset-0 rounded-full bg-gradient-to-r from-transparent to-black/50 dark:to-white/50" />
        <Slider.Range className="absolute h-full rounded-full bg-transparent" />
      </Slider.Track>
      <Slider.Thumb className="block h-4 w-4 rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50" />
    </Slider.Root>
  )
}

export type ColorPickerEyeDropperProps = ComponentProps<typeof Button>

export const ColorPickerEyeDropper = ({
  className,
  ...props
}: ColorPickerEyeDropperProps) => {
  const { setHue, setSaturation, setLightness, setAlpha } = useColorPicker()

  const handleEyeDropper = async () => {
    try {
      // @ts-expect-error - EyeDropper API is experimental
      const eyeDropper = new EyeDropper()
      const result = await eyeDropper.open()
      const color = Color(result.sRGBHex)
      const [h, s, l] = color.hsl().array()

      setHue(h ?? 0)
      setSaturation(s ?? 0)
      setLightness(l ?? 0)
      setAlpha(100)
    } catch (error) {
      console.error('EyeDropper failed:', error)
    }
  }

  return (
    <Button
      className={cn('shrink-0 text-muted-foreground', className)}
      onClick={handleEyeDropper}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      <PipetteIcon size={16} />
    </Button>
  )
}

export type ColorPickerOutputProps = ComponentProps<typeof SelectTrigger>

const formats = ['hex', 'rgb', 'css', 'hsl']

// PATCHED — `className` was destructured and never applied. Dropped rather
// than spread, because the select below is the whole component.
export const ColorPickerOutput = ({ ...props }: ColorPickerOutputProps) => {
  const { mode, setMode } = useColorPicker()

  return (
    <Select onValueChange={setMode} value={mode}>
      <SelectTrigger className="h-8 w-20 shrink-0 text-xs" {...props}>
        <SelectValue placeholder="Mode" />
      </SelectTrigger>
      <SelectContent>
        {formats.map(format => (
          <SelectItem className="text-xs" key={format} value={format}>
            {format.toUpperCase()}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

type PercentageInputProps = ComponentProps<typeof Input>

const PercentageInput = ({ className, ...props }: PercentageInputProps) => {
  return (
    <div className="relative">
      <Input
        readOnly
        type="text"
        {...props}
        className={cn(
          'h-8 w-[3.25rem] rounded-l-none bg-secondary px-2 text-xs shadow-none',
          className
        )}
      />
      <span className="-translate-y-1/2 absolute top-1/2 right-2 text-muted-foreground text-xs">
        %
      </span>
    </div>
  )
}

export type ColorPickerFormatProps = HTMLAttributes<HTMLDivElement>

export const ColorPickerFormat = ({
  className,
  ...props
}: ColorPickerFormatProps) => {
  const { hue, saturation, lightness, alpha, mode } = useColorPicker()
  const color = Color.hsl(hue, saturation, lightness, alpha / 100)

  if (mode === 'hex') {
    const hex = color.hex()

    return (
      <div
        className={cn(
          '-space-x-px relative flex w-full items-center rounded-md shadow-sm',
          className
        )}
        {...props}
      >
        <Input
          className="h-8 rounded-r-none bg-secondary px-2 text-xs shadow-none"
          readOnly
          type="text"
          value={hex}
        />
        <PercentageInput value={alpha} />
      </div>
    )
  }

  if (mode === 'rgb') {
    const rgb = color
      .rgb()
      .array()
      .map(value => Math.round(value))

    return (
      <div
        className={cn(
          '-space-x-px flex items-center rounded-md shadow-sm',
          className
        )}
        {...props}
      >
        {rgb.map((value, index) => (
          <Input
            className={cn(
              'h-8 rounded-r-none bg-secondary px-2 text-xs shadow-none',
              index && 'rounded-l-none',
              className
            )}
            key={index}
            readOnly
            type="text"
            value={value}
          />
        ))}
        <PercentageInput value={alpha} />
      </div>
    )
  }

  if (mode === 'css') {
    const rgb = color
      .rgb()
      .array()
      .map(value => Math.round(value))

    return (
      <div className={cn('w-full rounded-md shadow-sm', className)} {...props}>
        <Input
          className="h-8 w-full bg-secondary px-2 text-xs shadow-none"
          readOnly
          type="text"
          value={`rgba(${rgb.join(', ')}, ${alpha}%)`}
          {...props}
        />
      </div>
    )
  }

  if (mode === 'hsl') {
    const hsl = color
      .hsl()
      .array()
      .map(value => Math.round(value))

    return (
      <div
        className={cn(
          '-space-x-px flex items-center rounded-md shadow-sm',
          className
        )}
        {...props}
      >
        {hsl.map((value, index) => (
          <Input
            className={cn(
              'h-8 rounded-r-none bg-secondary px-2 text-xs shadow-none',
              index && 'rounded-l-none',
              className
            )}
            key={index}
            readOnly
            type="text"
            value={value}
          />
        ))}
        <PercentageInput value={alpha} />
      </div>
    )
  }

  return null
}
