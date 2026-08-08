import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { SettingsField, SettingsSection } from '../shared/SettingsComponents'
import {
  useCheckFalApiKey,
  useClearFalApiKey,
  useHasFalApiKey,
  useSaveFalApiKey,
} from '@/services/fal-api-key'
import type { KeyCheck } from '@/lib/tauri-bindings'

const API_KEY_INPUT_ID = 'fal-api-key'

/**
 * Entry, storage and validation of the fal.ai API key.
 *
 * The pasted key goes straight to Rust and is never kept in a store or read
 * back — the only thing this pane knows afterwards is whether a key exists and
 * what the last check said.
 */
export function ApiKeyPane() {
  const { t } = useTranslation()
  const [keyInput, setKeyInput] = useState('')
  const [lastCheck, setLastCheck] = useState<KeyCheck | null>(null)

  const { data: hasKey } = useHasFalApiKey()
  const saveKey = useSaveFalApiKey()
  const checkKey = useCheckFalApiKey()
  const clearKey = useClearFalApiKey()

  // Only the two network calls justify the "checking with fal.ai" message;
  // clearing is local and instant.
  const checking = saveKey.isPending || checkKey.isPending
  const busy = checking || clearKey.isPending

  const handleSave = async () => {
    try {
      const check = await saveKey.mutateAsync(keyInput)
      setLastCheck(check)

      // Drop the key from the field once it has been answered for: stored if
      // it works, useless if it was rejected. Only an unreachable API leaves it
      // in place, so the user can retry without pasting again.
      if (check.outcome === 'valid' || check.outcome === 'rejected') {
        setKeyInput('')
      }
    } catch (error) {
      toast.error(t('toast.error.apiKeySaveFailed'), {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      // The mutation holds the pasted key in `variables` until reset.
      saveKey.reset()
    }
  }

  const handleTest = async () => {
    try {
      setLastCheck(await checkKey.mutateAsync())
    } catch (error) {
      toast.error(t('toast.error.apiKeyTestFailed'), {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  const handleClear = async () => {
    try {
      await clearKey.mutateAsync()
      setLastCheck(null)
      toast.success(t('toast.success.apiKeyCleared'))
    } catch (error) {
      toast.error(t('toast.error.apiKeyClearFailed'), {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection title={t('preferences.apiKey.title')}>
        <SettingsField
          label={t('preferences.apiKey.label')}
          description={t('preferences.apiKey.description')}
          htmlFor={API_KEY_INPUT_ID}
        >
          <Input
            id={API_KEY_INPUT_ID}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={keyInput}
            onChange={e => setKeyInput(e.target.value)}
            placeholder={t('preferences.apiKey.placeholder')}
            disabled={busy}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={handleSave}
              disabled={keyInput.trim().length === 0 || busy}
            >
              {hasKey
                ? t('preferences.apiKey.replace')
                : t('preferences.apiKey.save')}
            </Button>

            {hasKey && (
              <>
                <Button variant="outline" onClick={handleTest} disabled={busy}>
                  {t('preferences.apiKey.test')}
                </Button>
                <Button variant="ghost" onClick={handleClear} disabled={busy}>
                  {t('preferences.apiKey.clear')}
                </Button>
              </>
            )}
          </div>

          <ApiKeyStatus
            checking={checking}
            hasKey={hasKey ?? false}
            check={lastCheck}
          />
        </SettingsField>
      </SettingsSection>
    </div>
  )
}

interface ApiKeyStatusProps {
  checking: boolean
  hasKey: boolean
  check: KeyCheck | null
}

/**
 * The one place an outcome becomes a sentence. Rejected and unreachable read
 * differently on purpose: only the first means the key itself is the problem.
 */
function ApiKeyStatus({ checking, hasKey, check }: ApiKeyStatusProps) {
  const { t } = useTranslation()

  if (checking) {
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Spinner className="size-4" />
        {t('preferences.apiKey.checking')}
      </p>
    )
  }

  const message = (): string => {
    switch (check?.outcome) {
      case 'valid':
        return check.balance === null
          ? t('preferences.apiKey.valid')
          : t('preferences.apiKey.validWithBalance', {
              balance: check.balance.toFixed(2),
            })
      case 'rejected':
        return t('preferences.apiKey.rejected')
      case 'unreachable':
        return t('preferences.apiKey.unreachable')
      case 'unexpected':
        return t('preferences.apiKey.unexpected', { status: check.status })
      case 'missing':
        return t('preferences.apiKey.none')
      default:
        return hasKey
          ? t('preferences.apiKey.saved')
          : t('preferences.apiKey.none')
    }
  }

  const isProblem =
    check !== null && check.outcome !== 'valid' && check.outcome !== 'missing'

  return (
    <p
      role="status"
      className={
        isProblem ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'
      }
    >
      {message()}
    </p>
  )
}
