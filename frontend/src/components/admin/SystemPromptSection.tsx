import { useEffect, useState } from "react";
import {
  getSystemPrompt,
  updateSystemPrompt,
  type SystemPromptConfig,
} from "../../api/client";

interface SystemPromptSectionProps {
  token: string | null;
  error: string;
  onError: (error: string) => void;
}

function formatUpdatedBy(config: SystemPromptConfig | null): string {
  const updatedBy = config?.updatedBy;
  if (!updatedBy) {
    return "Not recorded";
  }

  if (updatedBy.name?.trim()) {
    return `${updatedBy.name.trim()} (${updatedBy.userId})`;
  }

  return updatedBy.userId;
}

function formatUpdatedAt(updatedAt: string | null): string {
  if (!updatedAt) {
    return "Not recorded";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(updatedAt));
}

export function SystemPromptSection({
  token,
  error,
  onError,
}: SystemPromptSectionProps) {
  const [config, setConfig] = useState<SystemPromptConfig | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [savedPromptValue, setSavedPromptValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const applyConfig = (nextConfig: SystemPromptConfig) => {
    setConfig(nextConfig);
    setPromptValue(nextConfig.prompt);
    setSavedPromptValue(nextConfig.prompt);
  };

  useEffect(() => {
    if (!token) {
      setConfig(null);
      setPromptValue("");
      setSavedPromptValue("");
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    onError("");

    getSystemPrompt(token)
      .then((nextConfig) => {
        if (!active) return;
        applyConfig(nextConfig);
      })
      .catch((err) => {
        if (!active) return;
        onError(
          err instanceof Error ? err.message : "Failed to load system prompt",
        );
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [token, onError]);

  const hasUnsavedChanges = promptValue !== savedPromptValue;
  const lineCount = promptValue ? promptValue.split(/\r?\n/).length : 0;
  const charCount = promptValue.length;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !promptValue.trim() || !hasUnsavedChanges) {
      return;
    }

    setSaving(true);
    onError("");

    try {
      const nextConfig = await updateSystemPrompt(promptValue, token);
      applyConfig(nextConfig);
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "Failed to update system prompt",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDiscardChanges = () => {
    setPromptValue(savedPromptValue);
  };

  return (
    <section className="admin-panel__section">
      <div className="admin-panel__section-head">
        <div className="admin-panel__section-intro">
          <h2 className="admin-panel__section-title">System Prompt</h2>
          <p className="admin-panel__section-subtitle">
            Edit the global assistant instructions used for new chat responses.
            Saved changes are stored in the database and apply immediately.
          </p>
        </div>
      </div>

      {error && (
        <div className="admin-panel__error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="admin-panel__state-box">
          <div className="admin-panel__spinner" />
          <span className="admin-panel__muted">Loading system prompt...</span>
        </div>
      ) : (
        <div className="admin-panel__prompt-layout">
          <form className="admin-panel__form-card" onSubmit={handleSubmit}>
            <div className="admin-panel__prompt-toolbar">
              <div>
                <h3 className="admin-panel__form-card-title">Prompt editor</h3>
                <p className="admin-panel__prompt-note">
                  This prompt is stored in the database and used for all new
                  assistant responses. You can use placeholders for ship context
                  when needed.
                </p>
              </div>

              <div className="admin-panel__prompt-actions">
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--ghost"
                  onClick={handleDiscardChanges}
                  disabled={!hasUnsavedChanges || saving}
                >
                  Discard changes
                </button>
                <button
                  type="submit"
                  className="admin-panel__btn admin-panel__btn--primary"
                  disabled={saving || !promptValue.trim() || !hasUnsavedChanges}
                >
                  {saving ? "Saving..." : "Save prompt"}
                </button>
              </div>
            </div>

            <div className="admin-panel__field admin-panel__prompt-field">
              <label
                className="admin-panel__field-label"
                htmlFor="ap-system-prompt"
              >
                Prompt template
              </label>
              <textarea
                id="ap-system-prompt"
                value={promptValue}
                onChange={(event) => setPromptValue(event.target.value)}
                className="admin-panel__input admin-panel__textarea admin-panel__prompt-editor"
                rows={26}
                spellCheck={false}
                disabled={saving}
              />
            </div>
          </form>

          <div className="admin-panel__prompt-side">
            <div className="admin-panel__form-card admin-panel__prompt-meta-card">
              <h3 className="admin-panel__form-card-title">
                Current configuration
              </h3>
              <div className="admin-panel__prompt-meta-list">
                <div className="admin-panel__prompt-meta-item">
                  <span className="admin-panel__field-label">Storage</span>
                  <span className="admin-panel__prompt-meta-value">
                    {config?.isDefault
                      ? "Fallback template active"
                      : "Database prompt"}
                  </span>
                </div>
                <div className="admin-panel__prompt-meta-item">
                  <span className="admin-panel__field-label">Last updated</span>
                  <span className="admin-panel__prompt-meta-value">
                    {formatUpdatedAt(config?.updatedAt ?? null)}
                  </span>
                </div>
                <div className="admin-panel__prompt-meta-item">
                  <span className="admin-panel__field-label">Updated by</span>
                  <span className="admin-panel__prompt-meta-value">
                    {formatUpdatedBy(config)}
                  </span>
                </div>
                <div className="admin-panel__prompt-meta-item">
                  <span className="admin-panel__field-label">Size</span>
                  <span className="admin-panel__prompt-meta-value">
                    {lineCount} lines / {charCount.toLocaleString()} chars
                  </span>
                </div>
              </div>
            </div>

            <div className="admin-panel__form-card admin-panel__prompt-meta-card">
              <h3 className="admin-panel__form-card-title">
                Available placeholders
              </h3>
              <ul className="admin-panel__prompt-helper-list">
                {(config?.placeholders ?? []).map((placeholder) => (
                  <li key={placeholder.token}>
                    <code className="admin-panel__code-inline">
                      {placeholder.token}
                    </code>{" "}
                    {placeholder.description}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
