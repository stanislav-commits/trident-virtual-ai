import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminShip } from "../context/AdminShipContext";
import { useAuth } from "../context/AuthContext";
import { useChatSessions } from "../hooks/useChatSessions";
import { TopBar } from "../components/layout/TopBar";
import logoImg from "../assets/logo-home.png";
import plusAddIcon from "../assets/plus-add.svg";
import sendIcon from "../assets/Vector.svg";
import { appRoutes } from "../utils/routes";

export function HomePage() {
  const { user, token } = useAuth();
  const { sessionShipId } = useAdminShip();
  const navigate = useNavigate();
  const { createSession, isLoading, error } = useChatSessions(token);

  const [inputValue, setInputValue] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const canCreateChat =
    user?.role === "admin" || (user?.role === "user" && !!user?.shipId);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!inputValue.trim() || !canCreateChat || isCreating) return;

      setIsCreating(true);
      try {
        const newSession = await createSession(
          sessionShipId,
          inputValue.trim(),
        );

        setInputValue("");
        navigate(appRoutes.chatSession(newSession.id));
      } catch (err) {
        console.error("Failed to create chat:", err);
      } finally {
        setIsCreating(false);
      }
    },
    [inputValue, canCreateChat, sessionShipId, createSession, navigate, isCreating],
  );

  const isDisabled =
    !inputValue.trim() || isCreating || isLoading || !canCreateChat;
  const errorMessage =
    error ||
    (user?.role === "user" && !user?.shipId
      ? "No ship assigned to your account"
      : null);

  return (
    <div className="home-layout">
      <TopBar />
      <div className="home-content">
        <div className="home-content__logo-zone">
          <img src={logoImg} alt="Trident Intelligence Platform" className="home-logo" />
        </div>
        <div className="home-card">
          <div className="home-card__welcome">Welcome to</div>
          <h1 className="home-card__title">Trident Intelligence Platform</h1>

          {errorMessage && (
            <div className="home-card__error">{errorMessage}</div>
          )}

          <form className="home-card__input-row" onSubmit={handleSubmit}>
            <div className="home-card__capsule">
              <button
                type="button"
                className="home-card__attach"
                aria-label="Attach"
                title="Attach"
                disabled={isDisabled}
              >
                <img
                  src={plusAddIcon}
                  alt=""
                  className="home-card__attach-img"
                />
              </button>
              <input
                type="text"
                className="home-card__input"
                placeholder="How can I help you today?"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                disabled={isDisabled}
                aria-label="Message"
              />
            </div>
            <button
              type="submit"
              className="home-card__send"
              disabled={isDisabled}
              aria-label="Send"
              title={isCreating ? "Creating chat..." : "Send"}
            >
              <img src={sendIcon} alt="" className="home-card__send-img" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
