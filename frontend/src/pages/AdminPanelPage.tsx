import { useCallback, useEffect, useState } from 'react';
import {
  createUser,
  deleteUser,
  getUsers,
  resetPassword,
  createShip,
  deleteShip,
  getShips,
  getMetricDefinitions,
  getMetrics,
  createMetric,
  updateMetric,
  deleteMetric,
  updateShip,
  type UserListItem,
  type ShipListItem,
  type MetricDefinitionItem,
} from '../api/client';
import { useAdminPanel } from '../context/AdminPanelContext';
import { useAuth } from '../context/AuthContext';
import logoImg from '../assets/logo-chats.png';

const UsersIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

const ShipIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1 .6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" />
    <path d="M19.38 20A11.6 11.6 0 0 0 21 14l-9-4-9 4c0 2.9.94 5.34 2.81 7.76" />
    <path d="M19 13V7a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v6" />
    <path d="M12 10v4" />
    <path d="M12 7V3" />
  </svg>
);

const MetricsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3v18h18" />
    <path d="M18 17V9" />
    <path d="M13 17V5" />
    <path d="M8 17v-3" />
  </svg>
);

const ChevronLeftIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

const MenuIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </svg>
);

const XIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const CopyIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export function AdminPanelPage() {
  const { close } = useAdminPanel();
  const { token } = useAuth();
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createRole, setCreateRole] = useState<'user' | 'admin'>('user');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ userId: string; password: string } | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<{ userId: string; password: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; userId: string } | null>(null);
  const [activeSection, setActiveSection] = useState<'users' | 'ships' | 'metrics'>('users');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const [ships, setShips] = useState<ShipListItem[]>([]);
  const [metricDefinitions, setMetricDefinitions] = useState<MetricDefinitionItem[]>([]);
  const [shipsLoading, setShipsLoading] = useState(false);
  const [shipForm, setShipForm] = useState({ name: '', serialNumber: '', metricKeys: [] as string[], userIds: [] as string[] });
  const [creatingShip, setCreatingShip] = useState(false);
  const [editingShipId, setEditingShipId] = useState<string | null>(null);
  const [deletingShipId, setDeletingShipId] = useState<string | null>(null);
  const [shipDeleteConfirm, setShipDeleteConfirm] = useState<{ id: string; name: string } | null>(null);

  const [metrics, setMetrics] = useState<MetricDefinitionItem[]>([]);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricForm, setMetricForm] = useState({ key: '', label: '', description: '', unit: '', dataType: 'numeric' });
  const [creatingMetric, setCreatingMetric] = useState(false);
  const [editingMetricKey, setEditingMetricKey] = useState<string | null>(null);
  const [metricDeleteConfirm, setMetricDeleteConfirm] = useState<{ key: string; label: string } | null>(null);
  const [deletingMetricKey, setDeletingMetricKey] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      setUsers(await getUsers(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const loadShips = useCallback(async () => {
    if (!token) return;
    setShipsLoading(true);
    setError('');
    try {
      const [shipsList, metrics, usersList] = await Promise.all([
        getShips(token),
        getMetricDefinitions(token),
        getUsers(token),
      ]);
      setShips(shipsList);
      setMetricDefinitions(metrics);
      setUsers(usersList);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load ships');
    } finally {
      setShipsLoading(false);
    }
  }, [token]);

  useEffect(() => { if (activeSection === 'ships') loadShips(); }, [activeSection, loadShips]);

  const loadMetrics = useCallback(async () => {
    if (!token) return;
    setMetricsLoading(true);
    setError('');
    try {
      setMetrics(await getMetrics(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load metrics');
    } finally {
      setMetricsLoading(false);
    }
  }, [token]);

  useEffect(() => { if (activeSection === 'metrics') loadMetrics(); }, [activeSection, loadMetrics]);

  const handleShipCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !shipForm.name.trim()) return;
    setCreatingShip(true);
    setError('');
    try {
      await createShip({
        name: shipForm.name.trim(),
        serialNumber: shipForm.serialNumber.trim() || undefined,
        metricKeys: shipForm.metricKeys,
        userIds: shipForm.userIds.length ? shipForm.userIds : undefined,
      }, token);
      setShipForm({ name: '', serialNumber: '', metricKeys: [], userIds: [] });
      loadShips();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create ship');
    } finally {
      setCreatingShip(false);
    }
  };

  const handleShipEdit = (ship: ShipListItem) => {
    setEditingShipId(ship.id);
    setShipForm({
      name: ship.name,
      serialNumber: ship.serialNumber ?? '',
      metricKeys: ship.metricsConfig.map((c) => c.metricKey),
      userIds: (ship.assignedUsers ?? []).map((u) => u.id),
    });
  };

  const handleShipEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !editingShipId || !shipForm.name.trim()) return;
    setCreatingShip(true);
    setError('');
    try {
      await updateShip(editingShipId, {
        name: shipForm.name.trim(),
        serialNumber: shipForm.serialNumber.trim() || null,
        metricKeys: shipForm.metricKeys,
        userIds: shipForm.userIds,
      }, token);
      setEditingShipId(null);
      setShipForm({ name: '', serialNumber: '', metricKeys: [], userIds: [] });
      loadShips();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update ship');
    } finally {
      setCreatingShip(false);
    }
  };

  const handleShipDeleteClick = (id: string, name: string) => setShipDeleteConfirm({ id, name });
  const handleShipDeleteCancel = () => setShipDeleteConfirm(null);

  const handleShipDeleteConfirm = async () => {
    if (!token || !shipDeleteConfirm) return;
    setDeletingShipId(shipDeleteConfirm.id);
    setError('');
    setShipDeleteConfirm(null);
    try {
      await deleteShip(shipDeleteConfirm.id, token);
      loadShips();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete ship');
    } finally {
      setDeletingShipId(null);
    }
  };

  const toggleMetricKey = (key: string) => {
    setShipForm((prev) => ({
      ...prev,
      metricKeys: prev.metricKeys.includes(key) ? prev.metricKeys.filter((k) => k !== key) : [...prev.metricKeys, key],
    }));
  };

  const toggleShipUserId = (id: string) => {
    setShipForm((prev) => ({
      ...prev,
      userIds: prev.userIds.includes(id) ? prev.userIds.filter((x) => x !== id) : [...prev.userIds, id],
    }));
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setCreating(true);
    setError('');
    setCreated(null);
    try {
      const result = await createUser(createRole, token);
      setCreated({ userId: result.userId, password: result.password });
      loadUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create user');
    } finally {
      setCreating(false);
    }
  };

  const handleResetPassword = async (id: string) => {
    if (!token) return;
    setResettingId(id);
    setError('');
    setResetResult(null);
    try {
      const result = await resetPassword(id, token);
      setResetResult({ userId: result.userId, password: result.password });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reset password');
    } finally {
      setResettingId(null);
    }
  };

  const handleDeleteClick = (id: string, userId: string) => setDeleteConfirm({ id, userId });
  const handleDeleteCancel = () => setDeleteConfirm(null);

  const handleDeleteConfirm = async () => {
    if (!token || !deleteConfirm) return;
    setDeletingId(deleteConfirm.id);
    setError('');
    setDeleteConfirm(null);
    try {
      await deleteUser(deleteConfirm.id, token);
      setResetResult(null);
      loadUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete user');
    } finally {
      setDeletingId(null);
    }
  };

  const copyToClipboard = (text: string) => navigator.clipboard.writeText(text);

  const handleNavClick = (section: 'users' | 'ships' | 'metrics') => {
    setActiveSection(section);
    setIsSidebarOpen(false);
  };

  const handleMetricCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !metricForm.key.trim() || !metricForm.label.trim()) return;
    setCreatingMetric(true);
    setError('');
    try {
      await createMetric(
        {
          key: metricForm.key.trim(),
          label: metricForm.label.trim(),
          description: metricForm.description.trim() || undefined,
          unit: metricForm.unit.trim() || undefined,
          dataType: metricForm.dataType.trim() || 'numeric',
        },
        token,
      );
      setMetricForm({ key: '', label: '', description: '', unit: '', dataType: 'numeric' });
      loadMetrics();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create metric');
    } finally {
      setCreatingMetric(false);
    }
  };

  const handleMetricEdit = (m: MetricDefinitionItem) => {
    setEditingMetricKey(m.key);
    setMetricForm({
      key: m.key,
      label: m.label,
      description: m.description ?? '',
      unit: m.unit ?? '',
      dataType: m.dataType ?? 'numeric',
    });
  };

  const handleMetricEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !editingMetricKey || !metricForm.label.trim()) return;
    setCreatingMetric(true);
    setError('');
    try {
      await updateMetric(
        editingMetricKey,
        {
          label: metricForm.label.trim(),
          description: metricForm.description.trim() || undefined,
          unit: metricForm.unit.trim() || undefined,
          dataType: metricForm.dataType.trim() || 'numeric',
        },
        token,
      );
      setEditingMetricKey(null);
      setMetricForm({ key: '', label: '', description: '', unit: '', dataType: 'numeric' });
      loadMetrics();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update metric');
    } finally {
      setCreatingMetric(false);
    }
  };

  const handleMetricDeleteClick = (key: string, label: string) => setMetricDeleteConfirm({ key, label });
  const handleMetricDeleteCancel = () => setMetricDeleteConfirm(null);

  const handleMetricDeleteConfirm = async () => {
    if (!token || !metricDeleteConfirm) return;
    setDeletingMetricKey(metricDeleteConfirm.key);
    setError('');
    setMetricDeleteConfirm(null);
    try {
      await deleteMetric(metricDeleteConfirm.key, token);
      loadMetrics();
      if (activeSection === 'ships') loadShips();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete metric');
    } finally {
      setDeletingMetricKey(null);
    }
  };

  return (
    <div className="admin-panel">
      {isSidebarOpen && (
        <div className="admin-panel__overlay" onClick={() => setIsSidebarOpen(false)} aria-hidden="true" />
      )}

      <aside className={`admin-panel__sidebar ${isSidebarOpen ? 'admin-panel__sidebar--open' : ''}`} aria-label="Admin navigation">
        <div className="admin-panel__sidebar-brand">
          <img src={logoImg} alt="" className="admin-panel__brand-logo" />
          <div className="admin-panel__brand-text">
            <span className="admin-panel__brand-name">Trident</span>
            <span className="admin-panel__brand-sub">Admin Panel</span>
          </div>
        </div>

        <nav className="admin-panel__nav" aria-label="Admin sections">
          <button
            type="button"
            className={`admin-panel__nav-item ${activeSection === 'users' ? 'admin-panel__nav-item--active' : ''}`}
            onClick={() => handleNavClick('users')}
          >
            <span className="admin-panel__nav-icon"><UsersIcon /></span>
            <span className="admin-panel__nav-label">Users</span>
          </button>
          <button
            type="button"
            className={`admin-panel__nav-item ${activeSection === 'ships' ? 'admin-panel__nav-item--active' : ''}`}
            onClick={() => handleNavClick('ships')}
          >
            <span className="admin-panel__nav-icon"><ShipIcon /></span>
            <span className="admin-panel__nav-label">Ships</span>
          </button>
          <button
            type="button"
            className={`admin-panel__nav-item ${activeSection === 'metrics' ? 'admin-panel__nav-item--active' : ''}`}
            onClick={() => handleNavClick('metrics')}
          >
            <span className="admin-panel__nav-icon"><MetricsIcon /></span>
            <span className="admin-panel__nav-label">Metrics</span>
          </button>
        </nav>

        <div className="admin-panel__sidebar-footer">
          <button type="button" className="admin-panel__back" onClick={close}>
            <ChevronLeftIcon />
            Back to app
          </button>
        </div>
      </aside>

      <div className="admin-panel__body">
        <header className="admin-panel__topbar">
          <button
            type="button"
            className="admin-panel__menu-btn"
            onClick={() => setIsSidebarOpen((o) => !o)}
            aria-label={isSidebarOpen ? 'Close menu' : 'Open menu'}
          >
            {isSidebarOpen ? <XIcon /> : <MenuIcon />}
          </button>
          <span className="admin-panel__topbar-title">
            {activeSection === 'users' ? 'Users' : activeSection === 'ships' ? 'Ships' : 'Metrics'}
          </span>
        </header>

        <main className="admin-panel__main">
          <div className="admin-panel__bg-logo" aria-hidden="true">
            <img src={logoImg} alt="" />
          </div>

          <div className="admin-panel__content">
            {error && (
              <div className="admin-panel__error" role="alert">{error}</div>
            )}

            {activeSection === 'users' && (
              <section className="admin-panel__section">
                <div className="admin-panel__section-head">
                  <div>
                    <h2 className="admin-panel__section-title">Users</h2>
                    <p className="admin-panel__section-subtitle">Create, reset passwords and manage access.</p>
                  </div>
                  <form className="admin-panel__create-bar" onSubmit={handleCreate}>
                    <div className="admin-panel__field-inline">
                      <label className="admin-panel__field-label" htmlFor="ap-role">Role</label>
                      <select
                        id="ap-role"
                        value={createRole}
                        onChange={(e) => setCreateRole(e.target.value as 'user' | 'admin')}
                        className="admin-panel__select"
                        disabled={creating}
                      >
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                    <button type="submit" className="admin-panel__btn admin-panel__btn--primary" disabled={creating}>
                      <PlusIcon />
                      {creating ? 'Creating…' : 'Create user'}
                    </button>
                  </form>
                </div>

                {loading ? (
                  <div className="admin-panel__state-box">
                    <div className="admin-panel__spinner" />
                    <span className="admin-panel__muted">Loading users…</span>
                  </div>
                ) : users.length === 0 ? (
                  <div className="admin-panel__state-box">
                    <UsersIcon />
                    <span className="admin-panel__muted">No users yet.</span>
                  </div>
                ) : (
                  <div className="admin-panel__card">
                    <table className="admin-panel__table">
                      <thead>
                        <tr>
                          <th className="admin-panel__th">User ID</th>
                          <th className="admin-panel__th">Role</th>
                          <th className="admin-panel__th">Ship</th>
                          <th className="admin-panel__th">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {users.map((u) => (
                          <tr key={u.id} className="admin-panel__row">
                            <td className="admin-panel__td admin-panel__td--userid">{u.userId}</td>
                            <td className="admin-panel__td">
                              <span className={`admin-panel__badge admin-panel__badge--${u.role}`}>{u.role}</span>
                            </td>
                            <td className="admin-panel__td">{u.role === 'user' ? (u.ship?.name ?? '—') : '—'}</td>
                            <td className="admin-panel__td">
                              <div className="admin-panel__actions">
                                <button
                                  type="button"
                                  className="admin-panel__btn admin-panel__btn--ghost"
                                  onClick={() => handleResetPassword(u.id)}
                                  disabled={resettingId === u.id}
                                >
                                  {resettingId === u.id ? '…' : 'Reset password'}
                                </button>
                                <button
                                  type="button"
                                  className="admin-panel__btn admin-panel__btn--danger"
                                  onClick={() => handleDeleteClick(u.id, u.userId)}
                                  disabled={deletingId === u.id}
                                >
                                  {deletingId === u.id ? '…' : 'Delete'}
                                </button>
                                {resetResult?.userId === u.userId && (
                                  <div className="admin-panel__password-reveal">
                                    <span className="admin-panel__password-label">New password:</span>
                                    <code className="admin-panel__code">{resetResult.password}</code>
                                    <button
                                      type="button"
                                      className="admin-panel__copy-btn"
                                      onClick={() => copyToClipboard(resetResult.password)}
                                    >
                                      <CopyIcon /> Copy
                                    </button>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            {activeSection === 'metrics' && (
              <section className="admin-panel__section">
                <div className="admin-panel__section-head">
                  <div>
                    <h2 className="admin-panel__section-title">Metrics</h2>
                    <p className="admin-panel__section-subtitle">Define metric keys, display names and descriptions for ship telemetry.</p>
                  </div>
                  {editingMetricKey ? (
                    <button
                      type="button"
                      className="admin-panel__btn admin-panel__btn--ghost"
                      onClick={() => { setEditingMetricKey(null); setMetricForm({ key: '', label: '', description: '', unit: '', dataType: 'numeric' }); }}
                    >
                      Cancel edit
                    </button>
                  ) : null}
                </div>

                {editingMetricKey ? (
                  <div className="admin-panel__form-card">
                    <h3 className="admin-panel__form-card-title">Edit metric</h3>
                    <form onSubmit={handleMetricEditSubmit} className="admin-panel__ship-form">
                      <div className="admin-panel__field">
                        <label className="admin-panel__field-label">Key (read-only)</label>
                        <input type="text" value={metricForm.key} readOnly className="admin-panel__input admin-panel__input--readonly" />
                      </div>
                      <div className="admin-panel__form-row">
                        <div className="admin-panel__field">
                          <label className="admin-panel__field-label">Display name</label>
                          <input
                            type="text"
                            value={metricForm.label}
                            onChange={(e) => setMetricForm((p) => ({ ...p, label: e.target.value }))}
                            className="admin-panel__input"
                            placeholder="e.g. Speed"
                            required
                            disabled={creatingMetric}
                          />
                        </div>
                        <div className="admin-panel__field">
                          <label className="admin-panel__field-label">Unit</label>
                          <input
                            type="text"
                            value={metricForm.unit}
                            onChange={(e) => setMetricForm((p) => ({ ...p, unit: e.target.value }))}
                            className="admin-panel__input"
                            placeholder="e.g. knots"
                            disabled={creatingMetric}
                          />
                        </div>
                      </div>
                      <div className="admin-panel__field">
                        <label className="admin-panel__field-label">Description (what this metric means)</label>
                        <textarea
                          value={metricForm.description}
                          onChange={(e) => setMetricForm((p) => ({ ...p, description: e.target.value }))}
                          className="admin-panel__input admin-panel__textarea"
                          placeholder="Optional description"
                          rows={3}
                          disabled={creatingMetric}
                        />
                      </div>
                      <div className="admin-panel__form-actions">
                        <button type="submit" className="admin-panel__btn admin-panel__btn--primary" disabled={creatingMetric}>
                          {creatingMetric ? 'Saving…' : 'Save changes'}
                        </button>
                      </div>
                    </form>
                  </div>
                ) : (
                  <div className="admin-panel__form-card">
                    <h3 className="admin-panel__form-card-title">New metric</h3>
                    <form onSubmit={handleMetricCreate} className="admin-panel__ship-form">
                      <div className="admin-panel__form-row">
                        <div className="admin-panel__field">
                          <label className="admin-panel__field-label">Key</label>
                          <input
                            type="text"
                            value={metricForm.key}
                            onChange={(e) => setMetricForm((p) => ({ ...p, key: e.target.value }))}
                            className="admin-panel__input"
                            placeholder="e.g. speed_knots"
                            required
                            disabled={creatingMetric}
                          />
                        </div>
                        <div className="admin-panel__field">
                          <label className="admin-panel__field-label">Display name</label>
                          <input
                            type="text"
                            value={metricForm.label}
                            onChange={(e) => setMetricForm((p) => ({ ...p, label: e.target.value }))}
                            className="admin-panel__input"
                            placeholder="e.g. Speed"
                            required
                            disabled={creatingMetric}
                          />
                        </div>
                      </div>
                      <div className="admin-panel__field">
                        <label className="admin-panel__field-label">Description (what this metric means)</label>
                        <textarea
                          value={metricForm.description}
                          onChange={(e) => setMetricForm((p) => ({ ...p, description: e.target.value }))}
                          className="admin-panel__input admin-panel__textarea"
                          placeholder="Optional"
                          rows={3}
                          disabled={creatingMetric}
                        />
                      </div>
                      <div className="admin-panel__form-row">
                        <div className="admin-panel__field">
                          <label className="admin-panel__field-label">Unit</label>
                          <input
                            type="text"
                            value={metricForm.unit}
                            onChange={(e) => setMetricForm((p) => ({ ...p, unit: e.target.value }))}
                            className="admin-panel__input"
                            placeholder="e.g. knots"
                            disabled={creatingMetric}
                          />
                        </div>
                        <div className="admin-panel__field">
                          <label className="admin-panel__field-label">Data type</label>
                          <select
                            value={metricForm.dataType}
                            onChange={(e) => setMetricForm((p) => ({ ...p, dataType: e.target.value }))}
                            className="admin-panel__select"
                            disabled={creatingMetric}
                          >
                            <option value="numeric">numeric</option>
                            <option value="string">string</option>
                            <option value="boolean">boolean</option>
                          </select>
                        </div>
                      </div>
                      <div className="admin-panel__form-actions">
                        <button type="submit" className="admin-panel__btn admin-panel__btn--primary" disabled={creatingMetric}>
                          <PlusIcon />
                          {creatingMetric ? 'Creating…' : 'Create metric'}
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {metricsLoading ? (
                  <div className="admin-panel__state-box">
                    <div className="admin-panel__spinner" />
                    <span className="admin-panel__muted">Loading metrics…</span>
                  </div>
                ) : metrics.length === 0 ? (
                  <div className="admin-panel__state-box">
                    <MetricsIcon />
                    <span className="admin-panel__muted">No metrics yet.</span>
                  </div>
                ) : (
                  <div className="admin-panel__card">
                    <table className="admin-panel__table">
                      <thead>
                        <tr>
                          <th className="admin-panel__th">Key</th>
                          <th className="admin-panel__th">Display name</th>
                          <th className="admin-panel__th">Description</th>
                          <th className="admin-panel__th">Unit</th>
                          <th className="admin-panel__th">Type</th>
                          <th className="admin-panel__th">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {metrics.map((m) => (
                          <tr key={m.key} className="admin-panel__row">
                            <td className="admin-panel__td admin-panel__td--key"><code className="admin-panel__code-inline">{m.key}</code></td>
                            <td className="admin-panel__td">{m.label}</td>
                            <td className="admin-panel__td admin-panel__td--desc">{m.description ?? '—'}</td>
                            <td className="admin-panel__td">{m.unit ?? '—'}</td>
                            <td className="admin-panel__td">{m.dataType ?? 'numeric'}</td>
                            <td className="admin-panel__td">
                              <div className="admin-panel__actions">
                                <button
                                  type="button"
                                  className="admin-panel__btn admin-panel__btn--ghost"
                                  onClick={() => handleMetricEdit(m)}
                                  disabled={!!editingMetricKey || deletingMetricKey === m.key}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="admin-panel__btn admin-panel__btn--danger"
                                  onClick={() => handleMetricDeleteClick(m.key, m.label)}
                                  disabled={!!editingMetricKey || deletingMetricKey === m.key}
                                >
                                  {deletingMetricKey === m.key ? '…' : 'Delete'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {metricDeleteConfirm && (
                  <div className="admin-panel__modal-overlay" role="dialog" aria-modal="true" aria-labelledby="ap-metric-delete-title">
                    <div className="admin-panel__modal">
                      <div className="admin-panel__modal-icon admin-panel__modal-icon--danger">
                        <XIcon />
                      </div>
                      <h2 id="ap-metric-delete-title" className="admin-panel__modal-title">Delete this metric?</h2>
                      <p className="admin-panel__modal-desc">
                        Metric <code className="admin-panel__code">{metricDeleteConfirm.key}</code> ({metricDeleteConfirm.label}) will be removed. This cannot be undone. It can only be deleted if no ship uses it.
                      </p>
                      <div className="admin-panel__modal-actions">
                        <button type="button" className="admin-panel__btn admin-panel__btn--ghost" onClick={handleMetricDeleteCancel}>Cancel</button>
                        <button type="button" className="admin-panel__btn admin-panel__btn--danger" onClick={handleMetricDeleteConfirm}>Delete</button>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            )}

            {activeSection === 'ships' && (
              <section className="admin-panel__section">
                <div className="admin-panel__section-head">
                  <div>
                    <h2 className="admin-panel__section-title">Ships</h2>
                    <p className="admin-panel__section-subtitle">Create and manage ships and their metrics.</p>
                  </div>
                  {editingShipId ? (
                    <button
                      type="button"
                      className="admin-panel__btn admin-panel__btn--ghost"
                      onClick={() => { setEditingShipId(null); setShipForm({ name: '', serialNumber: '', metricKeys: [], userIds: [] }); }}
                    >
                      Cancel edit
                    </button>
                  ) : null}
                </div>

                {editingShipId ? (
                  <div className="admin-panel__form-card">
                    <h3 className="admin-panel__form-card-title">Edit ship</h3>
                    <form onSubmit={handleShipEditSubmit} className="admin-panel__ship-form">
                      <div className="admin-panel__form-row">
                        <div className="admin-panel__field">
                          <label className="admin-panel__field-label">Name</label>
                          <input
                            type="text"
                            value={shipForm.name}
                            onChange={(e) => setShipForm((p) => ({ ...p, name: e.target.value }))}
                            className="admin-panel__input"
                            required
                            disabled={creatingShip}
                          />
                        </div>
                        <div className="admin-panel__field">
                          <label className="admin-panel__field-label">Serial number</label>
                          <input
                            type="text"
                            value={shipForm.serialNumber}
                            onChange={(e) => setShipForm((p) => ({ ...p, serialNumber: e.target.value }))}
                            className="admin-panel__input"
                            placeholder="Optional"
                            disabled={creatingShip}
                          />
                        </div>
                      </div>
                      <div className="admin-panel__field">
                        <span className="admin-panel__field-label">Metrics</span>
                        <div className="admin-panel__metrics-grid">
                          {metricDefinitions.map((m) => (
                            <label key={m.key} className="admin-panel__metric-chip">
                              <input
                                type="checkbox"
                                checked={shipForm.metricKeys.includes(m.key)}
                                onChange={() => toggleMetricKey(m.key)}
                                disabled={creatingShip}
                                className="admin-panel__metric-check"
                              />
                              <span className="admin-panel__metric-name">{m.label}</span>
                              {m.unit && <span className="admin-panel__metric-unit">{m.unit}</span>}
                            </label>
                          ))}
                        </div>
                      </div>
                      {users.filter((u) => u.role === 'user' && (u.shipId == null || u.shipId === editingShipId)).length > 0 && (
                        <div className="admin-panel__field">
                          <span className="admin-panel__field-label">Assigned users</span>
                          <div className="admin-panel__metrics-grid">
                            {users
                              .filter((u) => u.role === 'user' && (u.shipId == null || u.shipId === editingShipId))
                              .map((u) => (
                                <label key={u.id} className="admin-panel__metric-chip">
                                  <input
                                    type="checkbox"
                                    checked={shipForm.userIds.includes(u.id)}
                                    onChange={() => toggleShipUserId(u.id)}
                                    disabled={creatingShip}
                                    className="admin-panel__metric-check"
                                  />
                                  <span className="admin-panel__metric-name">{u.userId}</span>
                                </label>
                              ))}
                          </div>
                        </div>
                      )}
                      <div className="admin-panel__form-actions">
                        <button type="submit" className="admin-panel__btn admin-panel__btn--primary" disabled={creatingShip}>
                          {creatingShip ? 'Saving…' : 'Save changes'}
                        </button>
                      </div>
                    </form>
                  </div>
                ) : (
                  <div className="admin-panel__form-card">
                    <h3 className="admin-panel__form-card-title">New ship</h3>
                    <form onSubmit={handleShipCreate} className="admin-panel__ship-form">
                      <div className="admin-panel__form-row">
                        <div className="admin-panel__field">
                          <label className="admin-panel__field-label">Name</label>
                          <input
                            type="text"
                            value={shipForm.name}
                            onChange={(e) => setShipForm((p) => ({ ...p, name: e.target.value }))}
                            className="admin-panel__input"
                            placeholder="Ship name"
                            required
                            disabled={creatingShip}
                          />
                        </div>
                        <div className="admin-panel__field">
                          <label className="admin-panel__field-label">Serial number</label>
                          <input
                            type="text"
                            value={shipForm.serialNumber}
                            onChange={(e) => setShipForm((p) => ({ ...p, serialNumber: e.target.value }))}
                            className="admin-panel__input"
                            placeholder="Optional"
                            disabled={creatingShip}
                          />
                        </div>
                      </div>
                      {metricDefinitions.length > 0 && (
                        <div className="admin-panel__field">
                          <span className="admin-panel__field-label">Metrics</span>
                          <div className="admin-panel__metrics-grid">
                            {metricDefinitions.map((m) => (
                              <label key={m.key} className="admin-panel__metric-chip">
                                <input
                                  type="checkbox"
                                  checked={shipForm.metricKeys.includes(m.key)}
                                  onChange={() => toggleMetricKey(m.key)}
                                  disabled={creatingShip}
                                  className="admin-panel__metric-check"
                                />
                                <span className="admin-panel__metric-name">{m.label}</span>
                                {m.unit && <span className="admin-panel__metric-unit">{m.unit}</span>}
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                      {users.filter((u) => u.role === 'user' && u.shipId == null).length > 0 && (
                        <div className="admin-panel__field">
                          <span className="admin-panel__field-label">Assigned users</span>
                          <div className="admin-panel__metrics-grid">
                            {users
                              .filter((u) => u.role === 'user' && u.shipId == null)
                              .map((u) => (
                                <label key={u.id} className="admin-panel__metric-chip">
                                  <input
                                    type="checkbox"
                                    checked={shipForm.userIds.includes(u.id)}
                                    onChange={() => toggleShipUserId(u.id)}
                                    disabled={creatingShip}
                                    className="admin-panel__metric-check"
                                  />
                                  <span className="admin-panel__metric-name">{u.userId}</span>
                                </label>
                              ))}
                          </div>
                        </div>
                      )}
                      <div className="admin-panel__form-actions">
                        <button type="submit" className="admin-panel__btn admin-panel__btn--primary" disabled={creatingShip}>
                          <PlusIcon />
                          {creatingShip ? 'Creating…' : 'Create ship'}
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {shipsLoading ? (
                  <div className="admin-panel__state-box">
                    <div className="admin-panel__spinner" />
                    <span className="admin-panel__muted">Loading ships…</span>
                  </div>
                ) : ships.length === 0 ? (
                  <div className="admin-panel__state-box">
                    <ShipIcon />
                    <span className="admin-panel__muted">No ships yet.</span>
                  </div>
                ) : (
                  <div className="admin-panel__card">
                    <table className="admin-panel__table">
                      <thead>
                        <tr>
                          <th className="admin-panel__th">Name</th>
                          <th className="admin-panel__th">Serial</th>
                          <th className="admin-panel__th">Metrics</th>
                          <th className="admin-panel__th">Users</th>
                          <th className="admin-panel__th">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ships.map((ship) => (
                          <tr key={ship.id} className="admin-panel__row">
                            <td className="admin-panel__td admin-panel__td--name">{ship.name}</td>
                            <td className="admin-panel__td admin-panel__td--serial">{ship.serialNumber ?? '—'}</td>
                            <td className="admin-panel__td admin-panel__td--metrics">
                              {ship.metricsConfig.length ? (
                                <div className="admin-panel__metric-tags">
                                  {ship.metricsConfig.map((c) => (
                                    <span key={c.metricKey} className="admin-panel__metric-tag">{c.metricKey}</span>
                                  ))}
                                </div>
                              ) : <span className="admin-panel__muted">—</span>}
                            </td>
                            <td className="admin-panel__td admin-panel__td--metrics">
                              {(ship.assignedUsers?.length ?? 0) > 0 ? (
                                <div className="admin-panel__metric-tags">
                                  {(ship.assignedUsers ?? []).map((u) => (
                                    <span key={u.id} className="admin-panel__metric-tag">{u.userId}</span>
                                  ))}
                                </div>
                              ) : <span className="admin-panel__muted">—</span>}
                            </td>
                            <td className="admin-panel__td">
                              <div className="admin-panel__actions">
                                <button
                                  type="button"
                                  className="admin-panel__btn admin-panel__btn--ghost"
                                  onClick={() => handleShipEdit(ship)}
                                  disabled={!!editingShipId || deletingShipId === ship.id}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="admin-panel__btn admin-panel__btn--danger"
                                  onClick={() => handleShipDeleteClick(ship.id, ship.name)}
                                  disabled={!!editingShipId || deletingShipId === ship.id}
                                >
                                  {deletingShipId === ship.id ? '…' : 'Delete'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}
          </div>
        </main>
      </div>

      {deleteConfirm && (
        <div className="admin-panel__modal-overlay" role="dialog" aria-modal="true" aria-labelledby="ap-delete-title">
          <div className="admin-panel__modal">
            <div className="admin-panel__modal-icon admin-panel__modal-icon--danger">
              <XIcon />
            </div>
            <h2 id="ap-delete-title" className="admin-panel__modal-title">Delete this user?</h2>
            <p className="admin-panel__modal-desc">
              User <code className="admin-panel__code">{deleteConfirm.userId}</code> will be permanently removed. This cannot be undone.
            </p>
            <div className="admin-panel__modal-actions">
              <button type="button" className="admin-panel__btn admin-panel__btn--ghost" onClick={handleDeleteCancel}>Cancel</button>
              <button type="button" className="admin-panel__btn admin-panel__btn--danger" onClick={handleDeleteConfirm}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {shipDeleteConfirm && (
        <div className="admin-panel__modal-overlay" role="dialog" aria-modal="true" aria-labelledby="ap-ship-delete-title">
          <div className="admin-panel__modal">
            <div className="admin-panel__modal-icon admin-panel__modal-icon--danger">
              <XIcon />
            </div>
            <h2 id="ap-ship-delete-title" className="admin-panel__modal-title">Delete this ship?</h2>
            <p className="admin-panel__modal-desc">
              Ship <code className="admin-panel__code">{shipDeleteConfirm.name}</code> will be permanently removed. This cannot be undone.
            </p>
            <div className="admin-panel__modal-actions">
              <button type="button" className="admin-panel__btn admin-panel__btn--ghost" onClick={handleShipDeleteCancel}>Cancel</button>
              <button type="button" className="admin-panel__btn admin-panel__btn--danger" onClick={handleShipDeleteConfirm}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {created && (
        <div className="admin-panel__modal-overlay" role="dialog" aria-modal="true" aria-labelledby="ap-created-title">
          <div className="admin-panel__modal">
            <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
              <UsersIcon />
            </div>
            <h2 id="ap-created-title" className="admin-panel__modal-title">User created</h2>
            <p className="admin-panel__modal-desc">Save these credentials — they won't be shown again.</p>
            <div className="admin-panel__cred-row">
              <span className="admin-panel__cred-label">User ID</span>
              <code className="admin-panel__code admin-panel__code--block">{created.userId}</code>
              <button type="button" className="admin-panel__copy-btn" onClick={() => copyToClipboard(created.userId)}>
                <CopyIcon /> Copy
              </button>
            </div>
            <div className="admin-panel__cred-row">
              <span className="admin-panel__cred-label">Password</span>
              <code className="admin-panel__code admin-panel__code--block">{created.password}</code>
              <button type="button" className="admin-panel__copy-btn" onClick={() => copyToClipboard(created.password)}>
                <CopyIcon /> Copy
              </button>
            </div>
            <button type="button" className="admin-panel__btn admin-panel__btn--primary admin-panel__btn--full" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
