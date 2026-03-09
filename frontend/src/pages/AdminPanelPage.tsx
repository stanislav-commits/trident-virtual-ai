import { useCallback, useEffect, useState } from "react";
import {
  getUsers,
  getShips,
  getMetricDefinitions,
  getManuals,
  type UserListItem,
  type ShipListItem,
  type MetricDefinitionItem,
  type ShipManualItem,
} from "../api/client";
import { useAdminPanel } from "../context/AdminPanelContext";
import { useAuth } from "../context/AuthContext";
import logoImg from "../assets/logo-home.png";
import {
  UsersIcon,
  ShipIcon,
  ChevronLeftIcon,
  MenuIcon,
  XIcon,
} from "../components/admin/AdminPanelIcons";
import { UsersSection } from "../components/admin/UsersSection";
import { ShipsSection } from "../components/admin/ShipsSection";
import { ManualsPromptModal } from "../components/admin/ManualsPromptModal";
import { MetricsModal } from "../components/admin/MetricsModal";
import { Toast } from "../components/layout/Toast";

export function AdminPanelPage() {
  const { close } = useAdminPanel();
  const { token } = useAuth();

  // Navigation state
  const [activeSection, setActiveSection] = useState<"users" | "ships">(
    "users",
  );
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Common state
  const [error, setError] = useState("");

  // Users section state
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);

  // Ships section state
  const [ships, setShips] = useState<ShipListItem[]>([]);
  const [shipsLoading, setShipsLoading] = useState(false);
  const [metricDefinitions, setMetricDefinitions] = useState<
    MetricDefinitionItem[]
  >([]);

  // Manuals modal state
  const [manuals, setManuals] = useState<ShipManualItem[]>([]);
  const [manualsLoading, setManualsLoading] = useState(false);
  const [manualsPromptShip, setManualsPromptShip] = useState<{
    id: string;
    name: string;
  } | null>(null);

  // Metrics modal state
  const [metricsModalShip, setMetricsModalShip] = useState<ShipListItem | null>(
    null,
  );

  // Load users
  const loadUsers = useCallback(async () => {
    if (!token) return;
    setUsersLoading(true);
    setError("");
    try {
      setUsers(await getUsers(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load users");
    } finally {
      setUsersLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  // Load ships
  const loadShips = useCallback(async () => {
    if (!token) return;
    setShipsLoading(true);
    setError("");
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
      setError(e instanceof Error ? e.message : "Failed to load ships");
    } finally {
      setShipsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (activeSection === "ships") loadShips();
  }, [activeSection, loadShips]);

  // Load manuals for prompt modal
  useEffect(() => {
    if (!manualsPromptShip || !token) return;
    setManuals([]);
    let cancelled = false;
    setManualsLoading(true);
    getManuals(manualsPromptShip.id, token)
      .then((list) => {
        if (!cancelled) setManuals(list);
      })
      .finally(() => {
        if (!cancelled) setManualsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [manualsPromptShip, token]);

  const handleNavClick = (section: "users" | "ships") => {
    setActiveSection(section);
    setIsSidebarOpen(false);
  };

  return (
    <div className="admin-panel">
      {isSidebarOpen && (
        <div
          className="admin-panel__overlay"
          onClick={() => setIsSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`admin-panel__sidebar ${isSidebarOpen ? "admin-panel__sidebar--open" : ""}`}
        aria-label="Admin navigation"
      >
        <div className="admin-panel__sidebar-brand">
          <img
            src={logoImg}
            alt=""
            className="admin-panel__brand-logo"
            aria-hidden
          />
          <div className="admin-panel__brand-text">
            <span className="admin-panel__brand-name">Trident Intelligence Platform</span>
            <span className="admin-panel__brand-sub">Admin Panel</span>
          </div>
        </div>

        <nav className="admin-panel__nav" aria-label="Admin sections">
          <button
            type="button"
            className={`admin-panel__nav-item ${activeSection === "users" ? "admin-panel__nav-item--active" : ""}`}
            onClick={() => handleNavClick("users")}
          >
            <span className="admin-panel__nav-icon">
              <UsersIcon />
            </span>
            <span className="admin-panel__nav-label">Users</span>
          </button>
          <button
            type="button"
            className={`admin-panel__nav-item ${activeSection === "ships" ? "admin-panel__nav-item--active" : ""}`}
            onClick={() => handleNavClick("ships")}
          >
            <span className="admin-panel__nav-icon">
              <ShipIcon />
            </span>
            <span className="admin-panel__nav-label">Ships</span>
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
            aria-label={isSidebarOpen ? "Close menu" : "Open menu"}
          >
            {isSidebarOpen ? <XIcon /> : <MenuIcon />}
          </button>
          <span className="admin-panel__topbar-title">
            {activeSection === "users" ? "Users" : "Ships"}
          </span>
        </header>

        <main className="admin-panel__main">
          <div className="admin-panel__bg-logo" aria-hidden="true">
            <img src={logoImg} alt="" />
          </div>

          <div className="admin-panel__content">
            {activeSection === "users" && (
              <UsersSection
                token={token}
                users={users}
                loading={usersLoading}
                error={error}
                onLoadUsers={loadUsers}
                onError={setError}
              />
            )}

            {activeSection === "ships" && (
              <ShipsSection
                token={token}
                ships={ships}
                users={users}
                metricDefinitions={metricDefinitions}
                loading={shipsLoading}
                error={error}
                onLoadShips={loadShips}
                onError={setError}
                onOpenManuals={(shipId, shipName) => {
                  setManualsPromptShip({ id: shipId, name: shipName });
                }}
                onOpenMetrics={(ship) => setMetricsModalShip(ship)}
              />
            )}
          </div>
        </main>
      </div>

      {manualsPromptShip && (
        <ManualsPromptModal
          token={token}
          shipId={manualsPromptShip.id}
          shipName={manualsPromptShip.name}
          manuals={manuals}
          loading={manualsLoading}
          onClose={() => {
            setManualsPromptShip(null);
            setManuals([]);
          }}
          onError={setError}
          onManualsChanged={(list) => setManuals(list)}
        />
      )}

      {metricsModalShip && (
        <MetricsModal
          token={token}
          shipName={metricsModalShip.name}
          metricsConfig={metricsModalShip.metricsConfig}
          metricDefinitions={metricDefinitions}
          onClose={() => setMetricsModalShip(null)}
          onError={setError}
          onDefinitionsChanged={() => {
            if (token) {
              getMetricDefinitions(token)
                .then(setMetricDefinitions)
                .catch(() => {});
            }
          }}
        />
      )}

      <Toast
        message={error}
        type="error"
        duration={6000}
        onClose={() => setError("")}
      />
    </div>
  );
}
