import { useEffect, useRef, useState } from "react";
import { reportDefect, uploadTaskPhoto } from "../../api/pmsApi";

/**
 * The chat's "+" quick-report entry — the messenger-style attach affordance
 * (same pattern MaintainX/UpKeep use for "report an issue", and IDEA Yacht's
 * Snag List): saw it → photographed it → it becomes an unplanned task in the
 * maintenance plan (defects also land in the defect register). Deliberately
 * few fields: type, what happened, department, photos.
 */

type ReportType = "defect" | "incident";

const DEPARTMENTS = [
  { key: "", label: "—" },
  { key: "deck", label: "Deck" },
  { key: "engine", label: "Engine" },
  { key: "interior", label: "Interior" },
  { key: "galley", label: "Galley" },
];

export function QuickReportButton({
  token,
  shipId,
  disabled,
}: {
  token: string | null;
  shipId: string | null | undefined;
  disabled?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalType, setModalType] = useState<ReportType | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  if (!token || !shipId) return null;

  return (
    <div className="qr" ref={wrapRef}>
      <button
        type="button"
        className="qr__plus"
        onClick={() => setMenuOpen((o) => !o)}
        disabled={disabled}
        aria-label="Quick actions"
        title="Report a defect or incident"
      >
        +
      </button>
      {menuOpen && (
        <div className="qr__menu" role="menu">
          <button
            type="button"
            className="qr__menu-item"
            onClick={() => {
              setMenuOpen(false);
              setModalType("defect");
            }}
          >
            🔧 Report defect
            <span className="qr__menu-sub">
              Breakage — goes to the defect register + maintenance plan
            </span>
          </button>
          <button
            type="button"
            className="qr__menu-item"
            onClick={() => {
              setMenuOpen(false);
              setModalType("incident");
            }}
          >
            ⚠️ Report incident
            <span className="qr__menu-sub">
              Occurrence needing follow-up — becomes an unplanned task
            </span>
          </button>
        </div>
      )}
      {modalType && (
        <QuickReportModal
          token={token}
          shipId={shipId}
          type={modalType}
          onClose={() => setModalType(null)}
        />
      )}
    </div>
  );
}

function QuickReportModal({
  token,
  shipId,
  type,
  onClose,
}: {
  token: string;
  shipId: string;
  type: ReportType;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [department, setDepartment] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{
    taskCode: string | null;
    photos: number;
    failedPhotos: number;
  } | null>(null);

  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await reportDefect(token, shipId, {
        type,
        title: title.trim(),
        description: details.trim() || null,
        department: department || null,
      });
      let uploaded = 0;
      let failed = 0;
      for (const file of files) {
        try {
          await uploadTaskPhoto(token, shipId, created.taskId, file, "issue");
          uploaded++;
        } catch {
          failed++;
        }
      }
      setDone({ taskCode: created.taskCode, photos: uploaded, failedPhotos: failed });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create the report");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="qr__overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="qr__modal" role="dialog" aria-modal="true">
        {done ? (
          <>
            <div className="qr__done-icon">✅</div>
            <h3 className="qr__title">
              {type === "defect" ? "Defect logged" : "Incident logged"}
            </h3>
            <p className="qr__done-text">
              Unplanned task <strong>{done.taskCode ?? "created"}</strong> is in
              the maintenance plan
              {type === "defect" ? " and the defect register" : ""}.
              {done.photos > 0 && <> {done.photos} photo(s) attached.</>}
              {done.failedPhotos > 0 && (
                <>
                  {" "}
                  <span className="qr__error">
                    {done.failedPhotos} photo(s) failed to upload — you can add
                    them from the task card.
                  </span>
                </>
              )}
            </p>
            <div className="qr__actions">
              <button type="button" className="qr__btn qr__btn--primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="qr__title">
              {type === "defect" ? "🔧 Report defect" : "⚠️ Report incident"}
            </h3>
            <input
              className="qr__input"
              placeholder="What happened? (short title)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              autoFocus
              disabled={busy}
            />
            <textarea
              className="qr__input qr__textarea"
              placeholder="Details — where, circumstances, what you already did… (optional)"
              rows={3}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              disabled={busy}
            />
            <div className="qr__row">
              <span className="qr__label">Department</span>
              <div className="qr__chips">
                {DEPARTMENTS.map((d) => (
                  <button
                    key={d.key}
                    type="button"
                    className={`qr__chip${department === d.key ? " qr__chip--on" : ""}`}
                    onClick={() => setDepartment(d.key)}
                    disabled={busy}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="qr__row">
              <label className="qr__photo-add">
                📷 Add photos
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  disabled={busy}
                  onChange={(e) => {
                    setFiles((prev) => [
                      ...prev,
                      ...Array.from(e.target.files ?? []),
                    ]);
                    e.target.value = "";
                  }}
                />
              </label>
              {previews.length > 0 && (
                <div className="qr__previews">
                  {previews.map((url, i) => (
                    <div key={url} className="qr__preview">
                      <img src={url} alt={files[i]?.name ?? "photo"} />
                      <button
                        type="button"
                        className="qr__preview-del"
                        aria-label="Remove photo"
                        onClick={() =>
                          setFiles((prev) => prev.filter((_, j) => j !== i))
                        }
                        disabled={busy}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {error && <div className="qr__error">{error}</div>}
            <div className="qr__actions">
              <button
                type="button"
                className="qr__btn"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="qr__btn qr__btn--primary"
                onClick={() => void submit()}
                disabled={busy || !title.trim()}
              >
                {busy ? "Creating…" : "Create task"}
              </button>
            </div>
            <p className="qr__hint">
              {type === "defect"
                ? "Lands in the defect register and the maintenance plan as an unplanned task, with your photos attached."
                : "Becomes an unplanned task in the maintenance plan, with your photos attached."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
