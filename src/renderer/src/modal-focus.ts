import { type RefObject, useLayoutEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'details > summary:first-of-type',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

interface ModalEntry {
  id: symbol
  dialog: HTMLElement
  opener: HTMLElement | null
  initialFocus: HTMLElement | null
  closeOnEscape: () => void
  escapeEnabled: boolean
}

interface IsolatedElementState {
  hadInert: boolean
  ariaHidden: string | null
}

const modalStack: ModalEntry[] = []
const isolatedElements = new Map<HTMLElement, IsolatedElementState>()
let lastApplicationFocus: HTMLElement | null = null

if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (event) => {
      if (modalStack.length === 0 && event.target instanceof HTMLElement) {
        lastApplicationFocus = event.target
      }
    },
    true,
  )
}

function visibleFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.isConnected &&
      !element.closest('[inert], [aria-hidden="true"]') &&
      !element.matches(':disabled') &&
      getComputedStyle(element).visibility !== 'hidden' &&
      getComputedStyle(element).display !== 'none' &&
      element.getClientRects().length > 0,
  )
}

function restoreBackgroundAccess(): void {
  for (const [element, state] of isolatedElements) {
    if (state.hadInert) element.setAttribute('inert', '')
    else element.removeAttribute('inert')

    if (state.ariaHidden === null) element.removeAttribute('aria-hidden')
    else element.setAttribute('aria-hidden', state.ariaHidden)
  }
  isolatedElements.clear()
}

function isolateElement(element: HTMLElement): void {
  if (!isolatedElements.has(element)) {
    isolatedElements.set(element, {
      hadInert: element.hasAttribute('inert'),
      ariaHidden: element.getAttribute('aria-hidden'),
    })
  }
  element.setAttribute('inert', '')
  element.setAttribute('aria-hidden', 'true')
}

function isolateModalBackground(): void {
  restoreBackgroundAccess()
  const active = modalStack.at(-1)
  if (!active?.dialog.isConnected) return

  let activeBranch: HTMLElement | null = active.dialog
  while (activeBranch && activeBranch !== document.body) {
    const parent: HTMLElement | null = activeBranch.parentElement
    if (!parent) break
    for (const sibling of parent.children) {
      if (sibling !== activeBranch && sibling instanceof HTMLElement) isolateElement(sibling)
    }
    activeBranch = parent
  }
}

function focusEntry(entry: ModalEntry): void {
  if (!entry.dialog.isConnected) return
  const requested = entry.initialFocus
  if (
    requested?.isConnected &&
    entry.dialog.contains(requested) &&
    !requested.matches(':disabled')
  ) {
    requested.focus()
    return
  }
  const first = visibleFocusableElements(entry.dialog)[0]
  if (first) first.focus()
  else entry.dialog.focus()
}

function focusActiveModal(): void {
  const active = modalStack.at(-1)
  if (active) focusEntry(active)
}

function canRestoreFocus(element: HTMLElement | null): boolean {
  return Boolean(
    element?.isConnected && !element.matches(':disabled') && !element.closest('[inert]'),
  )
}

function restoreEntryFocus(entry: ModalEntry): void {
  let attempts = 0
  const attempt = (): void => {
    const activeModal = modalStack.at(-1)
    if (activeModal) {
      if (
        entry.opener &&
        canRestoreFocus(entry.opener) &&
        activeModal.dialog.contains(entry.opener)
      ) {
        entry.opener.focus()
      } else {
        focusActiveModal()
      }
      return
    }

    const currentFocus = document.activeElement
    if (
      currentFocus instanceof HTMLElement &&
      currentFocus !== document.body &&
      currentFocus !== entry.opener &&
      !entry.dialog.contains(currentFocus)
    ) {
      return
    }
    if (entry.opener && canRestoreFocus(entry.opener)) {
      entry.opener.focus()
      return
    }
    if (!entry.opener?.isConnected || attempts >= 120) return
    attempts += 1
    window.requestAnimationFrame(attempt)
  }
  attempt()
}

export interface ModalFocusOptions {
  dialogRef: RefObject<HTMLElement | null>
  initialFocusRef?: RefObject<HTMLElement | null>
  onEscape?: () => void
  escapeEnabled?: boolean
}

/**
 * Provides one consistent accessible focus boundary for renderer dialogs.
 *
 * The newest mounted dialog owns keyboard input. Earlier dialogs and the application beneath the
 * active backdrop are made inert until the top dialog closes, after which focus returns to the
 * element that opened it whenever that element still exists.
 */
export function useModalFocus({
  dialogRef,
  initialFocusRef,
  onEscape,
  escapeEnabled = true,
}: ModalFocusOptions): void {
  const entryRef = useRef<ModalEntry | null>(null)
  const onEscapeRef = useRef(onEscape)
  const escapeEnabledRef = useRef(escapeEnabled)
  onEscapeRef.current = onEscape
  escapeEnabledRef.current = escapeEnabled

  useLayoutEffect(() => {
    const entry = entryRef.current
    if (!entry) return
    entry.initialFocus = initialFocusRef?.current ?? null
    entry.closeOnEscape = () => onEscapeRef.current?.()
    entry.escapeEnabled = Boolean(onEscapeRef.current) && escapeEnabledRef.current
    if (modalStack.at(-1)?.id === entry.id && !entry.dialog.contains(document.activeElement)) {
      focusEntry(entry)
    }
  })

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const activeElement =
      document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : lastApplicationFocus
    const entry: ModalEntry = {
      id: Symbol('modal'),
      dialog,
      opener: activeElement,
      initialFocus: initialFocusRef?.current ?? null,
      closeOnEscape: () => onEscapeRef.current?.(),
      escapeEnabled: Boolean(onEscapeRef.current) && escapeEnabledRef.current,
    }
    entryRef.current = entry
    modalStack.push(entry)
    focusEntry(entry)
    isolateModalBackground()

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (modalStack.at(-1)?.id !== entry.id) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (entry.escapeEnabled) entry.closeOnEscape()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = visibleFocusableElements(entry.dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        entry.dialog.focus()
        return
      }

      const first = focusable[0]
      const last = focusable.at(-1) ?? first
      const activeElement = document.activeElement
      if (!entry.dialog.contains(activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && (activeElement === first || activeElement === entry.dialog)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (activeElement === last || activeElement === entry.dialog)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      const index = modalStack.findIndex((candidate) => candidate.id === entry.id)
      if (index >= 0) modalStack.splice(index, 1)
      entryRef.current = null
      isolateModalBackground()
      restoreEntryFocus(entry)
      if (modalStack.length === 0) restoreBackgroundAccess()
    }
  }, [dialogRef, initialFocusRef])
}
