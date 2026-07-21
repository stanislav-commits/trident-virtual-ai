import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { PlusIcon, XIcon, TrashIcon } from "./AdminPanelIcons";
import { CrewAccessMatrix } from "./CrewAccessMatrix";
import {
  listCrew,
  createCrew,
  updateCrew,
  deleteCrew,
  fetchCrewCatalog,
  createCrewLogin,
  resetCrewLogin,
  revokeCrewLogin,
  type CrewMemberDto,
  type DepartmentDef,
  type UpsertCrewInput,
  type LoginCredentials,
} from "../../api/crewApi";
import { useAdminShip } from "../../context/AdminShipContext";

interface CrewSectionProps {
  token: string | null;
}

const EMPTY: UpsertCrewInput = {
  name: "",
  department: "deck",
  rank: "",
  email: "",
  phone: "",
  joinedAt: "",
  active: true,
  notes: "",
};

export function CrewSection({ token }: CrewSectionProps) {
  const { selectedShipId } = useAdminShip();
  const shipId = selectedShipId;
  const [crew, setCrew] = useState<CrewMemberDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDef[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<UpsertCrewInput>({ ...EMPTY });
  // freshly issued credentials, shown once after create/reset
  const [creds, setCreds] = useState<LoginCredentials | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  const editing = editId ? crew.find((c) => c.id === editId) ?? null : null;

  const refresh = useCallback(async () => {
    if (!token || !shipId) {
      setCrew([]);
      return;
    }
    setLoading(true);
    try {
      setCrew(await listCrew(token, shipId));
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Failed to load crew");
    } finally {
      setLoading(false);
    }
  }, [token, shipId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!token || !shipId) return;
    let alive = true;
    void fetchCrewCatalog(token, shipId)
      .then((d) => alive && setDepartments(d))
      .catch(() => alive && setDepartments([]));
    return () => {
      alive = false;
    };
  }, [token, shipId]);

  const deptLabel = (key: string) =>
    departments.find((d) => d.key === key)?.label ?? key;
  const ranksFor = (key: string) =>
    departments.find((d) => d.key === key)?.ranks ?? [];

  // Group by department in catalog order, then any leftover departments.
  const groups = useMemo(() => {
    const order = departments.map((d) => d.key);
    const keys = Array.from(new Set(crew.map((c) => c.department)));
    keys.sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return keys.map((key) => ({
      key,
      members: crew.filter((c) => c.department === key),
    }));
  }, [crew, departments]);

  const openCreate = () => {
    setEditId(null);
    setForm({ ...EMPTY });
    setNote("");
    setCreds(null);
    setShowForm(true);
  };

  const openEdit = (c: CrewMemberDto) => {
    setEditId(c.id);
    setForm({
      name: c.name,
      department: c.department,
      rank: c.rank,
      email: c.email ?? "",
      phone: c.phone ?? "",
      joinedAt: c.joinedAt ?? "",
      active: c.active,
      notes: c.notes ?? "",
    });
    setNote("");
    setCreds(null);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setCreds(null);
  };

  // ── login provisioning ──
  const grantLogin = async () => {
    if (!token || !shipId || !editId) return;
    setLoginBusy(true);
    setNote("");
    try {
      setCreds(await createCrewLogin(token, shipId, editId));
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not create login");
    } finally {
      setLoginBusy(false);
    }
  };

  const resetLogin = async () => {
    if (!token || !shipId || !editId) return;
    setLoginBusy(true);
    setNote("");
    try {
      setCreds(await resetCrewLogin(token, shipId, editId));
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not reset password");
    } finally {
      setLoginBusy(false);
    }
  };

  const revokeLogin = async () => {
    if (!token || !shipId || !editId) return;
    if (!window.confirm("Revoke this crew member's login? They won't be able to sign in.")) return;
    setLoginBusy(true);
    setNote("");
    try {
      await revokeCrewLogin(token, shipId, editId);
      setCreds(null);
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not revoke login");
    } finally {
      setLoginBusy(false);
    }
  };

  const submit = async () => {
    if (!token || !shipId || !form.name.trim()) return;
    try {
      if (editId) {
        await updateCrew(token, shipId, editId, form);
      } else {
        await createCrew(token, shipId, form);
      }
      setShowForm(false);
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Save failed");
    }
  };

  const remove = async (c: CrewMemberDto) => {
    if (!token || !shipId) return;
    if (!window.confirm(`Remove ${c.name} from the crew roster?`)) return;
    // Optimistic: drop the crew member instantly, reconcile in the background.
    const prev = crew;
    setCrew((rows) => rows.filter((r) => r.id !== c.id));
    setNote("");
    try {
      await deleteCrew(token, shipId, c.id);
      void refresh();
    } catch (e) {
      setCrew(prev);
      setNote(e instanceof Error ? e.message : "Delete failed");
    }
  };

  if (!shipId) {
    return (
      <div className="crew">
        <p className="crew__empty">Select a vessel to manage its crew.</p>
      </div>
    );
  }

  return (
    <div className="crew">
      <div className="crew__head">
        <div>
          <h2 className="crew__title">Crew roster</h2>
          <p className="crew__sub">
            {crew.length} aboard · {crew.filter((c) => c.active).length} active
          </p>
        </div>
        <div className="crew__actions">
          <button
            type="button"
            className="pms__btn pms__btn--primary"
            onClick={openCreate}
          >
            <PlusIcon /> Add crew
          </button>
        </div>
      </div>

      {note && <div className="pms__import-note">{note}</div>}

      {crew.length === 0 && !loading && (
        <p className="crew__empty">
          No crew yet. Add the captain, engineers and ratings to build the
          roster.
        </p>
      )}

      {groups.map((g) => (
        <div key={g.key} className="crew__group">
          <div className="crew__group-head">
            <span className="crew__group-name">{deptLabel(g.key)}</span>
            <span className="crew__group-count">{g.members.length}</span>
          </div>
          <div className="crew__list">
            {g.members.map((c) => (
              <div
                key={c.id}
                className={`crew__row${c.active ? "" : " crew__row--inactive"}`}
              >
                <div className="crew__rank-badge" title={`Seniority ${c.rankLevel}`}>
                  {c.rankLevel}
                </div>
                <div className="crew__main">
                  <span className="crew__name">{c.name}</span>
                  <span className="crew__rank">{c.rank}</span>
                </div>
                <div className="crew__contact">
                  {c.email && <span>{c.email}</span>}
                  {c.phone && <span>{c.phone}</span>}
                </div>
                {c.hasLogin ? (
                  <span
                    className="crew__login-tag"
                    title={`Login: ${c.loginUserId ?? "—"}`}
                  >
                    🔑 {c.loginUserId}
                  </span>
                ) : (
                  <span className="crew__login-tag crew__login-tag--none">
                    no login
                  </span>
                )}
                {!c.active && <span className="crew__off-tag">inactive</span>}
                <div className="crew__row-actions">
                  <button
                    type="button"
                    className="admin-panel__icon-btn"
                    onClick={() => openEdit(c)}
                    title="Edit"
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="admin-panel__icon-btn admin-panel__icon-btn--danger"
                    onClick={() => void remove(c)}
                    title="Remove"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      <CrewAccessMatrix token={token} shipId={shipId} />

      {showForm &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            onClick={closeForm}
          >
            <div
              className="admin-panel__modal pms__modal"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="admin-panel__modal-header">
                <h3>{editId ? "Edit crew member" : "Add crew member"}</h3>
                <button
                  type="button"
                  className="admin-panel__icon-btn"
                  onClick={closeForm}
                >
                  <XIcon />
                </button>
              </div>

              <div className="admin-panel__modal-form">
                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">Name</label>
                  <input
                    className="admin-panel__input admin-panel__input--full"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Full name"
                    autoFocus
                  />
                </div>

                <div className="crew__form-row">
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">
                      Department
                    </label>
                    <select
                      className="admin-panel__input"
                      value={form.department}
                      onChange={(e) =>
                        setForm({ ...form, department: e.target.value, rank: "" })
                      }
                    >
                      {departments.map((d) => (
                        <option key={d.key} value={d.key}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">Rank</label>
                    <input
                      className="admin-panel__input"
                      value={form.rank ?? ""}
                      list="crew-rank-options"
                      onChange={(e) =>
                        setForm({ ...form, rank: e.target.value })
                      }
                      placeholder="Pick or type a rank"
                    />
                    <datalist id="crew-rank-options">
                      {ranksFor(form.department ?? "").map((r) => (
                        <option key={r.rank} value={r.rank} />
                      ))}
                    </datalist>
                  </div>
                </div>

                <div className="crew__form-row">
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">Email</label>
                    <input
                      className="admin-panel__input"
                      value={form.email ?? ""}
                      onChange={(e) =>
                        setForm({ ...form, email: e.target.value })
                      }
                      placeholder="optional"
                    />
                  </div>
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">Phone</label>
                    <input
                      className="admin-panel__input"
                      value={form.phone ?? ""}
                      onChange={(e) =>
                        setForm({ ...form, phone: e.target.value })
                      }
                      placeholder="optional"
                    />
                  </div>
                </div>

                <div className="crew__form-row">
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">Joined</label>
                    <input
                      type="date"
                      className="admin-panel__input"
                      value={form.joinedAt ?? ""}
                      onChange={(e) =>
                        setForm({ ...form, joinedAt: e.target.value })
                      }
                    />
                  </div>
                  <div className="admin-panel__modal-field crew__active-field">
                    <label className="admin-panel__field-label">Status</label>
                    <label className="crew__checkbox">
                      <input
                        type="checkbox"
                        checked={form.active ?? true}
                        onChange={(e) =>
                          setForm({ ...form, active: e.target.checked })
                        }
                      />
                      Active aboard
                    </label>
                  </div>
                </div>

                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">Notes</label>
                  <textarea
                    className="admin-panel__input admin-panel__input--full pms__textarea"
                    value={form.notes ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, notes: e.target.value })
                    }
                    rows={3}
                    placeholder="Certificates, watch, contract…"
                  />
                </div>

                {/* Login access — only for a saved crew member */}
                {editing ? (
                  <div className="crew__login-block">
                    <div className="crew__login-head">
                      <span className="admin-panel__field-label">
                        Login access
                      </span>
                      {editing.hasLogin && (
                        <span className="crew__login-user">
                          🔑 {editing.loginUserId}
                        </span>
                      )}
                    </div>

                    {creds ? (
                      <div className="crew__creds">
                        <p className="crew__creds-note">
                          Save these now — the password is shown once.
                        </p>
                        <div className="crew__creds-row">
                          <span>Username</span>
                          <code>{creds.userId}</code>
                        </div>
                        <div className="crew__creds-row">
                          <span>Password</span>
                          <code>{creds.password}</code>
                        </div>
                      </div>
                    ) : (
                      <p className="crew__login-hint">
                        {editing.hasLogin
                          ? "This crew member can sign in with the username above."
                          : "No login yet — create one so they can sign in."}
                      </p>
                    )}

                    <div className="crew__login-actions">
                      {!editing.hasLogin ? (
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--ghost"
                          onClick={() => void grantLogin()}
                          disabled={loginBusy}
                        >
                          Create login
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="admin-panel__btn admin-panel__btn--ghost"
                            onClick={() => void resetLogin()}
                            disabled={loginBusy}
                          >
                            Reset password
                          </button>
                          <button
                            type="button"
                            className="admin-panel__btn admin-panel__btn--ghost crew__danger-btn"
                            onClick={() => void revokeLogin()}
                            disabled={loginBusy}
                          >
                            Revoke
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="crew__login-hint">
                    Save the crew member first, then you can grant login access.
                  </p>
                )}

                <div className="admin-panel__modal-actions">
                  <button
                    type="button"
                    className="admin-panel__btn admin-panel__btn--ghost"
                    onClick={closeForm}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="admin-panel__btn admin-panel__btn--primary"
                    onClick={() => void submit()}
                    disabled={!form.name.trim()}
                  >
                    {editId ? "Save changes" : "Add crew"}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
