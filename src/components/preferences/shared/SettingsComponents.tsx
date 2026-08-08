import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'

interface SettingsFieldProps {
  label: string
  children: ReactNode
  description?: string
  /** Id of the control the label names, when the field wraps a single input. */
  htmlFor?: string
}

interface SettingsSectionProps {
  title: string
  children: ReactNode
}

export function SettingsField({
  label,
  children,
  description,
  htmlFor,
}: SettingsFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
        {label}
      </Label>
      {children}
      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  )
}

export function SettingsSection({ title, children }: SettingsSectionProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-medium text-foreground">{title}</h3>
        <Separator className="mt-2" />
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}
