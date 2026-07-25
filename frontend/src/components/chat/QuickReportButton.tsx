import { useEffect, useRef, useState } from "react";
import { reportDefect, uploadTaskPhoto } from "../../api/pmsApi";
import { listAssets } from "../../api/assetsApi";

/**
 * The chat's "+" attach menu — messenger-style. Two actions:
 *  - attach photos/files to the AI conversation (handled by the parent via
 *    onAttachFiles; the assistant SEES images),
 *  - quick defect report (IDEA Yacht Snag List / MaintainX-style): saw it →
 *    photographed it → one small form → defect register + unplanned task
 *    with the photos attached. Deliberately few fields; optional asset link.
 */

const DEPARTMENTS = [
  { key: "", label: "—" },
  { key: "deck", label: "Deck" },
  { key: "engine", label: "Engine" },
  { key: "interior", label: "Interior" },
  { key: "galley", label: "Galley" },
];

interface AssetSuggestion {
  id: string;
  assetIdInternal: string;
  displayName: string;
}

export function QuickReportButton({
  token,
  shipId,
  disabled,
  onAttachFiles,
}: {
  token: string | null;
  shipId: string | null | undefined;
  disabled?: boolean;
  /** "Attach to conversation" — files are handed to the chat composer. */
  onAttachFiles?: (files: File[]) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);

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
        aria-label="Attach or report"
        title="Attach a photo or report a defect"
      >
        +
      </button>
      {menuOpen && (
        <div className="qr__menu" role="menu">
          {onAttachFiles && (
            <button
              type="button"
              className="qr__menu-item"
              onClick={() => {
                setMenuOpen(false);
                attachInputRef.current?.click();
              }}
            >
              📷 Attach photo or file
              <span className="qr__menu-sub">
                Add it to the conversation — the assistant will see it
              </span>
            </button>
          )}
          <button
            type="button"
            className="qr__menu-item"
            onClick={() => {
              setMenuOpen(false);
              setModalOpen(true);
            }}
          >
            🔧 Report defect
            <span className="qr__menu-sub">
              Breakage or issue — lands in the defect register + maintenance
              plan with your photos
            </span>
          </button>
        </div>
      )}
      {onAttachFiles && (
        <input
          ref={attachInputRef}
          type="file"
          accept="image/*,.pdf"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) onAttachFiles(files);
            e.target.value = "";
          }}
        />
      )}
      {modalOpen && (
        <QuickReportModal
          token={token}
          shipId={shipId}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

function QuickReportModal({
  token,
  shipId,
  onClose,
}: {
  token: string;
  shipId: string;
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

  // Optional equipment link — debounced search over the asset register.
  const [assetQuery, setAssetQuery] = useState("");
  const [assetOptions, setAssetOptions] = useState<AssetSuggestion[]>([]);
  const [asset, setAsset] = useState<AssetSuggestion | null>(null);
  const [assetOpen, setAssetOpen] = useState(false);

  useEffect(() => {
    if (asset || assetQuery.trim().length < 2) {
      setAssetOptions([]);
      return;
    }
    const t = window.setTimeout(() => {
      listAssets(token, shipId, { search: assetQuery.trim(), limit: 8 })
        .then((r) =>
          setAssetOptions(
            r.items.map((a) => ({
              id: a.id,
              assetIdInternal: a.assetIdInternal,
              displayName: a.displayName,
            })),
          ),
        )
        .catch(() => setAssetOptions([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [assetQuery, asset, token, shipId]);

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
        type: "defect",
        title: title.trim(),
        description: details.trim() || null,
        department: department || null,
        assetId: asset?.id ?? null,
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
            <h3 className="qr__title">Defect logged</h3>
            <p className="qr__done-text">
              Unplanned task <strong>{done.taskCode ?? "created"}</strong> is in
              the maintenance plan and the defect register
              {asset ? (
                <>
                  , linked to <strong>{asset.displayName}</strong>
                </>
              ) : null}
              .{done.photos > 0 && <> {done.photos} photo(s) attached.</>}
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
            <h3 className="qr__title">🔧 Report defect</h3>
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
              <span className="qr__label">Equipment (optional)</span>
              {asset ? (
                <div className="qr__asset-picked">
                  <span className="qr__asset-code">{asset.assetIdInternal}</span>
                  <span className="qr__asset-name">{asset.displayName}</span>
                  <button
                    type="button"
                    className="qr__asset-clear"
                    onClick={() => {
                      setAsset(null);
                      setAssetQuery("");
                    }}
                    aria-label="Clear equipment"
                    disabled={busy}
                  >
                    ×
                  </button>
                </div>
              ) : (
                <div className="qr__asset-search">
                  <input
                    className="qr__input"
                    placeholder="Search the asset register — e.g. fan, compressor, DG1…"
                    value={assetQuery}
                    onChange={(e) => {
                      setAssetQuery(e.target.value);
                      setAssetOpen(true);
                    }}
                    onFocus={() => setAssetOpen(true)}
                    disabled={busy}
                  />
                  {assetOpen && assetOptions.length > 0 && (
                    <div className="qr__asset-options">
                      {assetOptions.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          className="qr__asset-option"
                          onClick={() => {
                            setAsset(a);
                            setAssetOpen(false);
                          }}
                        >
                          <span className="qr__asset-code">{a.assetIdInternal}</span>
                          <span className="qr__asset-name">{a.displayName}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

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
              Lands in the defect register and the maintenance plan as an
              unplanned task, with your photos attached.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
