import { useEffect, useRef, useState } from "react";

interface EditableCellProps {
  value: string | null;
  placeholder?: string;
  saving?: boolean;
  /** Called on Enter — return the new value. Empty string is null. */
  onSave: (next: string | null) => Promise<void> | void;
  /** Custom render when not editing. Defaults to plain text or em-dash. */
  renderDisplay?: (value: string | null) => React.ReactNode;
  /** If true, prevent editing (e.g. for fields locked by other state). */
  disabled?: boolean;
  className?: string;
}

/**
 * One-cell inline editor — double-click to enter edit mode, Enter to save,
 * Escape to cancel. Used in the asset register table so admins can fix a
 * typo in name / brand / model / SFI code without opening a separate form.
 */
export function EditableCell({
  value,
  placeholder = "—",
  saving = false,
  onSave,
  renderDisplay,
  disabled = false,
  className,
}: EditableCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // External value changes (e.g. parent refetched) should sync into draft
  // when we're not actively editing.
  useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  const handleStartEdit = (e: React.MouseEvent) => {
    if (disabled || saving) return;
    e.stopPropagation();
    setEditing(true);
  };

  const handleCommit = async () => {
    const trimmed = draft.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next === (value ?? null)) {
      setEditing(false);
      return;
    }
    try {
      await onSave(next);
      setEditing(false);
    } catch {
      // parent toasts the error; keep edit mode open so user can retry/cancel
    }
  };

  const handleCancel = () => {
    setDraft(value ?? "");
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`editable-cell editable-cell--input ${className ?? ""}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void handleCommit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            handleCancel();
          }
        }}
        onBlur={() => void handleCommit()}
        onClick={(e) => e.stopPropagation()}
        disabled={saving}
        placeholder={placeholder}
      />
    );
  }

  const display = renderDisplay
    ? renderDisplay(value)
    : value ?? <span className="editable-cell__placeholder">{placeholder}</span>;

  return (
    <span
      className={`editable-cell ${disabled ? "editable-cell--disabled" : "editable-cell--editable"} ${className ?? ""}`}
      onDoubleClick={handleStartEdit}
      title={disabled ? undefined : "Double-click to edit"}
    >
      {saving ? <span className="editable-cell__saving">…</span> : display}
    </span>
  );
}
