import { useCallback, type ReactNode } from 'react';

/** Text fields a dialog may give the focus to when it opens (not a checkbox or a switch: they would show a ring). */
const FIELD = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea';

/**
 * Where the keyboard focus lands when a dialog or a side panel opens: its first text field, else the content itself,
 * never the close button (Mantine's focus trap takes the first `data-autofocus`, then the first button, which is the
 * close button and shows a focus ring nobody asked for). Returns a ref for the element that holds the content.
 * A field already marked `data-autofocus` keeps the focus.
 */
export function useDialogFocus<T extends HTMLElement>() {
  return useCallback((node: T | null) => {
    if (!node || node.querySelector('[data-autofocus]')) return;
    const field = node.querySelector<HTMLElement>(FIELD);
    // A disabled or read-only field, or one that opens a list when focused (select), does not take it.
    if (field && !field.matches(':disabled, [readonly], [aria-haspopup]')) {
      field.setAttribute('data-autofocus', '');
      return;
    }
    node.tabIndex = -1;
    node.setAttribute('data-autofocus', '');
    node.classList.add('dialog-focus');
  }, []);
}

/** The content of a modal: takes the focus when the modal opens (see `useDialogFocus`). */
export function DialogFocus({ children }: { children: ReactNode }) {
  const ref = useDialogFocus<HTMLDivElement>();
  return <div ref={ref}>{children}</div>;
}
