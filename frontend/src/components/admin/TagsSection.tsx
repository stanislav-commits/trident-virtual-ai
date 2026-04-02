import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  bulkDeleteTags,
  createTag,
  deleteTag,
  getTags,
  importTags,
  type PaginationMeta,
  type TagImportResult,
  type TagListFiltersMeta,
  type TagListItem,
  type TagListSummary,
  updateTag,
} from "../../api/client";
import {
  PlusIcon,
  SearchIcon,
  TagIcon,
  UploadIcon,
  XIcon,
} from "./AdminPanelIcons";

interface TagsSectionProps {
  token: string | null;
  error: string;
  onError: (error: string) => void;
}

interface TagForm {
  category: string;
  subcategory: string;
  item: string;
  description: string;
}

const TAG_PAGE_SIZE_OPTIONS = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

const EMPTY_PAGINATION: PaginationMeta = {
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  total: 0,
  totalPages: 1,
  hasNextPage: false,
  hasPreviousPage: false,
};

const EMPTY_SUMMARY: TagListSummary = {
  totalTags: 0,
  filteredTags: 0,
  categories: 0,
  metricLinks: 0,
  manualLinks: 0,
};

const EMPTY_FILTERS: TagListFiltersMeta = {
  categoryOptions: [],
  subcategoryOptions: [],
};

