import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import logoImg from "../assets/logo-home.png";
import {
  UsersIcon,
  ShipIcon,
  AssetsIcon,
  DocumentsIcon,
  MetricsIcon,
  MaintenanceIcon,
  CrewIcon,
  InventoryIcon,
  AlertsIcon,
  ChevronLeftIcon,
  MenuIcon,
  XIcon,
} from "../components/admin/AdminPanelIcons";
import { DocumentsSection } from "../components/admin/DocumentsSection";
import { PublicationsSection } from "../components/admin/PublicationsSection";
import { MetricsSection } from "../components/admin/MetricsSection";
import { UsersSection } from "../components/admin/UsersSection";
import { ShipsSection } from "../components/admin/ShipsSection";
import { AssetsSection } from "../components/admin/AssetsSection";
import { ComplianceSection } from "../components/admin/ComplianceSection";
import { PmsSection } from "../components/admin/PmsSection";
import { CrewSection } from "../components/admin/CrewSection";
import { InventorySection } from "../components/admin/InventorySection";
import { AlertsSection } from "../components/admin/AlertsSection";
import { ActiveVesselSwitcher } from "../components/admin/ActiveVesselSwitcher";
import { UserAvatar } from "../components/layout/UserAvatar";
import { getUserAvatarLabel } from "../components/layout/userAvatarUtils";
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
  assets: "Asset Register",
  compliance: "Compliance Docs",
  maintenance: "Tasks",
  crew: "Crew",
  inventory: "Inventory",
  alerts: "Alerts",
  documents: "Knowledge Base",
  metrics: "Metrics",
  publications: "Publications",
};

export function AdminPanelPage() {
  const { token, user } = useAuth();
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

        <ActiveVesselSwitcher />

        <nav className="admin-panel__nav" aria-label="Admin sections">
          {/* Vessel data — everything scoped to the active vessel. */}
          <div className="admin-panel__nav-group-label">Vessel data</div>
          <button
            type="button"
            className={`admin-panel__nav-item ${activeSection === "assets" ? "admin-panel__nav-item--active" : ""}`}
            onClick={() => handleNavClick("assets")}
          >
            <span className="admin-panel__nav-icon">
              <AssetsIcon />
            </span>
            <span className="admin-panel__nav-label">Asset Register</span>
          </button>
          <button
            type="button"
            className={`admin-panel__nav-item ${activeSection === "compliance" ? "admin-panel__nav-item--active" : ""}`}
            onClick={() => handleNavClick("compliance")}
          >
            <span className="admin-panel__nav-icon">
              <DocumentsIcon />
            </span>
            <span className="admin-panel__nav-label">Compliance Docs</span>
          </button>
          <button
            type="button"
            className={`admin-panel__nav-item ${activeSection === "maintenance" ? "admin-panel__nav-item--active" : ""}`}
            onClick={() => handleNavClick("maintenance")}
          >
            <span className="admin-panel__nav-icon">
              <MaintenanceIcon />
            </span>
            <span className="admin-panel__nav-label">Tasks</span>
          </button>
          <button
            type="button"
            className={`admin-panel__nav-item ${activeSection === "crew" ? "admin-panel__nav-item--active" : ""}`}
            onClick={() => handleNavClick("crew")}
          >
            <span className="admin-panel__nav-icon">
              <CrewIcon />
            </span>
            <span className="admin-panel__nav-label">Crew</span>
          </button>
          <button
            type="button"
            className={`admin-panel__nav-item ${activeSection === "inventory" ? "admin-panel__nav-item--active" : ""}`}
            onClick={() => handleNavClick("inventory")}
          >
            <span className="admin-panel__nav-icon">
              <InventoryIcon />
            </span>
            <span className="admin-panel__nav-label">Inventory</span>
          </button>
          <button
            type="button"
            className={`admin-panel__nav-item ${activeSection === "alerts" ? "admin-panel__nav-item--active" : ""}`}
            onClick={() => handleNavClick("alerts")}
          >
            <span className="admin-panel__nav-icon">
              <AlertsIcon />
            </span>
            <span className="admin-panel__nav-label">Alerts</span>
          </button>
          <button
            type="button"
            className={`admin-panel__nav-item ${activeSection === "documents" ? "admin-panel__nav-item--active" : ""}`}
            onClick={() => handleNavClick("documents")}
          >
            <span className="admin-panel__nav-icon">
              <DocumentsIcon />
            </span>
            <span className="admin-panel__nav-label">Knowledge Base</span>
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

          {/* Platform settings — NOT vessel-scoped. */}
          <div className="admin-panel__nav-group-label admin-panel__nav-group-label--platform">
            Platform
          </div>
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
            className={`admin-panel__nav-item ${activeSection === "publications" ? "admin-panel__nav-item--active" : ""}`}
            onClick={() => handleNavClick("publications")}
          >
            <span className="admin-panel__nav-icon">
              <DocumentsIcon />
            </span>
            <span className="admin-panel__nav-label">Publications</span>
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
          <UserAvatar
            user={user}
            className="admin-panel__avatar"
            ariaLabel={getUserAvatarLabel(user)}
          />
        </header>

        <main className="admin-panel__main">
          <div className="admin-panel__bg-logo" aria-hidden="true">
            <img src={logoImg} alt="" />
          </div>

          <div
            className={`admin-panel__content${
              ["compliance", "maintenance", "crew", "inventory", "alerts", "documents", "metrics", "publications"].includes(
                activeSection,
              )
                ? " admin-panel__content--wide"
                : ""
            }`}
          >
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

            {activeSection === "assets" && <AssetsSection token={token} />}
            {activeSection === "compliance" && <ComplianceSection token={token} />}
            {activeSection === "maintenance" && <PmsSection token={token} />}
            {activeSection === "crew" && <CrewSection token={token} />}
            {activeSection === "inventory" && <InventorySection token={token} />}
            {activeSection === "alerts" && <AlertsSection token={token} />}

            {activeSection === "metrics" && <MetricsSection token={token} />}

            {activeSection === "documents" && <DocumentsSection />}

            {activeSection === "publications" && (
              <PublicationsSection token={token} />
            )}
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
