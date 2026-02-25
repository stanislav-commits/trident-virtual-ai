import { useState, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { useChatSessions } from "../hooks/useChatSessions";
import type { TopBarTab } from "../components/layout/TopBar";
import { TopBar } from "../components/layout/TopBar";
import logoImg from "../assets/logo-home.png";
import plusAddIcon from "../assets/plus-add.svg";
import sendIcon from "../assets/Vector.svg";

interface HomePageProps {
  activeTab: TopBarTab;
  onTabChange: (tab: TopBarTab) => void;
  onChatCreated: (sessionId: string) => void;
}

export function HomePage({
  activeTab,
  onTabChange,
  onChatCreated,
}: HomePageProps) {
  const { user, token } = useAuth();
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
        const shipIdForSession =
          user?.role === "admin" ? undefined : (user?.shipId ?? undefined);
        const newSession = await createSession(
          shipIdForSession,
          inputValue.trim(),
        );

        setInputValue("");
        setIsCreating(false);

        onChatCreated(newSession.id);
      } catch (err) {
        console.error("Failed to create chat:", err);
        setIsCreating(false);
      }
    },
    [inputValue, canCreateChat, user?.role, user?.shipId, createSession, onChatCreated, isCreating],
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
      <TopBar activeTab={activeTab} onTabChange={onTabChange} />
      <div className="home-content">
        <div className="home-content__logo-zone">
          <img src={logoImg} alt="Trident Virtual AI" className="home-logo" />
        </div>
        <div className="home-card">
          <div className="home-card__welcome">Welcome to</div>
          <h1 className="home-card__title">TRIDENT VIRTUAL AI</h1>

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
