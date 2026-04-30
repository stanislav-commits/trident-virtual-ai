import type { VoiceCaptureStatus } from "../../hooks/useVoiceCaptureSession";

interface VoiceInputSessionPanelProps {
  status: VoiceCaptureStatus;
  durationMs: number;
  error: string | null;
  onDone: () => void;
  onCancel: () => void;
}

function getStatusLabel(status: VoiceCaptureStatus, error: string | null) {
  if (status === "requestingPermission") return "Waiting for microphone access...";
  if (status === "recording") return "Recording...";
  if (status === "stopping") return "Finalizing audio...";
  if (status === "transcribing") return "Transcribing...";
  if (status === "error") return error ?? "Voice input failed.";
  return "";
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function VoiceInputSessionPanel({
  status,
  durationMs,
  error,
  onDone,
  onCancel,
}: VoiceInputSessionPanelProps) {
  const isBusy = status === "stopping" || status === "transcribing";
  const isRecording = status === "recording";
  const isError = status === "error";
  const canSubmit = status === "recording";
  const statusLabel = getStatusLabel(status, error);

  if (status === "idle" || status === "unsupported") {
    return null;
  }

  return (
    <div
      className={`chat-main__voice-panel chat-main__voice-panel--${status}`}
      role={isError ? "alert" : "status"}
      aria-live="polite"
    >
      <div className="chat-main__voice-panel-indicator" aria-hidden="true">
        <span className="chat-main__voice-panel-dot" />
        <span className="chat-main__voice-panel-wave" />
      </div>
      <div className="chat-main__voice-panel-copy">
        <div className="chat-main__voice-panel-status">{statusLabel}</div>
        <div className="chat-main__voice-panel-transcript">
          {status === "requestingPermission"
            ? "Allow microphone access in the browser prompt."
            : isRecording
              ? `Recording ${formatDuration(durationMs)}`
              : "Transcript will be inserted into the message input."}
        </div>
      </div>
      <div className="chat-main__voice-panel-actions">
        <button
          type="button"
          className="chat-main__voice-panel-action chat-main__voice-panel-action--cancel"
          onClick={onCancel}
          disabled={isBusy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="chat-main__voice-panel-action chat-main__voice-panel-action--done"
          onClick={onDone}
          disabled={isError || isBusy || !canSubmit}
        >
          Done
        </button>
      </div>
    </div>
  );
}
