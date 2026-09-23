import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * A modal built on the browser's own `<dialog>`.
 *
 * `showModal()` does the parts that are easy to get wrong by hand: it traps
 * focus, makes the page behind inert to screen readers and the pointer,
 * closes on Escape, and hands focus back to whatever had it when it closes.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className = "",
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Escape and a click outside close it; off for a choice that must be made. */
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const cancel = (event: Event) => {
      event.preventDefault();
      if (dismissible) onClose();
    };
    dialog.addEventListener("cancel", cancel);
    return () => dialog.removeEventListener("cancel", cancel);
  }, [dismissible, onClose]);

  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClick={(event) => {
        // The dialog element itself is the backdrop; its contents sit in a panel.
        if (dismissible && event.target === ref.current) onClose();
      }}
    >
      <div className="dialog-panel">
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        {description ? (
          <div id={descriptionId} className="dialog-description">
            {description}
          </div>
        ) : null}
        {children}
      </div>
    </dialog>
  );
}

export function KeyList({ bindings }: { bindings: Array<{ keys: string[]; action: string }> }) {
  return (
    <dl className="keylist">
      {bindings.map((binding) => (
        <div key={binding.action} className="keylist-row">
          <dt>
            {binding.keys.map((key, index) => (
              <span key={key}>
                {index > 0 ? <span className="keylist-sep"> </span> : null}
                <kbd>{key}</kbd>
              </span>
            ))}
          </dt>
          <dd>{binding.action}</dd>
        </div>
      ))}
    </dl>
  );
}
