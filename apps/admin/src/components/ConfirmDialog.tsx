"use client";

import { useEffect, useRef } from "react";

export interface ConfirmProps {
  title: string;
  /** The plain-language consequence, not a restatement of the button. */
  body: React.ReactNode;
  /** Shown as a prominent band — the thing they might not have noticed. */
  warning?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "warn";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Centred confirmation dialog, replacing window.confirm().
 *
 * The native dialog cannot show the one thing that actually matters here —
 * how much stock is about to disappear — and it renders differently in every
 * browser. This one is deliberately not dismissible by clicking the backdrop:
 * destructive actions should need a real decision, not a stray click.
 */
export function ConfirmDialog({
  title,
  body,
  warning,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus starts on Cancel, so Enter never confirms a destructive action by
  // accident.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div className="modal-bg" role="presentation">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
      >
        <div className={`modal-icon ${tone}`} aria-hidden="true">
          {tone === "danger" ? "!" : "?"}
        </div>

        <h2 id="confirm-title">{title}</h2>
        <div id="confirm-body" className="modal-body">
          {body}
        </div>

        {warning && <div className={`modal-warn ${tone}`}>{warning}</div>}

        <div className="modal-actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn ghost"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === "danger" ? "btn solid-danger" : "btn"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
