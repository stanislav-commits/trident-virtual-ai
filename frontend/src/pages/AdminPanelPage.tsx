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
  updateShip,
  type UserListItem,
  type ShipListItem,
  type MetricDefinitionItem,
} from '../api/client';
import { useAdminPanel } from '../context/AdminPanelContext';
import { useAuth } from '../context/AuthContext';
import logoImg from '../assets/logo-chats.png';

export function AdminPanelPage() {
  const { close } = useAdminPanel();
  const { token } = useAuth();
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createRole, setCreateRole] = useState<'user' | 'admin'>('user');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{
    userId: string;
    password: string;
  } | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<{
    userId: string;
    password: string;
  } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    id: string;
    userId: string;
  } | null>(null);
  const [activeSection, setActiveSection] = useState<'users' | 'ships'>('users');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const [ships, setShips] = useState<ShipListItem[]>([]);
  const [metricDefinitions, setMetricDefinitions] = useState<MetricDefinitionItem[]>([]);
  const [shipsLoading, setShipsLoading] = useState(false);
  const [shipForm, setShipForm] = useState({
    name: '',
    serialNumber: '',
    metricKeys: [] as string[],
  });
  const [creatingShip, setCreatingShip] = useState(false);
  const [editingShipId, setEditingShipId] = useState<string | null>(null);
  const [deletingShipId, setDeletingShipId] = useState<string | null>(null);
  const [shipDeleteConfirm, setShipDeleteConfirm] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const loadUsers = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const list = await getUsers(token);
      setUsers(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const loadShips = useCallback(async () => {
    if (!token) return;
    setShipsLoading(true);
    setError('');
    try {
      const [shipsList, metrics] = await Promise.all([
        getShips(token),
        getMetricDefinitions(token),
      ]);
      setShips(shipsList);
      setMetricDefinitions(metrics);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load ships');
    } finally {
      setShipsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (activeSection === 'ships') loadShips();
  }, [activeSection, loadShips]);

  const handleShipCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !shipForm.name.trim()) return;
    setCreatingShip(true);
    setError('');
    try {
      await createShip(
        {
          name: shipForm.name.trim(),
          serialNumber: shipForm.serialNumber.trim() || undefined,
          metricKeys: shipForm.metricKeys,
        },
        token,
      );
      setShipForm({ name: '', serialNumber: '', metricKeys: [] });
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
    });
  };

  const handleShipEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !editingShipId || !shipForm.name.trim()) return;
    setCreatingShip(true);
    setError('');
    try {
      await updateShip(
        editingShipId,
        {
          name: shipForm.name.trim(),
          serialNumber: shipForm.serialNumber.trim() || null,
          metricKeys: shipForm.metricKeys,
        },
        token,
      );
      setEditingShipId(null);
      setShipForm({ name: '', serialNumber: '', metricKeys: [] });
      loadShips();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update ship');
    } finally {
      setCreatingShip(false);
    }
  };

  const handleShipDeleteClick = (id: string, name: string) => {
    setShipDeleteConfirm({ id, name });
  };

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
      metricKeys: prev.metricKeys.includes(key)
        ? prev.metricKeys.filter((k) => k !== key)
        : [...prev.metricKeys, key],
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

  const handleDeleteClick = (id: string, userId: string) => {
    setDeleteConfirm({ id, userId });
  };

  const handleDeleteCancel = () => {
    setDeleteConfirm(null);
  };

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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel__bg-logo" aria-hidden>
        <img src={logoImg} alt="" />
      </div>
      <header className="admin-panel__header">
        <h1 className="admin-panel__title">Admin panel</h1>
      </header>

      <div className="admin-panel__body">
        <aside
          className={`admin-panel__sidebar ${isSidebarOpen ? 'admin-panel__sidebar--open' : ''}`}
          aria-label="Admin menu"
          aria-expanded={isSidebarOpen}
        >
          <button
            type="button"
            className="admin-panel__sidebar-handle"
            onClick={() => setIsSidebarOpen((o) => !o)}
            aria-label={isSidebarOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={isSidebarOpen}
          >
            <span className="admin-panel__sidebar-handle-icon">☰</span>
          </button>
          <div className="admin-panel__sidebar-content">
            <nav className="admin-panel__nav" aria-label="Admin sections">
              <ul className="admin-panel__nav-list">
                <li className="admin-panel__nav-item">
                  <button
                    type="button"
                    className={`admin-panel__nav-link ${activeSection === 'users' ? 'admin-panel__nav-link--active' : ''}`}
                    onClick={() => setActiveSection('users')}
                  >
                    Users
                  </button>
                </li>
                <li className="admin-panel__nav-item">
                  <button
                    type="button"
                    className={`admin-panel__nav-link ${activeSection === 'ships' ? 'admin-panel__nav-link--active' : ''}`}
                    onClick={() => setActiveSection('ships')}
                  >
                    Ships
                  </button>
                </li>
              </ul>
            </nav>
            <div className="admin-panel__sidebar-footer">
              <button
                type="button"
                className="admin-panel__back"
                onClick={close}
              >
                Back to app
              </button>
            </div>
          </div>
        </aside>

        <main className="admin-panel__main">
          <div className="admin-panel__content">
            {error && (
              <p className="admin-panel__error" role="alert">
                {error}
              </p>
            )}

            {activeSection === 'users' && (
        <section className="admin-panel__section admin-panel__section--wide">
          <div className="admin-panel__section-head">
            <div>
              <h2 className="admin-panel__section-title">Users</h2>
              <p className="admin-panel__section-subtitle">
                Create, reset passwords and manage access.
              </p>
            </div>

            <form className="admin-panel__toolbar" onSubmit={handleCreate}>
              <label className="admin-panel__label admin-panel__label--inline">
                Role
                <select
                  value={createRole}
                  onChange={(e) => setCreateRole(e.target.value as 'user' | 'admin')}
                  className="admin-panel__select"
                  disabled={creating}
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </label>

              <button
                type="submit"
                className="admin-panel__btn admin-panel__btn--primary"
                disabled={creating}
              >
                {creating ? '…' : 'Create user'}
              </button>
            </form>
          </div>

          {loading ? (
            <p className="admin-panel__muted">Loading…</p>
          ) : users.length === 0 ? (
            <p className="admin-panel__muted">No users yet.</p>
          ) : (
            <div className="admin-panel__table-wrap">
              <table className="admin-panel__table">
                <thead>
                  <tr>
                    <th className="admin-panel__th">User ID</th>
                    <th className="admin-panel__th">Role</th>
                    <th className="admin-panel__th">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="admin-panel__row">
                      <td className="admin-panel__td admin-panel__td--userId">{u.userId}</td>
                      <td className="admin-panel__td admin-panel__td--role">{u.role}</td>
                      <td className="admin-panel__td">
                        <div className="admin-panel__actions">
                          <button
                            type="button"
                            className="admin-panel__btn admin-panel__btn--small"
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
                            <span className="admin-panel__new-password">
                              New password: <code>{resetResult.password}</code>{' '}
                              <button
                                type="button"
                                className="admin-panel__copy"
                                onClick={() => copyToClipboard(resetResult.password)}
                              >
                                Copy
                              </button>
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {deleteConfirm && (
            <div className="admin-panel__popup-overlay" role="dialog" aria-modal="true" aria-labelledby="admin-delete-title">
              <div className="admin-panel__popup">
                <h2 id="admin-delete-title" className="admin-panel__popup-title">
                  Delete this user?
                </h2>
                <p className="admin-panel__popup-hint">
                  User <code className="admin-panel__popup-value">{deleteConfirm.userId}</code> will be permanently removed. This cannot be undone.
                </p>
                <div className="admin-panel__popup-actions">
                  <button
                    type="button"
                    className="admin-panel__btn admin-panel__btn--small"
                    onClick={handleDeleteCancel}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="admin-panel__btn admin-panel__btn--danger"
                    onClick={handleDeleteConfirm}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          )}

          {created && (
          <div className="admin-panel__popup-overlay" role="dialog" aria-modal="true" aria-labelledby="admin-popup-title">
            <div className="admin-panel__popup">
              <h2 id="admin-popup-title" className="admin-panel__popup-title">
                User created
              </h2>
              <p className="admin-panel__popup-hint">
                Save these — they won’t be shown again.
              </p>
              <div className="admin-panel__popup-row">
                <span className="admin-panel__popup-label">User ID</span>
                <code className="admin-panel__popup-value">{created.userId}</code>
                <button
                  type="button"
                  className="admin-panel__copy"
                  onClick={() => copyToClipboard(created.userId)}
                >
                  Copy
                </button>
              </div>
              <div className="admin-panel__popup-row">
                <span className="admin-panel__popup-label">Password</span>
                <code className="admin-panel__popup-value">{created.password}</code>
                <button
                  type="button"
                  className="admin-panel__copy"
                  onClick={() => copyToClipboard(created.password)}
                >
                  Copy
                </button>
              </div>
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--primary admin-panel__popup-close"
                onClick={() => setCreated(null)}
              >
                Close
              </button>
            </div>
          </div>
        )}
        </section>
            )}

            {activeSection === 'ships' && (
              <section className="admin-panel__section admin-panel__section--wide">
                <div className="admin-panel__section-head">
                  <div>
                    <h2 className="admin-panel__section-title">Ships</h2>
                    <p className="admin-panel__section-subtitle">
                      Create and manage ships and their metrics.
                    </p>
                  </div>

                  {!editingShipId ? (
                    <form className="admin-panel__toolbar" onSubmit={handleShipCreate}>
                      <label className="admin-panel__label admin-panel__label--inline">
                        Name
                        <input
                          type="text"
                          value={shipForm.name}
                          onChange={(e) => setShipForm((p) => ({ ...p, name: e.target.value }))}
                          className="admin-panel__select"
                          placeholder="Ship name"
                          required
                          disabled={creatingShip}
                        />
                      </label>
                      <label className="admin-panel__label admin-panel__label--inline">
                        Serial
                        <input
                          type="text"
                          value={shipForm.serialNumber}
                          onChange={(e) => setShipForm((p) => ({ ...p, serialNumber: e.target.value }))}
                          className="admin-panel__select"
                          placeholder="Optional"
                          disabled={creatingShip}
                        />
                      </label>
                      <button
                        type="submit"
                        className="admin-panel__btn admin-panel__btn--primary"
                        disabled={creatingShip}
                      >
                        {creatingShip ? '…' : 'Create ship'}
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="admin-panel__btn admin-panel__btn--small"
                      onClick={() => {
                        setEditingShipId(null);
                        setShipForm({ name: '', serialNumber: '', metricKeys: [] });
                      }}
                    >
                      Cancel edit
                    </button>
                  )}
                </div>

                {editingShipId && (
                  <div className="admin-panel__form admin-panel__section-head">
                    <h3 className="admin-panel__section-subtitle">Edit ship</h3>
                    <form onSubmit={handleShipEditSubmit}>
                      <label className="admin-panel__label">
                        Name
                        <input
                          type="text"
                          value={shipForm.name}
                          onChange={(e) => setShipForm((p) => ({ ...p, name: e.target.value }))}
                          className="admin-panel__select"
                          required
                          disabled={creatingShip}
                        />
                      </label>
                      <label className="admin-panel__label">
                        Serial number
                        <input
                          type="text"
                          value={shipForm.serialNumber}
                          onChange={(e) => setShipForm((p) => ({ ...p, serialNumber: e.target.value }))}
                          className="admin-panel__select"
                          disabled={creatingShip}
                        />
                      </label>
                      <fieldset className="admin-panel__label">
                        <legend>Metrics</legend>
                        <div className="admin-panel__metrics-list">
                          {metricDefinitions.map((m) => (
                            <label key={m.key} className="admin-panel__metrics-item">
                              <input
                                type="checkbox"
                                checked={shipForm.metricKeys.includes(m.key)}
                                onChange={() => toggleMetricKey(m.key)}
                                disabled={creatingShip}
                              />
                              <span>{m.label}</span>
                              {m.unit && <span className="admin-panel__muted"> ({m.unit})</span>}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <button
                        type="submit"
                        className="admin-panel__btn admin-panel__btn--primary"
                        disabled={creatingShip}
                      >
                        {creatingShip ? '…' : 'Save'}
                      </button>
                    </form>
                  </div>
                )}

                {!editingShipId && (
                  <div className="admin-panel__section-head">
                    <h3 className="admin-panel__section-subtitle">New ship: select metrics</h3>
                    <div className="admin-panel__metrics-list">
                      {metricDefinitions.map((m) => (
                        <label key={m.key} className="admin-panel__metrics-item">
                          <input
                            type="checkbox"
                            checked={shipForm.metricKeys.includes(m.key)}
                            onChange={() => toggleMetricKey(m.key)}
                            disabled={creatingShip}
                          />
                          <span>{m.label}</span>
                          {m.unit && <span className="admin-panel__muted"> ({m.unit})</span>}
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {shipsLoading ? (
                  <p className="admin-panel__muted">Loading…</p>
                ) : ships.length === 0 ? (
                  <p className="admin-panel__muted">No ships yet.</p>
                ) : (
                  <div className="admin-panel__table-wrap">
                    <table className="admin-panel__table">
                      <thead>
                        <tr>
                          <th className="admin-panel__th">Name</th>
                          <th className="admin-panel__th">Serial</th>
                          <th className="admin-panel__th">Metrics</th>
                          <th className="admin-panel__th">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ships.map((ship) => (
                          <tr key={ship.id} className="admin-panel__row">
                            <td className="admin-panel__td">{ship.name}</td>
                            <td className="admin-panel__td">{ship.serialNumber ?? '—'}</td>
                            <td className="admin-panel__td">
                              {ship.metricsConfig.length
                                ? ship.metricsConfig.map((c) => c.metricKey).join(', ')
                                : '—'}
                            </td>
                            <td className="admin-panel__td">
                              <div className="admin-panel__actions">
                                <button
                                  type="button"
                                  className="admin-panel__btn admin-panel__btn--small"
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

                {shipDeleteConfirm && (
                  <div className="admin-panel__popup-overlay" role="dialog" aria-modal="true" aria-labelledby="admin-ship-delete-title">
                    <div className="admin-panel__popup">
                      <h2 id="admin-ship-delete-title" className="admin-panel__popup-title">
                        Delete this ship?
                      </h2>
                      <p className="admin-panel__popup-hint">
                        Ship <code className="admin-panel__popup-value">{shipDeleteConfirm.name}</code> will be permanently removed. This cannot be undone.
                      </p>
                      <div className="admin-panel__popup-actions">
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--small"
                          onClick={handleShipDeleteCancel}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--danger"
                          onClick={handleShipDeleteConfirm}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
