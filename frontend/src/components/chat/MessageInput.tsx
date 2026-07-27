import { useEffect, useRef } from 'react';
import sendIcon from '../../assets/Vector.svg';
import { useVoiceCaptureSession } from '../../hooks/useVoiceCaptureSession';
import { VoiceInputButton } from './VoiceInputButton';
import { VoiceInputSessionPanel } from './VoiceInputSessionPanel';
import { ChatPlusMenu, type ChatPanelAction } from './ChatPlusMenu';

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  token: string | null;
  sessionId?: string | null;
  disabled?: boolean;
  placeholder?: string;
  /** "+ Attach photo" staging (photos ride with the next message). */
  onAttachFiles?: (files: File[]) => void;
  pendingFiles?: Array<{ file: File; previewUrl: string }>;
  onRemovePending?: (index: number) => void;
  /** Open a right-side action panel (work order / defect / document / parts). */
  onOpenPanel?: (action: ChatPanelAction) => void;
  /** Master/Chief-officer-only actions (Add document) shown when true. */
  canManageVessel?: boolean;
  /** "down" on the centred new-chat composer, "up" in a live chat. */
  menuPlacement?: 'up' | 'down';
}

export function MessageInput({
  value,
  onChange,
  onSend,
  token,
  sessionId,
  disabled = false,
  placeholder = 'Type a message...',
  onAttachFiles,
  pendingFiles = [],
  onRemovePending,
  onOpenPanel,
  canManageVessel,
  menuPlacement,
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

  // A long prompt used to scroll inside one line; the composer now grows
  // with the text (height, since it is already full width) up to the cap in
  // CSS, then scrolls.
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
        {onOpenPanel && (
          <ChatPlusMenu
            disabled={disabled}
            canManageVessel={canManageVessel}
            onAttachFiles={onAttachFiles}
            onOpenPanel={onOpenPanel}
            placement={menuPlacement}
          />
        )}
        <textarea
          ref={inputRef}
          className="chat-main__input"
          placeholder={placeholder}
          value={value}
          rows={1}
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
