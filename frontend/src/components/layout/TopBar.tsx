import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminShip } from "../../context/AdminShipContext";
import { useAuth } from "../../context/AuthContext";
import { appRoutes } from "../../utils/routes";
import { listAlerts } from "../../api/alertsApi";
import { canRead } from "../../api/accessControlApi";
import { useMyAccess } from "../../hooks/useMyAccess";
import { UserAvatar } from "./UserAvatar";
import { getUserAvatarLabel } from "./userAvatarUtils";

function formatActiveVesselName(ship: { name: string }): string {
  return ship.name.trim() || "Unnamed vessel";
}

export function TopBar() {
  const { user, token } = useAuth();
  const myAccess = useMyAccess();
  const {
    availableShips,
    selectedShipId,
    selectedShip,
    sessionShipId,
    isLoading,
    setSelectedShipId,
  } = useAdminShip();
  const navigate = useNavigate();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [alertCount, setAlertCount] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const loadAlertCount = useCallback(() => {
    if (!token || !sessionShipId) {
      setAlertCount(0);
      return;
    }
    listAlerts(token, sessionShipId, "firing")
      .then((a) => setAlertCount(a.length))
      .catch(() => {});
  }, [token, sessionShipId]);

  useEffect(() => {
    loadAlertCount();
    const id = setInterval(loadAlertCount, 30000);
    const onChange = () => loadAlertCount();
    window.addEventListener("trident:alerts-changed", onChange);
    return () => {
      clearInterval(id);
      window.removeEventListener("trident:alerts-changed", onChange);
    };
  }, [loadAlertCount]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setDropdownOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [dropdownOpen]);

  const handleAdminPanel = () => {
    setDropdownOpen(false);
    navigate(appRoutes.adminSection("users"));
  };

  const profileLabel = getUserAvatarLabel(user);
  const selectedShipLabel = selectedShip
    ? formatActiveVesselName(selectedShip)
    : isLoading
      ? "Loading vessels..."
      : "Select vessel";
  const shipContextClassName = [
    "chat-topbar__ship-context",
    selectedShipId ? "" : "chat-topbar__ship-context--unset",
    isLoading ? "chat-topbar__ship-context--loading" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <header className="chat-topbar">
      <div className="chat-topbar__left">
        {user?.role === "admin" && (
          <div className={shipContextClassName}>
            <div className="chat-topbar__ship-copy">
              <span className="chat-topbar__ship-label">Active vessel</span>
              <span className="chat-topbar__ship-value">
                {selectedShipLabel}
              </span>
            </div>
            <select
              className="chat-topbar__ship-select"
              value={selectedShipId ?? ""}
              onChange={(event) =>
                setSelectedShipId(event.target.value || null)
              }
              disabled={isLoading}
              aria-label="Select active vessel"
            >
              <option value="">
                {isLoading ? "Loading vessels..." : "Select vessel for new chats"}
              </option>
              {availableShips.map((ship) => (
                <option key={ship.id} value={ship.id}>
                  {formatActiveVesselName(ship)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="chat-topbar__right">
        {canRead(myAccess, "alerts") && (
        <button
          type="button"
          className="chat-topbar__pms-btn chat-topbar__bell-btn"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("trident:toggle-alerts"))
          }
          aria-label="Toggle alerts panel"
          title="Alerts"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          {alertCount > 0 && (
            <span className="chat-topbar__bell-badge">
              {alertCount > 9 ? "9+" : alertCount}
            </span>
          )}
        </button>
        )}
        {canRead(myAccess, "pms_tasks") && (
        <button
          type="button"
          className="chat-topbar__pms-btn"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("trident:toggle-pms"))
          }
          aria-label="Toggle upcoming PMS panel"
          title="Upcoming PMS"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
            <path d="M9 16l2 2 4-4" />
          </svg>
        </button>
        )}
        {user && user.role !== "admin" && (
          <UserAvatar
            user={user}
            className="chat-topbar__avatar"
            ariaLabel={profileLabel}
          />
        )}
        {user?.role === "admin" && (
          <div className="chat-topbar__profile-wrap" ref={wrapRef}>
            <button
              type="button"
              className="chat-topbar__profile-btn"
              onClick={() => setDropdownOpen((o) => !o)}
              aria-label={`${profileLabel} profile menu`}
              aria-expanded={dropdownOpen}
            >
              <UserAvatar
                user={user}
                className="chat-topbar__avatar"
                ariaLabel={profileLabel}
              />
            </button>
            {dropdownOpen && (
              <div className="chat-topbar__profile-dropdown">
                {user?.role && (
                  <div className="chat-topbar__profile-info">
                    <span className="chat-topbar__profile-role">
                      {user.role}
                    </span>
                  </div>
                )}
                {user?.role === "admin" && (
                  <button
                    type="button"
                    className="chat-topbar__profile-item"
                    onClick={handleAdminPanel}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <circle cx="12" cy="8" r="4" />
                      <path d="M20 21a8 8 0 1 0-16 0" />
                    </svg>
                    Admin panel
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
