import { useEffect, useRef, useState } from "react";

/**
 * The chat input "+" menu, styled after the Claude composer menu: icon +
 * label rows, a chevron on items that open a right-side panel. Two kinds of
 * action:
 *  - "Add files or photos": inline file picker; the images ride with the
 *    next message and the assistant SEES them (Claude vision).
 *  - work order / defect / document / parts: open a right-side ActionPanel
 *    (handled by ChatPage) — NOT a popup.
 */

export type ChatPanelAction = "workorder" | "defect" | "document" | "parts";

function Paperclip() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
function ClipboardList() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M9 12h6" /><path d="M9 16h6" />
    </svg>
  );
}
function Wrench() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.3L3 18l3 3 6.4-6.3a4 4 0 0 0 5.3-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />
    </svg>
  );
}
function DocIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="13" y2="17" />
    </svg>
  );
}
function BoxIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" />
    </svg>
  );
}
function Chevron() {
  return (
    <svg className="cpm__chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export function ChatPlusMenu({
  disabled,
  canManageVessel,
  onAttachFiles,
  onOpenPanel,
}: {
  disabled?: boolean;
  /** Master/Chief-officer-only actions (documents) are hidden otherwise. */
  canManageVessel?: boolean;
  onAttachFiles?: (files: File[]) => void;
  onOpenPanel: (action: ChatPanelAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const panelItem = (action: ChatPanelAction) => () => {
    setOpen(false);
    onOpenPanel(action);
  };

  return (
    <div className="cpm" ref={wrapRef}>
      <button
        type="button"
        className="cpm__plus"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-label="Add"
        aria-expanded={open}
      >
        +
      </button>
      {open && (
        <div className="cpm__menu" role="menu">
          {onAttachFiles && (
            <button type="button" className="cpm__item" onClick={() => { setOpen(false); fileRef.current?.click(); }}>
              <span className="cpm__ico"><Paperclip /></span>
              <span className="cpm__label">Add files or photos</span>
              <span className="cpm__hint">talk about it</span>
            </button>
          )}
          <div className="cpm__sep" />
          <button type="button" className="cpm__item" onClick={panelItem("workorder")}>
            <span className="cpm__ico"><ClipboardList /></span>
            <span className="cpm__label">Create work order</span>
            <Chevron />
          </button>
          <button type="button" className="cpm__item" onClick={panelItem("defect")}>
            <span className="cpm__ico"><Wrench /></span>
            <span className="cpm__label">Report defect</span>
            <Chevron />
          </button>
          {canManageVessel && (
            <button type="button" className="cpm__item" onClick={panelItem("document")}>
              <span className="cpm__ico"><DocIcon /></span>
              <span className="cpm__label">Add document</span>
              <Chevron />
            </button>
          )}
          <button type="button" className="cpm__item" onClick={panelItem("parts")}>
            <span className="cpm__ico"><BoxIcon /></span>
            <span className="cpm__label">Add parts</span>
            <Chevron />
          </button>
        </div>
      )}
      {onAttachFiles && (
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) onAttachFiles(files);
            e.target.value = "";
          }}
        />
      )}
    </div>
  );
}
