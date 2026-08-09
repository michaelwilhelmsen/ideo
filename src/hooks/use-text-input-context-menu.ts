import { useEffect } from 'react'
import { showTextInputContextMenu } from '@/lib/context-menu'
import { logger } from '@/lib/logger'

/**
 * Input types that hold no editable text — right-clicking these should keep the
 * webview's default behaviour rather than offering Cut/Copy/Paste.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

/**
 * Whether a right-click landed on something the user can type into.
 */
function isTextEntryElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  // The click can land on a descendant of the editable host, so ask the
  // subtree, not just the element. (jsdom implements neither `isContentEditable`
  // nor inherited editability, which is why the attribute is consulted too.)
  if (target.isContentEditable) return true
  if (target.closest('[contenteditable]:not([contenteditable="false"])')) {
    return true
  }
  if (target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLInputElement) {
    // `type` normalises unknown/missing values to 'text'
    return !NON_TEXT_INPUT_TYPES.has(target.type)
  }
  return false
}

/**
 * Shows the native text-editing context menu (Undo/Redo, Cut/Copy/Paste,
 * Select All) when the user right-clicks an input, textarea or contenteditable.
 *
 * A webview has no context menu of its own, so without this a right-click in a
 * text field offers no way to paste. Non-text targets keep default behaviour.
 *
 * Attach once per window, next to the other startup effects.
 */
export function useTextInputContextMenu() {
  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      if (!isTextEntryElement(event.target)) return

      event.preventDefault()
      showTextInputContextMenu().catch(error => {
        logger.warn('Failed to show text input context menu', { error })
      })
    }

    document.addEventListener('contextmenu', handleContextMenu)
    return () => document.removeEventListener('contextmenu', handleContextMenu)
  }, [])
}
