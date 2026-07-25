import { useEffect } from 'react';
import sendIcon from '../../assets/Vector.svg';
import { useVoiceCaptureSession } from '../../hooks/useVoiceCaptureSession';
import { VoiceInputButton } from './VoiceInputButton';
import { VoiceInputSessionPanel } from './VoiceInputSessionPanel';
import { QuickReportButton } from './QuickReportButton';

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  token: string | null;
  sessionId?: string | null;
  /** Enables the "+" quick-report (defect/incident) entry. */
  shipId?: string | null;
  disabled?: boolean;
  placeholder?: string;
  /** "+ Attach photo" staging (photos ride with the next message). */
  onAttachFiles?: (files: File[]) => void;
  pendingFiles?: Array<{ file: File; previewUrl: string }>;
  onRemovePending?: (index: number) => void;
}

export function MessageInput({
  value,
  onChange,
  onSend,
  token,
  sessionId,
  shipId,
  disabled = false,
  placeholder = 'Type a message...',
  onAttachFiles,
  pendingFiles = [],
  onRemovePending,
}: MessageInputProps) {
  const voice = useVoiceCaptureSession({ value, onChange, token, sessionId });
  const { isSessionActive, cancel } = voice;

  useEffect(() => {
    if (disabled && isSessionActive) {
      cancel();
    }
  }, [cancel, disabled, isSessionActive]);

  const canSend = Boolean(value.trim()) || pendingFiles.length > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (canSend) onSend();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && canSend && !disabled) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <form className="chat-main__input-row" onSubmit={handleSubmit}>
      {pendingFiles.length > 0 && (
        <div className="chat-main__pending">
          {pendingFiles.map((p, i) => (
            <div key={p.previewUrl} className="chat-main__pending-chip">
              <img src={p.previewUrl} alt={p.file.name} />
              <button
                type="button"
                className="chat-main__pending-del"
                aria-label={`Remove ${p.file.name}`}
                onClick={() => onRemovePending?.(i)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="chat-main__capsule">
        <QuickReportButton
          token={token}
          shipId={shipId}
          disabled={disabled}
          onAttachFiles={onAttachFiles}
        />
        <input
          type="text"
          className="chat-main__input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || voice.isSessionActive}
          aria-label="Message input"
        />
        <VoiceInputButton
          status={voice.status}
          isSupported={voice.isSupported}
          disabled={disabled || voice.isSessionActive || !token}
          onStart={voice.start}
        />
        <button
          type="submit"
          className="chat-main__send chat-main__send--inside"
          disabled={disabled || voice.isSessionActive || !canSend}
          aria-label="Send message"
        >
          <img src={sendIcon} alt="" className="chat-main__send-img" />
        </button>
        <VoiceInputSessionPanel
          status={voice.status}
          durationMs={voice.durationMs}
          error={voice.error}
          onDone={voice.done}
          onCancel={voice.cancel}
        />
      </div>
    </form>
  );
}
