import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { TagOption } from "../../api/client";
import { getTagOptions } from "../../api/client";
import { SearchIcon, TagIcon, XIcon } from "./AdminPanelIcons";

interface TagLinksEditorModalProps {
  token: string | null;
  title: string;
  entityLabel: string;
  selectionMode?: "single" | "multiple";
  onClose: () => void;
  onError: (message: string) => void;
  loadSelectedTags: () => Promise<TagOption[]>;
  saveSelectedTags: (tagIds: string[]) => Promise<TagOption[]>;
}

export function TagLinksEditorModal({
  token,
  title,
  entityLabel,
  selectionMode = "single",
  onClose,
  onError,
  loadSelectedTags,
  saveSelectedTags,
}: TagLinksEditorModalProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [subcategoryFilter, setSubcategoryFilter] = useState("");
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    onError("");

    Promise.all([getTagOptions(token), loadSelectedTags()])
      .then(([options, selected]) => {
        if (cancelled) return;
        setTagOptions(options);
        setSelectedTagIds(selected.map((tag) => tag.id));
      })
      .catch((error) => {
        if (cancelled) return;
        onError(
          error instanceof Error ? error.message : "Failed to load tag links",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loadSelectedTags, onError, token]);

  const categoryOptions = useMemo(
    () => [...new Set(tagOptions.map((tag) => tag.category))].sort(),
    [tagOptions],
  );
  const subcategoryOptions = useMemo(() => {
    const scoped = categoryFilter
      ? tagOptions.filter((tag) => tag.category === categoryFilter)
      : tagOptions;
    return [...new Set(scoped.map((tag) => tag.subcategory))].sort();
  }, [categoryFilter, tagOptions]);

  useEffect(() => {
    if (!subcategoryFilter) return;
    if (!subcategoryOptions.includes(subcategoryFilter)) {
      setSubcategoryFilter("");
    }
  }, [subcategoryFilter, subcategoryOptions]);

  const filteredOptions = useMemo(() => {
    return tagOptions.filter((tag) => {
      if (categoryFilter && tag.category !== categoryFilter) {
        return false;
      }
      if (subcategoryFilter && tag.subcategory !== subcategoryFilter) {
        return false;
      }
      if (!deferredSearch) {
        return true;
      }

      return (
        tag.key.toLowerCase().includes(deferredSearch) ||
        tag.category.toLowerCase().includes(deferredSearch) ||
        tag.subcategory.toLowerCase().includes(deferredSearch) ||
        tag.item.toLowerCase().includes(deferredSearch) ||
        (tag.description?.toLowerCase().includes(deferredSearch) ?? false)
      );
    });
  }, [categoryFilter, deferredSearch, subcategoryFilter, tagOptions]);

  const selectedTags = useMemo(
    () =>
      selectedTagIds
        .map((tagId) => tagOptions.find((tag) => tag.id === tagId) ?? null)
        .filter((tag): tag is TagOption => tag !== null),
    [selectedTagIds, tagOptions],
  );

  const handleSelect = (tagId: string) => {
    setSelectedTagIds((current) => {
      const alreadySelected = current.includes(tagId);
      if (selectionMode === "single") {
        return alreadySelected ? [] : [tagId];
      }

      return alreadySelected
        ? current.filter((currentTagId) => currentTagId !== tagId)
        : [...current, tagId];
    });
  };

  const handleSave = async () => {
    if (!token || saving) return;
    setSaving(true);
    onError("");

    try {
      const selected = await saveSelectedTags(selectedTagIds);
      setSelectedTagIds(selected.map((tag) => tag.id));
      onClose();
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Failed to save tag links",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="admin-panel__modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ap-tag-links-title"
      onClick={(event) => {
        if (event.target === event.currentTarget && !saving) {
          onClose();
        }
      }}
    >
      <div className="admin-panel__modal admin-panel__modal--wide admin-panel__modal--scrollable admin-panel__tag-links-modal">
        <button
          type="button"
          className="admin-panel__modal-close"
          onClick={onClose}
          aria-label="Close"
          disabled={saving}
        >
          <XIcon />
        </button>

        <div className="admin-panel__modal-head">
          <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
            <TagIcon />
          </div>
          <h3 id="ap-tag-links-title" className="admin-panel__modal-title">
            {title}
          </h3>
          <p className="admin-panel__modal-desc">
            Review and update taxonomy links for <strong>{entityLabel}</strong>.
            {selectionMode === "single"
              ? " Only one tag can be linked here at a time."
              : " You can link multiple tags when the document spans more than one topic."}{" "}
            Automatic matching stays conservative, so you can replace or clear
            the selected {selectionMode === "single" ? "tag" : "tags"} when
            needed.
          </p>
        </div>

        {loading ? (
          <div className="admin-panel__state-box admin-panel__manuals-state">
            <div className="admin-panel__spinner" />
            <span className="admin-panel__muted">Loading tags...</span>
          </div>
        ) : (
          <div className="admin-panel__tag-links-layout">
            <div className="admin-panel__tag-links-toolbar">
              <label className="admin-panel__metrics-search">
                <SearchIcon />
                <input
                  type="search"
                  className="admin-panel__metrics-search-input"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search tags by key, category, item, or description..."
                />
              </label>

              <div className="admin-panel__tag-links-toolbar-selects">
                <select
                  className="admin-panel__select admin-panel__select--compact"
                  value={categoryFilter}
                  onChange={(event) => setCategoryFilter(event.target.value)}
                >
                  <option value="">All categories</option>
                  {categoryOptions.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>

                <select
                  className="admin-panel__select admin-panel__select--compact"
                  value={subcategoryFilter}
                  onChange={(event) => setSubcategoryFilter(event.target.value)}
                >
                  <option value="">All subcategories</option>
                  {subcategoryOptions.map((subcategory) => (
                    <option key={subcategory} value={subcategory}>
                      {subcategory}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="admin-panel__tag-links-selected">
              <span className="admin-panel__field-label">
                {selectionMode === "single" ? "Selected tag" : "Selected tags"}
              </span>
              {selectedTags.length === 0 ? (
                <span className="admin-panel__muted">
                  No {selectionMode === "single" ? "tag" : "tags"} selected
                  yet.
                </span>
              ) : (
                <div className="admin-panel__tag-links-chip-list">
                  {selectedTags.map((selectedTag) => (
                    <button
                      key={selectedTag.id}
                      type="button"
                      className="admin-panel__tag-chip admin-panel__tag-chip--selected"
                      onClick={() =>
                        setSelectedTagIds((current) =>
                          current.filter(
                            (currentTagId) => currentTagId !== selectedTag.id,
                          ),
                        )
                      }
                    >
                      <span>{selectedTag.key}</span>
                      <XIcon />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="admin-panel__tag-links-list">
              {filteredOptions.length === 0 ? (
                <div className="admin-panel__state-box">
                  <span className="admin-panel__muted">
                    No tags found for the current filters.
                  </span>
                </div>
              ) : (
                filteredOptions.map((tag) => {
                  const checked = selectedTagIds.includes(tag.id);
                  return (
                    <label
                      key={tag.id}
                      className={`admin-panel__tag-links-row${
                        checked ? " admin-panel__tag-links-row--selected" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="admin-panel__selection-check"
                        checked={checked}
                        onChange={() => handleSelect(tag.id)}
                      />
                      <div className="admin-panel__tag-links-row-copy">
                        <span className="admin-panel__tag-links-row-key">
                          {tag.key}
                        </span>
                        <span className="admin-panel__tag-links-row-meta">
                          {tag.category} / {tag.subcategory} / {tag.item}
                        </span>
                        {tag.description && (
                          <span className="admin-panel__tag-links-row-desc">
                            {tag.description}
                          </span>
                        )}
                      </div>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        )}

        <div className="admin-panel__modal-actions">
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--ghost"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--primary"
            onClick={handleSave}
            disabled={saving || loading}
          >
            {saving ? "Saving..." : "Save tags"}
          </button>
        </div>
      </div>
    </div>
  );
}
