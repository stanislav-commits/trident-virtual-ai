import { useEffect, useState } from "react";

interface ToastProps {
  message: string;
  type?: "error" | "success" | "info";
  duration?: number;
  onClose?: () => void;
}

function ToastStatusIcon({ type }: { type: NonNullable<ToastProps["type"]> }) {
  if (type === "success") {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }

  if (type === "info") {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </svg>
    );
  }

  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m10.29 3.86-8 14A1 1 0 0 0 3.16 19h17.68a1 1 0 0 0 .87-1.5l-8-14a1 1 0 0 0-1.74 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function ToastCloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m18 6-12 12" />
      <path d="m6 6 12 12" />
    </svg>
  );
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
      setTimeout(() => onClose?.(), 300);
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
          <ToastStatusIcon type={type} />
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
        <ToastCloseIcon />
      </button>
    </div>
  );
}
