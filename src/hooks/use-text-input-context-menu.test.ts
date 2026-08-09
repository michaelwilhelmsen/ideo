import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

// The menu itself is native — only the fact that it was asked for matters here
const mockShowTextInputContextMenu = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/context-menu', () => ({
  showTextInputContextMenu: mockShowTextInputContextMenu,
}))

const { useTextInputContextMenu } =
  await import('./use-text-input-context-menu')

/** Right-click an element, reporting whether the default was prevented. */
function rightClick(element: Element): boolean {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
  })
  element.dispatchEvent(event)
  return event.defaultPrevented
}

/** Put an element in the document so the delegated listener can see it. */
function mount(html: string): Element {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host.firstElementChild as Element
}

describe('useTextInputContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    renderHook(() => useTextInputContextMenu())
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it.each([
    ['text input', '<input type="text" />'],
    ['input with no type', '<input />'],
    ['textarea', '<textarea></textarea>'],
    ['contenteditable', '<div contenteditable="true">text</div>'],
  ])('shows the menu on right-click in a %s', (_name, html) => {
    const element = mount(html)

    expect(rightClick(element)).toBe(true)
    expect(mockShowTextInputContextMenu).toHaveBeenCalledTimes(1)
  })

  it('shows the menu for a descendant of a contenteditable host', () => {
    mount('<div contenteditable="true"><b>bold</b></div>')
    const nested = document.querySelector('b') as Element

    expect(rightClick(nested)).toBe(true)
    expect(mockShowTextInputContextMenu).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['checkbox', '<input type="checkbox" />'],
    ['contenteditable="false"', '<div contenteditable="false">text</div>'],
    ['radio', '<input type="radio" />'],
    ['button', '<button>Click</button>'],
    ['plain text', '<p>Just reading</p>'],
  ])('leaves the default behaviour alone on a %s', (_name, html) => {
    const element = mount(html)

    expect(rightClick(element)).toBe(false)
    expect(mockShowTextInputContextMenu).not.toHaveBeenCalled()
  })

  it('stops listening once unmounted', () => {
    const { unmount } = renderHook(() => useTextInputContextMenu())
    const input = mount('<input type="text" />')
    unmount()

    // The hook rendered in beforeEach is still listening, so exactly one call
    rightClick(input)
    expect(mockShowTextInputContextMenu).toHaveBeenCalledTimes(1)
  })
})