function SelectionCheckbox({
  checked,
  indeterminate = false,
  disabled = false,
  ariaLabel,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <input
      ref={inputRef}
      type="checkbox"
      className="admin-panel__selection-check"
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function createEmptyTagForm(): TagForm {
  return {
    category: "",
    subcategory: "",
    item: "",
    description: "",
  };
}

function createFormFromTag(tag: TagListItem): TagForm {
  return {
    category: tag.category,
    subcategory: tag.subcategory,
    item: tag.item,
    description: tag.description ?? "",
  };
}

function normalizeTagSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildCanonicalTagKey(form: TagForm) {
  const parts = [
    normalizeTagSegment(form.category),
    normalizeTagSegment(form.subcategory),
    normalizeTagSegment(form.item),
  ];

  if (parts.some((part) => !part)) {
    return "";
  }

  return parts.join(":");
}

function formatUpdatedAt(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function toQueryFilterValue(value: string) {
  return value === "all" ? undefined : value;
}

function matchesCurrentTagQuery(
  tag: TagListItem,
  query: {
    search?: string;
    category?: string;
    subcategory?: string;
  },
) {
  if (query.category && tag.category !== query.category) {
    return false;
  }

  if (query.subcategory && tag.subcategory !== query.subcategory) {
    return false;
  }

  if (!query.search) {
    return true;
  }

  const haystack = [
    tag.key,
    tag.category,
    tag.subcategory,
    tag.item,
    tag.description ?? "",
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(query.search.toLowerCase());
}

export function TagsSection({ token, error, onError }: TagsSectionProps) {
  const [tags, setTags] = useState<TagListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState<PaginationMeta>(EMPTY_PAGINATION);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [filtersMeta, setFiltersMeta] = useState<TagListFiltersMeta>(EMPTY_FILTERS);
  const [summary, setSummary] = useState<TagListSummary>(EMPTY_SUMMARY);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [appliedSearch, setAppliedSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [subcategoryFilter, setSubcategoryFilter] = useState("all");
  const [showFormModal, setShowFormModal] = useState(false);
  const [editingTag, setEditingTag] = useState<TagListItem | null>(null);
  const [tagForm, setTagForm] = useState<TagForm>(createEmptyTagForm);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TagListItem | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<TagImportResult | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [allTagsSelected, setAllTagsSelected] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [excludedTagIds, setExcludedTagIds] = useState<string[]>([]);
  const latestLoadRequestRef = useRef(0);
  const importInputRef = useRef<HTMLInputElement>(null);

  const selectedTagIdSet = useMemo(
    () => new Set(selectedTagIds),
    [selectedTagIds],
  );
  const excludedTagIdSet = useMemo(
    () => new Set(excludedTagIds),
    [excludedTagIds],
  );

  const currentQuery = useMemo(
    () => ({
      search: appliedSearch || undefined,
      category: toQueryFilterValue(categoryFilter),
      subcategory: toQueryFilterValue(subcategoryFilter),
    }),
    [appliedSearch, categoryFilter, subcategoryFilter],
  );

  const clearSelection = useMemo(
    () => () => {
      setAllTagsSelected(false);
      setSelectedTagIds([]);
      setExcludedTagIds([]);
    },
    [],
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setAppliedSearch(deferredSearch);
    }, 220);

    return () => window.clearTimeout(timeoutId);
  }, [deferredSearch]);

  useEffect(() => {
    if (
      subcategoryFilter !== "all" &&
      !filtersMeta.subcategoryOptions.includes(subcategoryFilter)
    ) {
      setSubcategoryFilter("all");
    }
  }, [filtersMeta.subcategoryOptions, subcategoryFilter]);

  const loadTagsPage = useMemo(
    () =>
      async (
        targetPage: number,
        targetPageSize: number,
        options?: {
          silent?: boolean;
          search?: string;
          category?: string;
          subcategory?: string;
        },
      ) => {
        if (!token) return;
        const requestId = latestLoadRequestRef.current + 1;
        latestLoadRequestRef.current = requestId;

        if (!options?.silent) {
          setLoading(true);
        }

        try {
          const result = await getTags(token, {
            page: targetPage,
            pageSize: targetPageSize,
            search: options?.search,
            category: options?.category,
            subcategory: options?.subcategory,
          });

          if (requestId !== latestLoadRequestRef.current) {
            return;
          }

          setTags(result.items);
          setPagination(result.pagination);
          setPage(result.pagination.page);
          setPageSize(result.pagination.pageSize);
          setFiltersMeta(result.filters);
          setSummary(result.summary);
        } catch (err) {
          if (!options?.silent && requestId === latestLoadRequestRef.current) {
            onError(err instanceof Error ? err.message : "Failed to load tags");
          }
        } finally {
          if (!options?.silent && requestId === latestLoadRequestRef.current) {
            setLoading(false);
          }
        }
      },
    [onError, token],
  );

  useEffect(() => {
    if (!token) return;
    onError("");
    setDeleteTarget(null);
    setConfirmBulkDelete(false);
    clearSelection();
    void loadTagsPage(1, pageSize, currentQuery);
  }, [clearSelection, currentQuery, loadTagsPage, onError, pageSize, token]);

  const previewKey = buildCanonicalTagKey(tagForm);
  const hasActiveFilters =
    search.trim().length > 0 ||
    categoryFilter !== "all" ||
    subcategoryFilter !== "all";
  const showingFrom = pagination.total === 0 ? 0 : (page - 1) * pageSize + 1;
  const showingTo =
    pagination.total === 0 ? 0 : Math.min(page * pageSize, pagination.total);
  const hasMultiplePages = pagination.totalPages > 1;
  const showPageSizeControl =
    pagination.total > DEFAULT_PAGE_SIZE || hasMultiplePages;
  const selectedTagCount = allTagsSelected
    ? Math.max(0, pagination.total - excludedTagIds.length)
    : selectedTagIds.length;
  const headerCheckboxChecked =
    pagination.total > 0 && allTagsSelected && excludedTagIds.length === 0;
  const headerCheckboxIndeterminate =
    selectedTagCount > 0 && !headerCheckboxChecked;
  const isSearching = Boolean(
    currentQuery.search || currentQuery.category || currentQuery.subcategory,
  );
  const selectionSummary =
    allTagsSelected && excludedTagIds.length === 0
      ? `All ${pagination.total.toLocaleString()} matching tags selected`
      : `${selectedTagCount.toLocaleString()} selected`;
  const resultsSummary =
    pagination.total === 0
      ? "No tags to display"
      : isSearching
        ? `Showing ${showingFrom}-${showingTo} of ${pagination.total.toLocaleString()} matching tags`
        : `Showing ${showingFrom}-${showingTo} of ${pagination.total.toLocaleString()} tags`;
  const emptyStateMessage = isSearching
    ? "No tags match the current filters."
    : "No tags yet. Add them manually or import a JSON taxonomy.";
  const visibleWarnings = importResult?.warnings.slice(0, 8) ?? [];

  const openCreateModal = () => {
    setEditingTag(null);
    setTagForm(createEmptyTagForm());
    onError("");
    setShowFormModal(true);
  };

  const openEditModal = (tag: TagListItem) => {
    setEditingTag(tag);
    setTagForm(createFormFromTag(tag));
    onError("");
    setShowFormModal(true);
  };

  const closeFormModal = () => {
    if (saving) return;
    setShowFormModal(false);
    setEditingTag(null);
    setTagForm(createEmptyTagForm());
  };

  const isTagSelected = (tagId: string) =>
    allTagsSelected
      ? !excludedTagIdSet.has(tagId)
      : selectedTagIdSet.has(tagId);

  const toggleAllTagsSelection = (checked: boolean) => {
    if (checked) {
      setAllTagsSelected(true);
      setSelectedTagIds([]);
      setExcludedTagIds([]);
      return;
    }

    clearSelection();
  };

  const toggleTagSelection = (tagId: string, checked: boolean) => {
    if (allTagsSelected) {
      setExcludedTagIds((current) => {
        const next = checked
          ? current.filter((id) => id !== tagId)
          : [...new Set([...current, tagId])];

        if (pagination.total - next.length <= 0) {
          setAllTagsSelected(false);
          setSelectedTagIds([]);
          return [];
        }

        return next;
      });
      return;
    }

    setSelectedTagIds((current) =>
      checked
        ? [...new Set([...current, tagId])]
        : current.filter((id) => id !== tagId),
    );
  };

  const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !previewKey) {
      return;
    }

    setSaving(true);
    onError("");

    try {
      const previousTag = editingTag;
      const payload = {
        category: tagForm.category,
        subcategory: tagForm.subcategory,
        item: tagForm.item,
        description: tagForm.description.trim() || null,
      };

      let savedTag: TagListItem;
      if (editingTag) {
        savedTag = await updateTag(editingTag.id, payload, token);
      } else {
        savedTag = await createTag(payload, token);
      }

      setShowFormModal(false);
      setEditingTag(null);
      setTagForm(createEmptyTagForm());
      clearSelection();

      if (!previousTag) {
        await loadTagsPage(1, pageSize, currentQuery);
        return;
      }

      if (!matchesCurrentTagQuery(savedTag, currentQuery)) {
        await loadTagsPage(page, pageSize, currentQuery);
        return;
      }

      setTags((current) =>
        current.map((tag) => (tag.id === savedTag.id ? savedTag : tag)),
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to save tag");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!token || !deleteTarget) {
      return;
    }

    setDeletingId(deleteTarget.id);
    onError("");
    const targetId = deleteTarget.id;
    const fallbackPage = tags.length === 1 && page > 1 ? page - 1 : page;
    setDeleteTarget(null);

    try {
      await deleteTag(targetId, token);
      setSelectedTagIds((current) => current.filter((id) => id !== targetId));
      setExcludedTagIds((current) => current.filter((id) => id !== targetId));
      await loadTagsPage(fallbackPage, pageSize, currentQuery);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete tag");
    } finally {
      setDeletingId(null);
    }
  };

  const handleBulkDelete = async () => {
    if (!token) {
      return;
    }

    setBulkDeleting(true);
    onError("");

    try {
      await bulkDeleteTags(
        allTagsSelected
          ? {
              mode: "all",
              category: currentQuery.category,
              subcategory: currentQuery.subcategory,
              search: currentQuery.search,
              excludeTagIds: excludedTagIds,
            }
          : {
              mode: "tagIds",
              category: currentQuery.category,
              subcategory: currentQuery.subcategory,
              search: currentQuery.search,
              tagIds: selectedTagIds,
            },
        token,
      );

      clearSelection();
      await loadTagsPage(page, pageSize, currentQuery);
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "Failed to delete selected tags",
      );
    } finally {
      setBulkDeleting(false);
    }
  };

  const openImportModal = () => {
    setImportFile(null);
    setImportResult(null);
    onError("");
    if (importInputRef.current) {
      importInputRef.current.value = "";
    }
    setShowImportModal(true);
  };

  const closeImportModal = () => {
    if (importing) return;
    setShowImportModal(false);
    setImportFile(null);
    if (importInputRef.current) {
      importInputRef.current.value = "";
    }
  };

  const handleImport = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !importFile) {
      return;
    }

    setImporting(true);
    onError("");

    try {
      const result = await importTags(importFile, token);
      setImportResult(result);
      setShowImportModal(false);
      setImportFile(null);
      if (importInputRef.current) {
        importInputRef.current.value = "";
      }
      clearSelection();
      await loadTagsPage(1, pageSize, currentQuery);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to import tags");
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <section className="admin-panel__section">
        <div className="admin-panel__section-head">
          <div className="admin-panel__section-intro">
            <h2 className="admin-panel__section-title">Tags</h2>
            <p className="admin-panel__section-subtitle">
              Manage the global taxonomy used for knowledge routing. Tags are
              stored as{" "}
              <code className="admin-panel__code-inline">
                category:subcategory:item
              </code>{" "}
              and repeated JSON imports update matching records instead of
              creating duplicates.
            </p>
          </div>

          <div className="admin-panel__tags-actions">
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--ghost"
              onClick={openImportModal}
            >
              <UploadIcon /> Import JSON
            </button>
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--primary"
              onClick={openCreateModal}
            >
              <PlusIcon /> Add tag
            </button>
          </div>
        </div>

        <div className="admin-panel__tags-stats">
          <article className="admin-panel__tags-stat-card">
            <span className="admin-panel__tags-stat-label">Total tags</span>
            <strong className="admin-panel__tags-stat-value">
              {summary.totalTags.toLocaleString()}
            </strong>
          </article>
          <article className="admin-panel__tags-stat-card">
            <span className="admin-panel__tags-stat-label">Categories</span>
            <strong className="admin-panel__tags-stat-value">
              {summary.categories.toLocaleString()}
            </strong>
          </article>
          <article className="admin-panel__tags-stat-card">
            <span className="admin-panel__tags-stat-label">Metric links</span>
            <strong className="admin-panel__tags-stat-value">
              {summary.metricLinks.toLocaleString()}
            </strong>
          </article>
          <article className="admin-panel__tags-stat-card">
            <span className="admin-panel__tags-stat-label">Manual links</span>
            <strong className="admin-panel__tags-stat-value">
              {summary.manualLinks.toLocaleString()}
            </strong>
          </article>
        </div>

        {error && (
          <div className="admin-panel__error" role="alert">
            {error}
          </div>
        )}

        <div className="admin-panel__tags-toolbar">
          <label className="admin-panel__tags-search" htmlFor="ap-tags-search">
            <SearchIcon />
            <input
              id="ap-tags-search"
              type="search"
              className="admin-panel__tags-search-input"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by key, category, item or description"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <select
            className="admin-panel__select admin-panel__select--compact"
            value={categoryFilter}
            onChange={(event) => {
              setCategoryFilter(event.target.value);
              setSubcategoryFilter("all");
            }}
          >
            <option value="all">All categories</option>
            {filtersMeta.categoryOptions.map((category) => (
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
            <option value="all">All subcategories</option>
            {filtersMeta.subcategoryOptions.map((subcategory) => (
              <option key={subcategory} value={subcategory}>
                {subcategory}
              </option>
            ))}
          </select>

          <div className="admin-panel__tags-toolbar-meta">
            {summary.filteredTags.toLocaleString()} shown
          </div>

          {hasActiveFilters && (
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
              onClick={() => {
                setSearch("");
                setCategoryFilter("all");
                setSubcategoryFilter("all");
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {loading ? (
          <div className="admin-panel__state-box">
            <div className="admin-panel__spinner" />
            <span className="admin-panel__muted">Loading tags...</span>
          </div>
        ) : summary.filteredTags === 0 ? (
          <div className="admin-panel__state-box">
            <TagIcon />
            <span className="admin-panel__muted">{emptyStateMessage}</span>
          </div>
        ) : (
          <div className="admin-panel__card">
            <div className="admin-panel__tags-list-toolbar">
              <div className="admin-panel__tags-list-copy">
                <span className="admin-panel__tags-list-title">
                  {pagination.total.toLocaleString()} matching tag
                  {pagination.total === 1 ? "" : "s"}
                </span>
                <div className="admin-panel__tags-list-meta">
                  <span className="admin-panel__muted">{resultsSummary}</span>
                </div>
              </div>

              <div className="admin-panel__manuals-toolbar-actions">
                {(showPageSizeControl || hasMultiplePages) && (
                  <div className="admin-panel__manuals-pager">
                    {showPageSizeControl && (
                      <label className="admin-panel__manuals-page-size">
                        <span className="admin-panel__manuals-page-size-label">
                          Rows
                        </span>
                        <select
                          className="admin-panel__select admin-panel__select--compact"
                          value={pageSize}
                          onChange={(event) => {
                            const nextPageSize = Number.parseInt(
                              event.target.value,
                              10,
                            );
                            setPageSize(nextPageSize);
                          }}
                        >
                          {TAG_PAGE_SIZE_OPTIONS.map((size) => (
                            <option key={size} value={size}>
                              {size} / page
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    {hasMultiplePages && (
                      <>
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                          onClick={() =>
                            void loadTagsPage(page - 1, pageSize, currentQuery)
                          }
                          disabled={!pagination.hasPreviousPage}
                        >
                          Prev
                        </button>
                        <span className="admin-panel__manuals-page-indicator">
                          Page {page} / {pagination.totalPages}
                        </span>
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                          onClick={() =>
                            void loadTagsPage(page + 1, pageSize, currentQuery)
                          }
                          disabled={!pagination.hasNextPage}
                        >
                          Next
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {selectedTagCount > 0 && (
              <div className="admin-panel__tags-bulk-bar">
                <div className="admin-panel__tags-bulk-copy">
                  <span className="admin-panel__manuals-selection-summary">
                    {selectionSummary}
                  </span>
                  <span className="admin-panel__muted">
                    {allTagsSelected && excludedTagIds.length === 0
                      ? "The delete action will apply to every tag that matches the current filters."
                      : "Only the checked tags will be removed."}
                  </span>
                </div>

                <div className="admin-panel__tags-bulk-actions">
                  <button
                    type="button"
                    className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                    onClick={clearSelection}
                    disabled={bulkDeleting}
                  >
                    Clear selection
                  </button>
                  <button
                    type="button"
                    className="admin-panel__btn admin-panel__btn--danger admin-panel__btn--compact"
                    onClick={() => setConfirmBulkDelete(true)}
                    disabled={bulkDeleting || deletingId !== null}
                  >
                    {bulkDeleting
                      ? "Deleting..."
                      : allTagsSelected && excludedTagIds.length === 0
                        ? "Delete all filtered"
                        : "Delete selected"}
                  </button>
                </div>
              </div>
            )}

            <div className="admin-panel__table-wrap">
              <table className="admin-panel__table admin-panel__table--tags">
                <colgroup>
                  <col className="admin-panel__tags-col admin-panel__tags-col--select" />
                  <col className="admin-panel__tags-col admin-panel__tags-col--tag" />
                  <col className="admin-panel__tags-col admin-panel__tags-col--description" />
                  <col className="admin-panel__tags-col admin-panel__tags-col--links" />
                  <col className="admin-panel__tags-col admin-panel__tags-col--updated" />
                  <col className="admin-panel__tags-col admin-panel__tags-col--actions" />
                </colgroup>
                <thead>
                  <tr>
                    <th className="admin-panel__th admin-panel__th--select">
                      <SelectionCheckbox
                        checked={headerCheckboxChecked}
                        indeterminate={headerCheckboxIndeterminate}
                        disabled={pagination.total === 0 || bulkDeleting}
                        ariaLabel="Select all matching tags"
                        onChange={toggleAllTagsSelection}
                      />
                    </th>
                    <th className="admin-panel__th">Tag</th>
                    <th className="admin-panel__th">Description</th>
                    <th className="admin-panel__th">Links</th>
                    <th className="admin-panel__th">Updated</th>
                    <th className="admin-panel__th admin-panel__th--actions">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tags.map((tag) => (
                    <tr key={tag.id} className="admin-panel__row">
                      <td className="admin-panel__td admin-panel__td--select">
                        <SelectionCheckbox
                          checked={isTagSelected(tag.id)}
                          disabled={bulkDeleting}
                          ariaLabel={`Select ${tag.key}`}
                          onChange={(checked) =>
                            toggleTagSelection(tag.id, checked)
                          }
                        />
                      </td>
                      <td className="admin-panel__td admin-panel__td--tag">
                        <div className="admin-panel__tag-cell">
                          <code className="admin-panel__code-inline admin-panel__tag-key">
                            {tag.key}
                          </code>
                          <div className="admin-panel__tag-meta">
                            <span className="admin-panel__tag-chip">
                              {tag.category}
                            </span>
                            <span className="admin-panel__tag-chip">
                              {tag.subcategory}
                            </span>
                            <span className="admin-panel__tag-chip">
                              {tag.item}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="admin-panel__td admin-panel__td--desc">
                        {tag.description?.trim() ? (
                          <span className="admin-panel__tag-description">
                            {tag.description}
                          </span>
                        ) : (
                          <span className="admin-panel__muted">
                            No description
                          </span>
                        )}
                      </td>
                      <td className="admin-panel__td">
                        <div className="admin-panel__tag-links">
                          <span className="admin-panel__tag-link-pill">
                            Metrics {tag.metricLinksCount}
                          </span>
                          <span className="admin-panel__tag-link-pill">
                            Manuals {tag.manualLinksCount}
                          </span>
                        </div>
                      </td>
                      <td className="admin-panel__td admin-panel__td--tag-date">
                        {formatUpdatedAt(tag.updatedAt)}
                      </td>
                      <td className="admin-panel__td admin-panel__td--tag-actions">
                        <div className="admin-panel__actions admin-panel__actions--tags">
                          <button
                            type="button"
                            className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                            onClick={() => openEditModal(tag)}
                            disabled={bulkDeleting}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="admin-panel__btn admin-panel__btn--danger admin-panel__btn--compact"
                            onClick={() => setDeleteTarget(tag)}
                            disabled={deletingId === tag.id || bulkDeleting}
                          >
                            {deletingId === tag.id ? "..." : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {showFormModal &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-tag-form-title"
            onClick={(event) => {
              if (event.target === event.currentTarget) closeFormModal();
            }}
          >
            <div className="admin-panel__modal admin-panel__modal--wide">
              <button
                type="button"
                className="admin-panel__modal-close"
                onClick={closeFormModal}
                aria-label="Close"
              >
                <XIcon />
              </button>

              <div className="admin-panel__modal-head">
                <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
                  <TagIcon />
                </div>
                <h2 id="ap-tag-form-title" className="admin-panel__modal-title">
                  {editingTag ? "Edit tag" : "Create new tag"}
                </h2>
                <p className="admin-panel__modal-desc">
                  Define the taxonomy segments below. The canonical key is
                  generated automatically and stored in the database.
                </p>
              </div>

              <form
                className="admin-panel__modal-form admin-panel__modal-form--fill"
                onSubmit={handleSave}
              >
                <div className="admin-panel__modal-body">
                  <div className="admin-panel__modal-field-row">
                    <div className="admin-panel__modal-field">
                      <label className="admin-panel__field-label">
                        Category
                      </label>
                      <input
                        type="text"
                        className="admin-panel__input admin-panel__input--full"
                        value={tagForm.category}
                        onChange={(event) =>
                          setTagForm((current) => ({
                            ...current,
                            category: event.target.value,
                          }))
                        }
                        placeholder="e.g. equipment"
                        autoFocus
                        disabled={saving}
                        required
                      />
                    </div>
                    <div className="admin-panel__modal-field">
                      <label className="admin-panel__field-label">
                        Subcategory
                      </label>
                      <input
                        type="text"
                        className="admin-panel__input admin-panel__input--full"
                        value={tagForm.subcategory}
                        onChange={(event) =>
                          setTagForm((current) => ({
                            ...current,
                            subcategory: event.target.value,
                          }))
                        }
                        placeholder="e.g. propulsion"
                        disabled={saving}
                        required
                      />
                    </div>
                  </div>

                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">Item</label>
                    <input
                      type="text"
                      className="admin-panel__input admin-panel__input--full"
                      value={tagForm.item}
                      onChange={(event) =>
                        setTagForm((current) => ({
                          ...current,
                          item: event.target.value,
                        }))
                      }
                      placeholder="e.g. main_engine_ps"
                      disabled={saving}
                      required
                    />
                  </div>

                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">
                      Description
                    </label>
                    <textarea
                      className="admin-panel__input admin-panel__textarea admin-panel__tags-description"
                      value={tagForm.description}
                      onChange={(event) =>
                        setTagForm((current) => ({
                          ...current,
                          description: event.target.value,
                        }))
                      }
                      placeholder="Optional context for operators and future routing."
                      rows={5}
                      disabled={saving}
                    />
                  </div>

                  <div className="admin-panel__tags-preview">
                    <span className="admin-panel__field-label">
                      Canonical key
                    </span>
                    {previewKey ? (
                      <code className="admin-panel__code-inline">
                        {previewKey}
                      </code>
                    ) : (
                      <span className="admin-panel__muted">
                        Fill category, subcategory and item to generate the key.
                      </span>
                    )}
                    <p className="admin-panel__tags-preview-note">
                      Existing records with the same canonical key are treated
                      as the same taxonomy tag during JSON import.
                    </p>
                  </div>
                </div>

                <div className="admin-panel__modal-footer">
                  <div className="admin-panel__inline-meta">
                    Tags stay global and admin-only. Future metric and manual
                    assignments will reuse this taxonomy.
                  </div>
                  <div className="admin-panel__modal-actions">
                    <button
                      type="button"
                      className="admin-panel__btn admin-panel__btn--ghost"
                      onClick={closeFormModal}
                      disabled={saving}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="admin-panel__btn admin-panel__btn--primary"
                      disabled={saving || !previewKey}
                    >
                      {saving
                        ? "Saving..."
                        : editingTag
                          ? "Save changes"
                          : "Create tag"}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}

      {deleteTarget &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-delete-tag-title"
          >
            <div className="admin-panel__modal">
              <div className="admin-panel__modal-icon admin-panel__modal-icon--danger">
                <XIcon />
              </div>
              <h2 id="ap-delete-tag-title" className="admin-panel__modal-title">
                Delete this tag?
              </h2>
              <p className="admin-panel__modal-desc">
                <code className="admin-panel__code">{deleteTarget.key}</code>{" "}
                will be permanently removed. Linked assignments will also be
                removed from metrics ({deleteTarget.metricLinksCount}) and
                manuals ({deleteTarget.manualLinksCount}).
              </p>
              <div className="admin-panel__modal-actions">
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--ghost"
                  onClick={() => setDeleteTarget(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--danger"
                  onClick={handleDeleteConfirm}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {confirmBulkDelete &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-delete-tags-bulk-title"
          >
            <div className="admin-panel__modal">
              <div className="admin-panel__modal-icon admin-panel__modal-icon--danger">
                <XIcon />
              </div>
              <h2
                id="ap-delete-tags-bulk-title"
                className="admin-panel__modal-title"
              >
                {allTagsSelected && excludedTagIds.length === 0
                  ? "Delete all filtered tags?"
                  : "Delete selected tags?"}
              </h2>
              <p className="admin-panel__modal-desc">
                This will permanently remove {selectedTagCount} tag
                {selectedTagCount === 1 ? "" : "s"} and their current metric or
                manual assignments. This action cannot be undone.
              </p>
              <div className="admin-panel__modal-actions">
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--ghost"
                  onClick={() => setConfirmBulkDelete(false)}
                  disabled={bulkDeleting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--danger"
                  onClick={async () => {
                    setConfirmBulkDelete(false);
                    await handleBulkDelete();
                  }}
                  disabled={bulkDeleting}
                >
                  {bulkDeleting
                    ? "Deleting..."
                    : allTagsSelected && excludedTagIds.length === 0
                      ? "Delete all filtered"
                      : "Delete selected"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {showImportModal &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-import-tags-title"
            onClick={(event) => {
              if (event.target === event.currentTarget) closeImportModal();
            }}
          >
            <div className="admin-panel__modal admin-panel__modal--wide">
              <button
                type="button"
                className="admin-panel__modal-close"
                onClick={closeImportModal}
                aria-label="Close"
              >
                <XIcon />
              </button>

              <div className="admin-panel__modal-head">
                <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
                  <UploadIcon />
                </div>
                <h2
                  id="ap-import-tags-title"
                  className="admin-panel__modal-title"
                >
                  Import tags from JSON
                </h2>
                <p className="admin-panel__modal-desc">
                  Upload a taxonomy file with a top-level{" "}
                  <code className="admin-panel__code-inline">tags</code> array.
                  Existing tags with the same canonical key are updated, so
                  re-importing the same file does not create duplicates.
                </p>
              </div>

              <form
                className="admin-panel__modal-form admin-panel__modal-form--fill"
                onSubmit={handleImport}
              >
                <div className="admin-panel__modal-body">
                  <div className="admin-panel__tags-import-box">
                    <input
                      ref={importInputRef}
                      type="file"
                      accept=".json,application/json"
                      className="admin-panel__file-input"
                      onChange={(event) =>
                        setImportFile(event.target.files?.[0] ?? null)
                      }
                    />
                    <button
                      type="button"
                      className="admin-panel__file-trigger"
                      onClick={() => importInputRef.current?.click()}
                      disabled={importing}
                    >
                      Choose JSON file
                    </button>

                    <div className="admin-panel__tags-import-meta">
                      <span className="admin-panel__tags-import-name">
                        {importFile ? importFile.name : "No file selected"}
                      </span>
                      <span className="admin-panel__tags-import-note">
                        Canonical key format: category:subcategory:item
                      </span>
                    </div>
                  </div>
                </div>

                <div className="admin-panel__modal-footer">
                  <div className="admin-panel__inline-meta">
                    Import is idempotent by canonical key and does not remove
                    unrelated existing tags.
                  </div>
                  <div className="admin-panel__modal-actions">
                    <button
                      type="button"
                      className="admin-panel__btn admin-panel__btn--ghost"
                      onClick={closeImportModal}
                      disabled={importing}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="admin-panel__btn admin-panel__btn--primary"
                      disabled={importing || !importFile}
                    >
                      {importing ? "Importing..." : "Import tags"}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}

      {importResult &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-import-result-title"
          >
            <div className="admin-panel__modal admin-panel__modal--wide">
              <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
                <TagIcon />
              </div>
              <h2
                id="ap-import-result-title"
                className="admin-panel__modal-title"
              >
                Import complete
              </h2>
              <p className="admin-panel__modal-desc">
                The taxonomy was processed successfully and the current list has
                been refreshed.
              </p>

              <div className="admin-panel__tags-import-result">
                <div className="admin-panel__tag-link-pill">
                  Source entries {importResult.sourceEntries}
                </div>
                <div className="admin-panel__tag-link-pill">
                  Unique tags {importResult.uniqueTags}
                </div>
                <div className="admin-panel__tag-link-pill">
                  Created {importResult.created}
                </div>
                <div className="admin-panel__tag-link-pill">
                  Updated {importResult.updated}
                </div>
              </div>

              {importResult.warningCount > 0 && (
                <div className="admin-panel__tags-warning-box">
                  <span className="admin-panel__field-label">Import notes</span>
                  <ul className="admin-panel__tags-warning-list">
                    {visibleWarnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                  {importResult.warningCount > visibleWarnings.length && (
                    <p className="admin-panel__tags-preview-note">
                      Showing the first 8 warnings out of{" "}
                      {importResult.warningCount}.
                    </p>
                  )}
                </div>
              )}

              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--primary admin-panel__btn--full"
                onClick={() => setImportResult(null)}
              >
                Done
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
