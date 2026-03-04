import sendIcon from '../../assets/Vector.svg';

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
}

export function MessageInput({
  value,
  onChange,
  onSend,
  disabled = false,
  placeholder = 'Type a message...',
}: MessageInputProps) {
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
          disabled={disabled}
          aria-label="Message input"
        />
      </div>
      <button
        type="submit"
        className="chat-main__send"
        disabled={disabled || !value.trim()}
        aria-label="Send message"
      >
        <img src={sendIcon} alt="" className="chat-main__send-img" />
      </button>
    </form>
  );
}
