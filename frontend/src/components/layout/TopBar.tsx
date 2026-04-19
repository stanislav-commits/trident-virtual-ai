import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import profileIcon from "../../assets/profile.svg";
import { useAdminShip } from "../../context/AdminShipContext";
import { useAuth } from "../../context/AuthContext";
import { appRoutes } from "../../utils/routes";

export function TopBar() {
  const { user } = useAuth();
  const {
    availableShips,
    selectedShipId,
    selectedShip,
    isLoading,
    setSelectedShipId,
  } = useAdminShip();
  const navigate = useNavigate();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

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

  const initials =
    user?.role === "admin"
      ? "A"
      : (user?.userId?.slice(0, 2).toUpperCase() ?? "U");
  const selectedShipLabel = selectedShip
    ? selectedShip.organizationName
      ? `${selectedShip.name} - ${selectedShip.organizationName}`
      : selectedShip.name
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
                  {ship.organizationName
                    ? `${ship.name} - ${ship.organizationName}`
                    : ship.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="chat-topbar__right">
        {user?.role === "admin" && (
          <div className="chat-topbar__profile-wrap" ref={wrapRef}>
            <button
              type="button"
              className="chat-topbar__profile-btn"
              onClick={() => setDropdownOpen((o) => !o)}
              aria-label="Profile menu"
              aria-expanded={dropdownOpen}
            >
              <div className="chat-topbar__avatar">
                <img
                  src={profileIcon}
                  alt=""
                  className="chat-topbar__profile-img"
                />
                <span className="chat-topbar__avatar-initials">{initials}</span>
              </div>
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
