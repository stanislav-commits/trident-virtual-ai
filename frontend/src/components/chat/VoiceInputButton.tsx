import type { VoiceCaptureStatus } from "../../hooks/useVoiceCaptureSession";

interface VoiceInputButtonProps {
  status: VoiceCaptureStatus;
  isSupported: boolean;
  disabled: boolean;
  onStart: () => void;
}

function MicIcon() {
  return (
    <svg
      className="chat-main__voice-icon"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v3" />
    </svg>
  );
}

function getButtonLabel(status: VoiceCaptureStatus, isSupported: boolean) {
  if (!isSupported) return "Voice input is not supported in this browser";
  if (status === "error") return "Start voice input again";
  return "Start voice input";
}

export function VoiceInputButton({
  status,
  isSupported,
  disabled,
  onStart,
}: VoiceInputButtonProps) {
  const isUnavailable = disabled || !isSupported;

  return (
    <button
      type="button"
      className={`chat-main__voice chat-main__voice--${status}`}
      disabled={isUnavailable}
      aria-label={getButtonLabel(status, isSupported)}
      title={getButtonLabel(status, isSupported)}
      onClick={onStart}
    >
      <MicIcon />
    </button>
  );
}
