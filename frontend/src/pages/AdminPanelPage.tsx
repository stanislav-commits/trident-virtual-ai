import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import logoImg from "../assets/logo-home.png";
import {
  UsersIcon,
  ShipIcon,
  MetricsIcon,
  ChevronLeftIcon,
  MenuIcon,
  XIcon,
} from "../components/admin/AdminPanelIcons";
import { MetricsSection } from "../components/admin/MetricsSection";
import { UsersSection } from "../components/admin/UsersSection";
import { ShipsSection } from "../components/admin/ShipsSection";
import { useShipsAdminData } from "../hooks/admin/useShipsAdminData";
import { useUsersAdminData } from "../hooks/admin/useUsersAdminData";
import { Toast } from "../components/layout/Toast";
import {
  appRoutes,
  isAdminSectionRoute,
  type AdminSectionRoute,
} from "../utils/routes";

const SECTION_TITLES: Record<AdminSectionRoute, string> = {
  users: "Users",
  ships: "Ships",
  metrics: "Metrics",
};

export function AdminPanelPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const { section } = useParams<{ section: string }>();
  const activeSection: AdminSectionRoute = isAdminSectionRoute(section)
    ? section
    : "users";

  // Navigation state
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const usersAdmin = useUsersAdminData(token);
  const shipsAdmin = useShipsAdminData(token, activeSection === "ships");

  const activeError =
    activeSection === "ships"
      ? shipsAdmin.error
      : activeSection === "users"
        ? usersAdmin.error
        : "";

  const clearActiveError = () => {
    if (activeSection === "ships") {
      shipsAdmin.setError("");
      return;
    }

    if (activeSection === "users") {
      usersAdmin.setError("");
    }
  };

  useEffect(() => {
    if (!isAdminSectionRoute(section)) {
      navigate(appRoutes.adminSection("users"), { replace: true });
    }
  }, [navigate, section]);

  const handleNavClick = (targetSection: AdminSectionRoute) => {
    navigate(appRoutes.adminSection(targetSection));
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
            className={`admin-panel__nav-item ${activeSection === "metrics" ? "admin-panel__nav-item--active" : ""}`}
            onClick={() => handleNavClick("metrics")}
          >
            <span className="admin-panel__nav-icon">
              <MetricsIcon />
            </span>
            <span className="admin-panel__nav-label">Metrics</span>
          </button>
        </nav>

        <div className="admin-panel__sidebar-footer">
          <button
            type="button"
            className="admin-panel__back"
            onClick={() => navigate(appRoutes.chats)}
          >
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
                users={usersAdmin.users}
                loading={usersAdmin.isLoading}
                error={usersAdmin.error}
                onLoadUsers={usersAdmin.loadUsers}
                onError={usersAdmin.setError}
              />
            )}

            {activeSection === "ships" && (
              <ShipsSection
                token={token}
                ships={shipsAdmin.ships}
                organizations={shipsAdmin.organizations}
                organizationsLoading={shipsAdmin.organizationsLoading}
                loading={shipsAdmin.shipsLoading}
                error={shipsAdmin.error}
                onLoadShips={shipsAdmin.loadShips}
                onError={shipsAdmin.setError}
              />
            )}

            {activeSection === "metrics" && <MetricsSection token={token} />}
          </div>
        </main>
      </div>

      <Toast
        message={activeError}
        type="error"
        duration={6000}
        onClose={clearActiveError}
      />
    </div>
  );
}
