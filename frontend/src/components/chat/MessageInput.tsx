import { useEffect } from 'react';
import sendIcon from '../../assets/Vector.svg';
import { useVoiceCaptureSession } from '../../hooks/useVoiceCaptureSession';
import { VoiceInputButton } from './VoiceInputButton';
import { VoiceInputSessionPanel } from './VoiceInputSessionPanel';

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  token: string | null;
  sessionId?: string | null;
  disabled?: boolean;
  placeholder?: string;
}

export function MessageInput({
  value,
  onChange,
  onSend,
  token,
  sessionId,
  disabled = false,
  placeholder = 'Type a message...',
}: MessageInputProps) {
  const voice = useVoiceCaptureSession({ value, onChange, token, sessionId });
  const { isSessionActive, cancel } = voice;

  useEffect(() => {
    if (disabled && isSessionActive) {
      cancel();
    }
  }, [cancel, disabled, isSessionActive]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim()) onSend();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && value.trim() && !disabled) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <form className="chat-main__input-row" onSubmit={handleSubmit}>
      <div className="chat-main__capsule">
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
          disabled={disabled || voice.isSessionActive || !value.trim()}
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
