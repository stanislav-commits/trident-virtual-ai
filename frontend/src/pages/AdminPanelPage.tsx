import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getUsers,
  getShips,
  getMetricDefinitions,
  getOrganizations,
  type UserListItem,
  type ShipListItem,
  type MetricDefinitionItem,
} from "../api/client";
import { useAdminPanel } from "../context/AdminPanelContext";
import { useAuth } from "../context/AuthContext";
import logoImg from "../assets/logo-home.png";
import {
  UsersIcon,
  ShipIcon,
  PromptIcon,
  TagIcon,
  ChevronLeftIcon,
  MenuIcon,
  XIcon,
} from "../components/admin/AdminPanelIcons";
import { UsersSection } from "../components/admin/UsersSection";
import { ShipsSection } from "../components/admin/ShipsSection";
import { SystemPromptSection } from "../components/admin/SystemPromptSection";
import { TagsSection } from "../components/admin/TagsSection";
import { ManualsPromptModal } from "../components/admin/ManualsPromptModal";
import { MetricsModal } from "../components/admin/MetricsModal";
import { Toast } from "../components/layout/Toast";

type AdminSection = "users" | "ships" | "prompt" | "tags";

const SECTION_TITLES: Record<AdminSection, string> = {
  users: "Users",
  ships: "Ships",
  prompt: "System Prompt",
  tags: "Tags",
};

export function AdminPanelPage() {
  const { close } = useAdminPanel();
  const { token } = useAuth();

  // Navigation state
  const [activeSection, setActiveSection] = useState<AdminSection>("users");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Common state
  const [error, setError] = useState("");

  // Users section state
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);

  // Ships section state
  const [ships, setShips] = useState<ShipListItem[]>([]);
  const [shipsLoading, setShipsLoading] = useState(false);
  const [organizations, setOrganizations] = useState<string[]>([]);
  const [organizationsLoading, setOrganizationsLoading] = useState(false);
  const [metricDefinitions, setMetricDefinitions] = useState<
    MetricDefinitionItem[]
  >([]);

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
  const loadShips = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!token) return;
      if (!options?.silent) {
        setShipsLoading(true);
        setOrganizationsLoading(true);
        setError("");
      }
      try {
        const [shipsList, metrics, usersList, organizationsResult] =
          await Promise.allSettled([
            getShips(token),
            getMetricDefinitions(token),
            getUsers(token),
            getOrganizations(token),
          ]);

        if (
          shipsList.status !== "fulfilled" ||
          metrics.status !== "fulfilled" ||
          usersList.status !== "fulfilled"
        ) {
          throw new Error("Failed to load ships");
        }

        setShips(shipsList.value);
        setMetricDefinitions(metrics.value);
        setUsers(usersList.value);

        if (organizationsResult.status === "fulfilled") {
          setOrganizations(organizationsResult.value);
        } else {
          if (!options?.silent) {
            setOrganizations([]);
            setError(
              organizationsResult.reason instanceof Error
                ? organizationsResult.reason.message
                : "Failed to load organizations",
            );
          }
        }
      } catch (e) {
        if (!options?.silent) {
          setError(e instanceof Error ? e.message : "Failed to load ships");
        }
      } finally {
        if (!options?.silent) {
          setShipsLoading(false);
          setOrganizationsLoading(false);
        }
      }
    },
    [token],
  );

  useEffect(() => {
    if (activeSection === "ships") loadShips();
  }, [activeSection, loadShips]);

  useEffect(() => {
    if (!metricsModalShip) {
      return;
    }

    const latestShip =
      ships.find((ship) => ship.id === metricsModalShip.id) ?? null;
    if (latestShip && latestShip !== metricsModalShip) {
      setMetricsModalShip(latestShip);
    }
  }, [metricsModalShip, ships]);

  const hasPendingMetricDescriptions = useMemo(() => {
    if (!ships.length || !metricDefinitions.length) return false;

    const definitionMap = new Map(
      metricDefinitions.map((definition) => [definition.key, definition]),
    );

    return ships.some((ship) =>
      ship.metricsConfig.some((config) => {
        const description = definitionMap.get(config.metricKey)?.description;
        return !description?.trim();
      }),
    );
  }, [ships, metricDefinitions]);

  const hasBackgroundShipSync = useMemo(
    () =>
      ships.some(
        (ship) =>
          ship.metricsSyncStatus === "pending" ||
          ship.metricsSyncStatus === "running",
      ),
    [ships],
  );

  useEffect(() => {
    if (
      activeSection !== "ships" ||
      !token ||
      (!hasPendingMetricDescriptions && !hasBackgroundShipSync)
    ) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadShips({ silent: true });
    }, 15000);

    return () => window.clearInterval(intervalId);
  }, [
    activeSection,
    hasBackgroundShipSync,
    hasPendingMetricDescriptions,
    loadShips,
    token,
  ]);

  const handleNavClick = (section: AdminSection) => {
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
            <span className="admin-panel__brand-name">
              <span className="admin-panel__brand-line">Trident</span>
              <span className="admin-panel__brand-line">Intelligence</span>
              <span className="admin-panel__brand-line">Platform</span>
            </span>
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
          <button
            type="button"
            className={`admin-panel__nav-item ${activeSection === "prompt" ? "admin-panel__nav-item--active" : ""}`}
            onClick={() => handleNavClick("prompt")}
          >
            <span className="admin-panel__nav-icon">
              <PromptIcon />
            </span>
            <span className="admin-panel__nav-label">System Prompt</span>
          </button>
          <button
            type="button"
            className={`admin-panel__nav-item ${activeSection === "tags" ? "admin-panel__nav-item--active" : ""}`}
            onClick={() => handleNavClick("tags")}
          >
            <span className="admin-panel__nav-icon">
              <TagIcon />
            </span>
            <span className="admin-panel__nav-label">Tags</span>
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
            {SECTION_TITLES[activeSection]}
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
                organizations={organizations}
                organizationsLoading={organizationsLoading}
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

            {activeSection === "prompt" && (
              <SystemPromptSection
                token={token}
                error={error}
                onError={setError}
              />
            )}

            {activeSection === "tags" && (
              <TagsSection
                token={token}
                error={error}
                onError={setError}
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
          onClose={() => {
            setManualsPromptShip(null);
          }}
          onError={setError}
        />
      )}

      {metricsModalShip && (
        <MetricsModal
          token={token}
          shipId={metricsModalShip.id}
          shipName={metricsModalShip.name}
          metricsConfig={metricsModalShip.metricsConfig}
          metricDefinitions={metricDefinitions}
          onClose={() => setMetricsModalShip(null)}
          onError={setError}
          onShipUpdated={(updatedShip) => {
            setShips((current) =>
              current.map((ship) =>
                ship.id === updatedShip.id ? updatedShip : ship,
              ),
            );
            setMetricsModalShip(updatedShip);
          }}
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
