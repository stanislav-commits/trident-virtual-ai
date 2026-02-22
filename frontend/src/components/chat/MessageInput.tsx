import plusAddIcon from '../../assets/plus-add.svg';
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

  return (
    <form className="chat-main__input-row" onSubmit={handleSubmit}>
      <div className="chat-main__capsule">
        <button type="button" className="chat-main__attach" aria-label="Attach" title="Attach" disabled={disabled}>
          <img src={plusAddIcon} alt="" className="chat-main__attach-img" />
        </button>
        <input
          type="text"
          className="chat-main__input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-label="Message input"
        />
      </div>
      <button
        type="submit"
        className="chat-main__send"
        disabled={disabled || !value.trim()}
        aria-label="Send"
      >
        <img src={sendIcon} alt="" className="chat-main__send-img" />
      </button>
    </form>
  );
}
