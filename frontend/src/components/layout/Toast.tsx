import { useEffect, useState } from "react";

interface ToastProps {
  message: string;
  type?: "error" | "success" | "info";
  duration?: number;
  onClose?: () => void;
}

export function Toast({
  message,
  type = "error",
  duration = 6000,
  onClose,
}: ToastProps) {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    if (!message) {
      setIsVisible(false);
      return;
    }

    setIsVisible(true);
    const timer = setTimeout(() => {
      setIsVisible(false);
      setTimeout(() => onClose?.(), 300); // wait for animation
    }, duration);

    return () => clearTimeout(timer);
  }, [message, duration, onClose]);

  if (!isVisible || !message) return null;

  return (
    <div
      className={`toast toast--${type} ${isVisible ? "toast--visible" : ""}`}
      role="alert"
    >
      <div className="toast__content">
        <span className="toast__icon">
          {type === "error" && "⚠"}
          {type === "success" && "✓"}
          {type === "info" && "ℹ"}
        </span>
        <span className="toast__message">{message}</span>
      </div>
      <button
        className="toast__close"
        onClick={() => {
          setIsVisible(false);
          setTimeout(() => onClose?.(), 300);
        }}
        aria-label="Close notification"
      >
        ✕
      </button>
    </div>
  );
}
