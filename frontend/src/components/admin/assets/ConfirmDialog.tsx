import { createPortal } from "react-dom";
import { useState } from "react";
import { XIcon } from "../AdminPanelIcons";

interface ConfirmDialogProps {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** When set, the confirm button stays disabled until the user types this
   *  exact word (case-insensitive). Used for catastrophic actions. */
  requireText?: string;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Generic confirmation modal. Reused for single-asset delete (plain) and
 * clear-all (type-to-confirm). Styling matches the admin-panel modals.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  requireText,
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const gate =
    !requireText || typed.trim().toUpperCase() === requireText.toUpperCase();
  const canConfirm = gate && !busy;

  return createPortal(
    <div
      className="admin-panel__modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ap-confirm-title"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="admin-panel__modal">
        <button
          type="button"
          className="admin-panel__modal-close"
          onClick={onCancel}
          disabled={busy}
          aria-label="Close"
        >
          <XIcon />
        </button>

        <div className="admin-panel__modal-head">
          <h2 id="ap-confirm-title" className="admin-panel__modal-title">
            {title}
          </h2>
          <p className="admin-panel__modal-desc">{message}</p>
        </div>

        {requireText && (
          <div className="admin-panel__modal-field">
            <label className="admin-panel__field-label">
              Type <strong>{requireText}</strong> to confirm
            </label>
            <input
              type="text"
              className="admin-panel__input admin-panel__input--full"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={requireText}
              autoFocus
              disabled={busy}
              autoComplete="off"
            />
          </div>
        )}

        {error && (
          <div className="assets-section__banner assets-section__banner--err">
            {error}
          </div>
        )}

        <div className="admin-panel__modal-actions">
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--ghost"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`admin-panel__btn ${danger ? "admin-panel__btn--danger" : "admin-panel__btn--primary"}`}
            onClick={onConfirm}
            disabled={!canConfirm}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
