import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  MetricAggregationRule,
  MetricConcept,
  MetricConceptBootstrapResult,
  MetricConceptExecutionResponse,
  MetricConceptMember,
  MetricConceptType,
  MetricConceptResolutionResult,
  SaveMetricConceptInput,
  ShipMetricsCatalog,
} from "../../api/metricsApi";
import { SearchIcon } from "./AdminPanelIcons";
import { useMetricConceptsAdminData } from "../../hooks/admin/useMetricConceptsAdminData";

interface MetricsSemanticConceptsPanelProps {
  token: string | null;
  shipId: string | null;
  catalog: ShipMetricsCatalog | null;
  syncMarker: string | null;
}

type EditableConceptMember = {
  localId: string;
  metricCatalogId: string;
  role: string;
  sortOrder: number;
  label: string;
  subtitle: string;
};

interface ConceptDraft {
  id: string | null;
  displayName: string;
  description: string;
  category: string;
  type: MetricConceptType;
  aggregationRule: MetricAggregationRule;
  unit: string;
  isActive: boolean;
  members: EditableConceptMember[];
}

type ReadinessState = {
  label: string;
  tone: "ready" | "warning" | "inactive";
  hint: string;
};

const CONCEPT_TYPE_OPTIONS: Array<{
  value: MetricConceptType;
  label: string;
}> = [
  { value: "single", label: "Single" },
  { value: "group", label: "Group" },
  { value: "composite", label: "Composite" },
  { value: "paired", label: "Paired" },
  { value: "comparison", label: "Comparison" },
  { value: "trajectory", label: "Trajectory" },
];

const AGGREGATION_RULE_OPTIONS: Array<{
  value: MetricAggregationRule;
  label: string;
}> = [
  { value: "none", label: "None" },
  { value: "last", label: "Last" },
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Minimum" },
  { value: "max", label: "Maximum" },
  { value: "coordinate_pair", label: "Coordinate pair" },
  { value: "compare", label: "Compare" },
  { value: "trajectory", label: "Trajectory" },
];

const SAMPLE_RESOLUTION_QUERIES = [
  "speed of the boat",
  "speed over ground",
  "depth below keel",
];

const CONCEPT_TEMPLATES: Array<{
  id: string;
  label: string;
  description: string;
  displayName: string;
  category: string;
  type: MetricConceptType;
  aggregationRule: MetricAggregationRule;
  unit: string;
}> = [
  {
    id: "single",
    label: "Single metric",
    description: "One raw metric with a friendly AI-facing name.",
    displayName: "New Single Metric",
    category: "general",
    type: "single",
    aggregationRule: "last",
    unit: "",
  },
  {
    id: "group",
    label: "Metric group",
    description: "A set of related metrics such as all tanks or all engines.",
    displayName: "New Metric Group",
    category: "general",
    type: "group",
    aggregationRule: "none",
    unit: "",
  },
  {
    id: "composite",
    label: "Composite total",
    description: "A calculated total or average built from several members.",
    displayName: "New Composite Total",
    category: "general",
    type: "composite",
    aggregationRule: "sum",
    unit: "",
  },
  {
    id: "paired",
    label: "Lat / Lon pair",
    description: "A paired concept like vessel location from latitude and longitude.",
    displayName: "Vessel Location",
    category: "navigation",
    type: "paired",
    aggregationRule: "coordinate_pair",
    unit: "coordinate pair",
  },
];

function createEmptyDraft(): ConceptDraft {
  return {
    id: null,
    displayName: "",
    description: "",
    category: "",
    type: "single",
    aggregationRule: "last",
    unit: "",
    isActive: true,
    members: [],
  };
}

function formatMemberSubtitle(member: MetricConceptMember): string {
  return member.metric.key;
}

function conceptToDraft(concept: MetricConcept): ConceptDraft {
  return {
    id: concept.id,
    displayName: concept.displayName,
    description: concept.description ?? "",
    category: concept.category ?? "",
    type: concept.type,
    aggregationRule: concept.aggregationRule,
    unit: concept.unit ?? "",
    isActive: concept.isActive,
    members: concept.members.map((member, index) => ({
      localId: member.id,
      metricCatalogId: member.metricCatalogId,
      role: member.role ?? "",
      sortOrder: member.sortOrder ?? index,
      label: humanizeMetricLabel(member.metric.key),
      subtitle: formatMemberSubtitle(member),
    })),
  };
}

function humanizeMetricLabel(key: string): string {
  const parts = key.split("::");
  const measurement = parts[1] ?? parts[0] ?? key;
  return measurement
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatConceptType(value: MetricConceptType): string {
  return CONCEPT_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

function formatAggregationRule(value: MetricAggregationRule): string {
  return AGGREGATION_RULE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

function formatExecutionValue(result: MetricConceptExecutionResponse | null): string {
  if (!result) return "-";
  const { value, unit } = result.result;
  if (typeof value === "number" || typeof value === "string")
    return `${value}${unit ? ` ${unit}` : ""}`;
  if (value && typeof value === "object") return JSON.stringify(value);
  if (value === null || value === undefined) return "No data";
  return String(value);
}

function getReadinessBadgeClass(tone: ReadinessState["tone"]): string {
  if (tone === "ready") return "admin-panel__badge admin-panel__badge--manual-done";
  if (tone === "inactive") return "admin-panel__badge admin-panel__badge--manual-cancel";
  return "admin-panel__badge admin-panel__badge--manual-pending";
}

function evaluateReadiness(input: {
  isActive: boolean;
  type: MetricConceptType;
  memberCount: number;
  memberRoles: string[];
}): ReadinessState {
  if (!input.isActive)
    return { label: "Inactive", tone: "inactive", hint: "Enable this concept before the chat planner can use it." };
  if (input.memberCount === 0)
    return { label: "Needs members", tone: "warning", hint: "Attach raw metrics so this concept can execute." };
  if (input.type === "paired" && input.memberCount < 2)
    return { label: "Needs pair", tone: "warning", hint: "A paired concept should contain two members." };
  if (
    input.type === "paired" &&
    !input.memberRoles.includes("latitude") &&
    !input.memberRoles.includes("longitude")
  )
    return { label: "Needs roles", tone: "warning", hint: "Add latitude and longitude roles for paired concepts." };
  return { label: "Ready", tone: "ready", hint: "This concept is ready for semantic testing." };
}

function getConceptReadiness(concept: MetricConcept): ReadinessState {
  return evaluateReadiness({
    isActive: concept.isActive,
    type: concept.type,
    memberCount: concept.members.length,
    memberRoles: concept.members
      .map((m) => m.role?.trim().toLowerCase())
      .filter((r): r is string => Boolean(r)),
  });
}

/* ─────────────────────────────────────────────────────────
   Member Modal Component
───────────────────────────────────────────────────────── */
interface MemberModalProps {
  allMetrics: Array<{ id: string; label: string; key: string; bucket: string; description: string | null }>;
  selectedIds: Set<string>;
  onAdd: (metricId: string) => void;
  onClose: () => void;
}

function MemberModal({ allMetrics, selectedIds, onAdd, onClose }: MemberModalProps) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allMetrics;
    return allMetrics.filter((m) => {
      const hay = [m.label, m.key, m.bucket, m.description ?? ""]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [allMetrics, search]);

  const available = filtered.filter((m) => !selectedIds.has(m.id));
  const added = filtered.filter((m) => selectedIds.has(m.id));

  return (
    <div className="admin-panel__modal-overlay" onClick={onClose}>
      <div
        className="admin-panel__member-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Add metric members"
      >
        {/* Header */}
        <div className="admin-panel__member-modal-head">
          <div>
            <strong className="admin-panel__member-modal-title">Add metric members</strong>
            <span className="admin-panel__muted admin-panel__member-modal-sub">
              {available.length} available · {selectedIds.size} in concept
            </span>
          </div>
          <button
            type="button"
            className="admin-panel__metrics-edit-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <label className="admin-panel__member-modal-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            className="admin-panel__member-modal-search-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, key, or bucket…"
          />
          {search && (
            <button
              type="button"
              className="admin-panel__member-modal-search-clear"
              onClick={() => setSearch("")}
              aria-label="Clear search"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </label>

        {/* Available list */}
        <div className="admin-panel__member-modal-body">
          {available.length === 0 && added.length === 0 ? (
            <div className="admin-panel__member-modal-empty">
              No metrics match "{search}"
            </div>
          ) : (
            <>
              {available.length > 0 && (
                <div className="admin-panel__member-modal-section">
                  <span className="admin-panel__member-modal-section-label">Available ({available.length})</span>
                  {available.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className="admin-panel__member-modal-row"
                      onClick={() => onAdd(m.id)}
                    >
                      <div className="admin-panel__member-modal-row-main">
                        <span className="admin-panel__member-modal-row-name">{m.label}</span>
                        <code className="admin-panel__member-modal-row-key">{m.key}</code>
                      </div>
                      <div className="admin-panel__member-modal-row-right">
                        <span className="admin-panel__metrics-bucket-badge">{m.bucket}</span>
                        <svg className="admin-panel__member-modal-add-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10" /><path d="M12 8v8M8 12h8" />
                        </svg>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {added.length > 0 && (
                <div className="admin-panel__member-modal-section">
                  <span className="admin-panel__member-modal-section-label">Already in concept ({added.length})</span>
                  {added.map((m) => (
                    <div key={m.id} className="admin-panel__member-modal-row admin-panel__member-modal-row--added">
                      <div className="admin-panel__member-modal-row-main">
                        <span className="admin-panel__member-modal-row-name">{m.label}</span>
                        <code className="admin-panel__member-modal-row-key">{m.key}</code>
                      </div>
                      <div className="admin-panel__member-modal-row-right">
                        <span className="admin-panel__metrics-bucket-badge">{m.bucket}</span>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-success, #4caf50)", opacity: 0.7 }}>
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="admin-panel__member-modal-footer">
          <button type="button" className="admin-panel__btn admin-panel__btn--ghost" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
   Main Panel
───────────────────────────────────────────────────────── */
export function MetricsSemanticConceptsPanel({
  token,
  shipId,
  catalog,
  syncMarker,
}: MetricsSemanticConceptsPanelProps) {
  const [conceptSearch, setConceptSearch] = useState("");
  const deferredConceptSearch = useDeferredValue(conceptSearch.trim());
  const {
    concepts,
    totalConcepts,
    loading,
    loadingMore,
    saving,
    bootstrapping,
    hasMore,
    error,
    setError,
    refreshConcepts,
    loadMoreConcepts,
    bootstrapConcepts,
    saveConcept,
    resolveQuery,
    executeConcept,
  } = useMetricConceptsAdminData(
    token,
    shipId,
    deferredConceptSearch,
    Boolean(token && shipId),
  );
  const [resolutionQuery, setResolutionQuery] = useState("");
  const [resolutionResult, setResolutionResult] = useState<MetricConceptResolutionResult | null>(null);
  const [executionResult, setExecutionResult] = useState<MetricConceptExecutionResponse | null>(null);
  const [resolutionAttempted, setResolutionAttempted] = useState(false);
  const [executionAttempted, setExecutionAttempted] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [resolutionError, setResolutionError] = useState("");
  const [executionError, setExecutionError] = useState("");
  const [bootstrapResult, setBootstrapResult] = useState<MetricConceptBootstrapResult | null>(null);
  const [draft, setDraft] = useState<ConceptDraft>(() => createEmptyDraft());
  const [showMemberModal, setShowMemberModal] = useState(false);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const templateMenuRef = useRef<HTMLDivElement>(null);
  const conceptListRef = useRef<HTMLDivElement>(null);
  const conceptListSentinelRef = useRef<HTMLDivElement>(null);

  /* close template menu on outside click */
  useEffect(() => {
    if (!showTemplateMenu) return;
    const handler = (e: MouseEvent) => {
      if (templateMenuRef.current && !templateMenuRef.current.contains(e.target as Node)) {
        setShowTemplateMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showTemplateMenu]);

  useEffect(() => {
    setDraft(createEmptyDraft());
    setResolutionQuery("");
    setResolutionResult(null);
    setExecutionResult(null);
    setResolutionAttempted(false);
    setExecutionAttempted(false);
    setResolving(false);
    setExecuting(false);
    setResolutionError("");
    setExecutionError("");
    setBootstrapResult(null);
    setSaveSuccess(false);
  }, [shipId]);

  useEffect(() => {
    conceptListRef.current?.scrollTo({ top: 0 });
  }, [deferredConceptSearch, shipId]);

  useEffect(() => {
    if (syncMarker) void refreshConcepts();
  }, [refreshConcepts, syncMarker]);

  useEffect(() => {
    const root = conceptListRef.current;
    const target = conceptListSentinelRef.current;

    if (!root || !target || !hasMore) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMoreConcepts();
        }
      },
      {
        root,
        rootMargin: "180px 0px",
        threshold: 0.01,
      },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [concepts.length, hasMore, loadMoreConcepts]);

  /* ── derived data ── */
  const flatMetrics = useMemo(() => {
    if (!catalog) return [];
    return catalog.buckets.flatMap((g) =>
      g.metrics.map((m) => ({
        ...m,
        bucket: g.bucket,
        label: humanizeMetricLabel(m.key),
      })),
    );
  }, [catalog]);

  const selectedMetricIds = useMemo(
    () => new Set(draft.members.map((m) => m.metricCatalogId).filter(Boolean)),
    [draft.members],
  );

  const draftReadiness = useMemo(
    () =>
      evaluateReadiness({
        isActive: draft.isActive,
        type: draft.type,
        memberCount: draft.members.length,
        memberRoles: draft.members.map((m) => m.role.trim().toLowerCase()).filter(Boolean),
      }),
    [draft.isActive, draft.type, draft.members],
  );

  const conceptHealthSummary = useMemo(
    () =>
      concepts.reduce(
        (acc, c) => {
          const r = getConceptReadiness(c);
          if (r.tone === "ready") acc.ready++;
          else if (r.tone === "inactive") acc.inactive++;
          else acc.needsAttention++;
          return acc;
        },
        { ready: 0, needsAttention: 0, inactive: 0 },
      ),
    [concepts],
  );
  const loadedConceptStatusText =
    totalConcepts > concepts.length
      ? `Loaded ${concepts.length} of ${totalConcepts}`
      : `${totalConcepts} loaded`;

  /* ── handlers ── */
  const resetEditor = useCallback(() => {
    setDraft(createEmptyDraft());
    setExecutionResult(null);
    setResolutionResult(null);
    setResolutionAttempted(false);
    setExecutionAttempted(false);
    setResolutionError("");
    setExecutionError("");
    setError("");
    setSaveSuccess(false);
  }, [setError]);

  const applyTemplate = (templateId: string) => {
    const tpl = CONCEPT_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return;
    setDraft({
      id: null,
      displayName: tpl.displayName,
      description: tpl.description,
      category: tpl.category,
      type: tpl.type,
      aggregationRule: tpl.aggregationRule,
      unit: tpl.unit,
      isActive: true,
      members: [],
    });
    setExecutionResult(null);
    setResolutionResult(null);
    setResolutionAttempted(false);
    setExecutionAttempted(false);
    setResolutionError("");
    setExecutionError("");
    setError("");
    setSaveSuccess(false);
    setShowTemplateMenu(false);
  };

  const handleSelectConcept = (concept: MetricConcept) => {
    setDraft(conceptToDraft(concept));
    setExecutionResult(null);
    setResolutionResult(null);
    setResolutionAttempted(false);
    setExecutionAttempted(false);
    setResolutionError("");
    setExecutionError("");
    setError("");
    setSaveSuccess(false);
  };

  const handleDraftChange = (field: keyof Omit<ConceptDraft, "members">, value: string | boolean) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  };

  const addMetricMember = (metricId: string) => {
    const metric = flatMetrics.find((m) => m.id === metricId);
    if (!metric) return;
    setDraft((prev) => ({
      ...prev,
      members: [
        ...prev.members,
        {
          localId: `metric-${metricId}-${Date.now()}`,
          metricCatalogId: metric.id,
          role: "",
          sortOrder: prev.members.length,
          label: metric.label,
          subtitle: metric.key,
        },
      ],
    }));
  };

  const removeMember = (localId: string) => {
    setDraft((prev) => ({
      ...prev,
      members: prev.members
        .filter((m) => m.localId !== localId)
        .map((m, i) => ({ ...m, sortOrder: i })),
    }));
  };

  const updateMemberRole = (localId: string, role: string) => {
    setDraft((prev) => ({
      ...prev,
      members: prev.members.map((m) => (m.localId === localId ? { ...m, role } : m)),
    }));
  };

  const buildPayload = (): SaveMetricConceptInput => ({
    displayName: draft.displayName.trim(),
    description: draft.description.trim() || null,
    category: draft.category.trim() || null,
    type: draft.type,
    aggregationRule: draft.aggregationRule,
    unit: draft.unit.trim() || null,
    isActive: draft.isActive,
    members: draft.members.map((m, i) => ({
      metricCatalogId: m.metricCatalogId,
      role: m.role.trim() || undefined,
      sortOrder: i,
    })),
  });

  const handleSave = async () => {
    if (!draft.displayName.trim()) {
      setError("Display name is required.");
      return;
    }
    setSaveSuccess(false);
    const saved = await saveConcept(draft.id, buildPayload());
    if (saved) {
      setDraft(conceptToDraft(saved));
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    }
  };

  const handleResolve = async () => {
    if (!resolutionQuery.trim()) return;
    setError("");
    setResolutionAttempted(true);
    setExecutionAttempted(false);
    setResolutionError("");
    setExecutionError("");
    setExecutionResult(null);
    setResolving(true);
    try {
      setResolutionResult(await resolveQuery(resolutionQuery.trim()));
    } catch (e) {
      setResolutionResult(null);
      setResolutionError(e instanceof Error ? e.message : "Failed to resolve");
    } finally {
      setResolving(false);
    }
  };

  const handleExecuteResolved = async () => {
    const q = resolutionQuery.trim();
    if (!q) return;
    setError("");
    setExecutionAttempted(true);
    setExecutionError("");
    setExecuting(true);
    try {
      const r = await executeConcept({ query: q, timeMode: "snapshot" });
      if (r) setExecutionResult(r);
    } catch (e) {
      setExecutionResult(null);
      setExecutionError(e instanceof Error ? e.message : "Failed to execute");
    } finally {
      setExecuting(false);
    }
  };

  const handleExecuteDraft = async () => {
    if (!draft.id) { setError("Save the concept before executing it."); return; }
    setError("");
    setExecutionAttempted(true);
    setExecutionError("");
    setExecuting(true);
    try {
      const r = await executeConcept({ conceptId: draft.id, timeMode: "snapshot" });
      if (r) setExecutionResult(r);
    } catch (e) {
      setExecutionResult(null);
      setExecutionError(e instanceof Error ? e.message : "Failed to execute");
    } finally {
      setExecuting(false);
    }
  };

  const handleBootstrap = async () => {
    const r = await bootstrapConcepts();
    if (r) setBootstrapResult(r);
  };

  const resolveCandidates = resolutionResult?.candidates ?? [];

  /* ─────────────────────────────────────────────────────────
     RENDER
  ───────────────────────────────────────────────────────── */
  if (!shipId) {
    return (
      <div className="admin-panel__state-box">
        <span className="admin-panel__muted">
          Select a ship to manage its semantic concepts.
        </span>
      </div>
    );
  }

  return (
    <div className="admin-panel__semantic-layout">

      {/* ── Toolbar strip ── */}
      <div className="admin-panel__semantic-toolbar">
        <div className="admin-panel__semantic-toolbar-left">
          <div className="admin-panel__semantic-health-chips">
            <span className="admin-panel__semantic-stat admin-panel__semantic-stat--ready">
              <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="4" /></svg>
              {conceptHealthSummary.ready} ready
            </span>
            <span className="admin-panel__semantic-stat admin-panel__semantic-stat--warning">
              <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="4" /></svg>
              {conceptHealthSummary.needsAttention} need attention
            </span>
            {conceptHealthSummary.inactive > 0 && (
              <span className="admin-panel__semantic-stat">
                <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="4" /></svg>
                {conceptHealthSummary.inactive} inactive
              </span>
            )}
            <span className="admin-panel__semantic-stat">
              <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="4" /></svg>
              {loadedConceptStatusText}
            </span>
          </div>
          {bootstrapResult && (
            <span className="admin-panel__metrics-sync-status">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
              Bootstrap: +{bootstrapResult.conceptsCreated} created, {bootstrapResult.conceptsUpdated} updated
            </span>
          )}
        </div>
        <div className="admin-panel__semantic-toolbar-right">
          <button
            type="button"
            className="admin-panel__metrics-pager-btn admin-panel__semantic-refresh-btn"
            onClick={() => void refreshConcepts()}
            disabled={loading}
            title="Refresh concepts"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
          </button>
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
            onClick={() => void handleBootstrap()}
            disabled={bootstrapping}
          >
            {bootstrapping ? "Generating…" : "Generate base"}
          </button>
          {/* New concept with template dropdown */}
          <div className="admin-panel__semantic-new-wrap" ref={templateMenuRef}>
              <button
                type="button"
                className="admin-panel__semantic-new-btn"
                onClick={() => setShowTemplateMenu((v) => !v)}
                aria-expanded={showTemplateMenu}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                New concept
                <svg
                  width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  style={{ opacity: 0.7, transition: "transform 0.2s ease", transform: showTemplateMenu ? "rotate(180deg)" : "rotate(0deg)" }}
                  aria-hidden="true"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            {showTemplateMenu && (
              <div className="admin-panel__semantic-template-dropdown">
                <span className="admin-panel__semantic-template-dropdown-label">Choose a starting point</span>
                <button
                  type="button"
                  className="admin-panel__semantic-template-option admin-panel__semantic-template-option--blank"
                  onClick={() => { resetEditor(); setShowTemplateMenu(false); }}
                >
                  <strong>Blank concept</strong>
                  <span className="admin-panel__muted">Start from an empty form with no pre-filled values.</span>
                </button>
                <div className="admin-panel__semantic-template-divider" />
                {CONCEPT_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    className="admin-panel__semantic-template-option"
                    onClick={() => applyTemplate(tpl.id)}
                  >
                    <strong>{tpl.label}</strong>
                    <span className="admin-panel__muted">{tpl.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {error && <div className="admin-panel__error" role="alert">{error}</div>}

      {/* ── Main 2-panel grid ── */}
      <div className="admin-panel__semantic-main-grid">

        {/* LEFT — concept list */}
        <div className="admin-panel__semantic-panel admin-panel__semantic-panel--list">
          <div className="admin-panel__semantic-panel-head">
            <span className="admin-panel__form-card-title">
              {loading
                ? "Loading…"
                : totalConcepts > concepts.length
                  ? `${concepts.length} of ${totalConcepts} concepts`
                  : `${totalConcepts} concepts`}
            </span>
          </div>

          <label className="admin-panel__metrics-search admin-panel__semantic-search">
            <SearchIcon />
            <input
              className="admin-panel__metrics-search-input"
              value={conceptSearch}
              onChange={(e) => setConceptSearch(e.target.value)}
              placeholder="Search display name…"
            />
          </label>

          <div
            ref={conceptListRef}
            className="admin-panel__semantic-concept-list"
          >
            {!loading && concepts.length === 0 ? (
              <div className="admin-panel__state-box">
                <span className="admin-panel__muted">
                  {deferredConceptSearch
                    ? "No semantic concepts match this search."
                    : "No semantic concepts found."}
                </span>
              </div>
            ) : (
              concepts.map((concept) => {
                const readiness = getConceptReadiness(concept);
                const isActive = draft.id === concept.id;
                return (
                  <button
                    key={concept.id}
                    type="button"
                    className={`admin-panel__semantic-concept-item ${isActive ? "admin-panel__semantic-concept-item--active" : ""}`}
                    onClick={() => handleSelectConcept(concept)}
                  >
                    <div className="admin-panel__semantic-concept-item-top">
                      <strong>{concept.displayName}</strong>
                      <div className="admin-panel__semantic-concept-badges">
                        <span className="admin-panel__badge admin-panel__badge--user">
                          {formatConceptType(concept.type)}
                        </span>
                        <span className={getReadinessBadgeClass(readiness.tone)}>
                          {readiness.label}
                        </span>
                      </div>
                    </div>
                    <div className="admin-panel__semantic-concept-item-meta">
                      {concept.category && (
                        <>
                          <span>{concept.category}</span>
                          <span className="admin-panel__meta-divider">·</span>
                        </>
                      )}
                      <span>{formatAggregationRule(concept.aggregationRule)}</span>
                      <span className="admin-panel__meta-divider">·</span>
                      <span>{concept.members.length} members</span>
                    </div>
                  </button>
                );
              })
            )}
            {loadingMore && (
              <div className="admin-panel__semantic-list-status">
                <div className="admin-panel__spinner" />
                <span className="admin-panel__muted">Loading more concepts…</span>
              </div>
            )}
            {!loading && concepts.length > 0 && (
              <div
                ref={conceptListSentinelRef}
                className="admin-panel__semantic-list-sentinel"
                aria-hidden="true"
              />
            )}
            {!loading && concepts.length > 0 && (
              <div className="admin-panel__semantic-list-status">
                <span className="admin-panel__muted">
                  {hasMore
                    ? `Loaded ${concepts.length} of ${totalConcepts}. Scroll to load more.`
                    : `Showing all ${totalConcepts} concepts.`}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — editor + validation */}
        <div className="admin-panel__semantic-panel admin-panel__semantic-panel--editor">

          {/* Editor head */}
          <div className="admin-panel__semantic-panel-head">
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className="admin-panel__form-card-title">
                {draft.id ? "Edit concept" : "New concept"}
              </span>
              <span className={getReadinessBadgeClass(draftReadiness.tone)}>
                {draftReadiness.label}
              </span>
            </div>
            {draft.id && (
              <button
                type="button"
                className="admin-panel__metrics-edit-btn"
                onClick={resetEditor}
              >
                Clear
              </button>
            )}
          </div>

          {/* Save success toast */}
          {saveSuccess && (
            <div className="admin-panel__semantic-save-toast">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
              Concept saved successfully
            </div>
          )}

          {/* Hint */}
          <div className="admin-panel__semantic-hint-row">
            <span className="admin-panel__muted">{draftReadiness.hint}</span>
          </div>

          {/* Form */}
          <div className="admin-panel__semantic-editor-body">
            {/* Display name */}
            <div className="admin-panel__field">
              <label className="admin-panel__field-label">Display name</label>
              <input
                className="admin-panel__input"
                value={draft.displayName}
                onChange={(e) => handleDraftChange("displayName", e.target.value)}
                placeholder="Fuel Total"
              />
            </div>

            {/* Type / Aggregation / Unit */}
            <div className="admin-panel__form-row">
              <div className="admin-panel__field">
                <label className="admin-panel__field-label">Type</label>
                <select
                  className="admin-panel__select"
                  value={draft.type}
                  onChange={(e) => handleDraftChange("type", e.target.value as MetricConceptType)}
                >
                  {CONCEPT_TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div className="admin-panel__field">
                <label className="admin-panel__field-label">Aggregation</label>
                <select
                  className="admin-panel__select"
                  value={draft.aggregationRule}
                  onChange={(e) => handleDraftChange("aggregationRule", e.target.value as MetricAggregationRule)}
                >
                  {AGGREGATION_RULE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div className="admin-panel__field">
                <label className="admin-panel__field-label">Unit</label>
                <input
                  className="admin-panel__input"
                  value={draft.unit}
                  onChange={(e) => handleDraftChange("unit", e.target.value)}
                  placeholder="knots / liters"
                />
              </div>
            </div>

            {/* Category / Active */}
            <div className="admin-panel__form-row">
              <div className="admin-panel__field">
                <label className="admin-panel__field-label">Category</label>
                <input
                  className="admin-panel__input"
                  value={draft.category}
                  onChange={(e) => handleDraftChange("category", e.target.value)}
                  placeholder="navigation / fuel / engine"
                />
              </div>
              <div className="admin-panel__field">
                <label className="admin-panel__field-label">Status</label>
                <label className="admin-panel__semantic-checkbox">
                  <input
                    type="checkbox"
                    checked={draft.isActive}
                    onChange={(e) => handleDraftChange("isActive", e.target.checked)}
                  />
                  <span>Concept is active</span>
                </label>
              </div>
            </div>

            {/* Description */}
            <div className="admin-panel__field">
              <label className="admin-panel__field-label">Description</label>
              <textarea
                className="admin-panel__input admin-panel__textarea"
                rows={2}
                value={draft.description}
                onChange={(e) => handleDraftChange("description", e.target.value)}
                placeholder="Short explanation of what this concept means."
              />
            </div>

            {/* Members */}
            <div className="admin-panel__field">
              <div className="admin-panel__semantic-members-head">
                <label className="admin-panel__field-label" style={{ marginBottom: 0 }}>
                  Metric members
                  {draft.members.length > 0 && (
                    <span className="admin-panel__semantic-member-count">{draft.members.length}</span>
                  )}
                </label>
                <button
                  type="button"
                  className="admin-panel__semantic-add-member-btn"
                  onClick={() => setShowMemberModal(true)}
                  title="Add metric members"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 8v8M8 12h8" />
                  </svg>
                  Add members
                </button>
              </div>

              {draft.members.length === 0 ? (
                <div className="admin-panel__semantic-members-empty">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.3">
                    <circle cx="12" cy="12" r="10" /><path d="M12 8v8M8 12h8" />
                  </svg>
                  <span>No metric members yet.</span>
                  <button
                    type="button"
                    className="admin-panel__semantic-add-member-btn admin-panel__semantic-add-member-btn--inline"
                    onClick={() => setShowMemberModal(true)}
                  >
                    + Add metrics
                  </button>
                </div>
              ) : (
                <div className="admin-panel__semantic-member-list">
                  {draft.members.map((member) => (
                    <div key={member.localId} className="admin-panel__semantic-member-item">
                      <div className="admin-panel__semantic-member-main">
                        <div className="admin-panel__semantic-member-copy">
                          <strong>{member.label}</strong>
                          <span className="admin-panel__muted">{member.subtitle}</span>
                        </div>
                      </div>
                      <div className="admin-panel__semantic-member-controls">
                        <input
                          className="admin-panel__input admin-panel__input--compact"
                          value={member.role}
                          onChange={(e) => updateMemberRole(member.localId, e.target.value)}
                          placeholder="role (latitude, primary…)"
                        />
                        <button
                          type="button"
                          className="admin-panel__semantic-member-remove"
                          onClick={() => removeMember(member.localId)}
                          title="Remove"
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Save / Execute actions */}
            <div className="admin-panel__semantic-actions">
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--primary"
                onClick={() => void handleSave()}
                disabled={saving || !shipId}
              >
                <span className="admin-panel__btn-content">
                  {saving && <span className="admin-panel__spinner admin-panel__spinner--inline" aria-hidden="true" />}
                  <span>{saving ? "Saving…" : draft.id ? "Save concept" : "Create concept"}</span>
                </span>
              </button>
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--ghost"
                onClick={() => void handleExecuteDraft()}
                disabled={!draft.id || executing}
              >
                <span className="admin-panel__btn-content">
                  {executing && <span className="admin-panel__spinner admin-panel__spinner--inline" aria-hidden="true" />}
                  <span>{executing ? "Executing…" : "Execute saved concept"}</span>
                </span>
              </button>
            </div>

            {/* ── Inline validation tester ── */}
            <div className="admin-panel__semantic-inline-tester">
              <div className="admin-panel__semantic-inline-tester-head">
                <span className="admin-panel__form-card-title" style={{ fontSize: "0.82rem" }}>
                  Validate phrase
                </span>
                <span className="admin-panel__muted" style={{ fontSize: "0.74rem" }}>
                  Test AI resolution without leaving this panel
                </span>
              </div>

              <div className="admin-panel__semantic-examples">
                {SAMPLE_RESOLUTION_QUERIES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="admin-panel__semantic-example-chip"
                    onClick={() => setResolutionQuery(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>

              <textarea
                className="admin-panel__input admin-panel__textarea"
                rows={2}
                value={resolutionQuery}
                onChange={(e) => setResolutionQuery(e.target.value)}
                placeholder="Type a natural-language phrase…"
              />

              <div className="admin-panel__semantic-tester-actions">
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                  onClick={() => void handleResolve()}
                  disabled={!resolutionQuery.trim() || resolving}
                >
                  <span className="admin-panel__btn-content">
                    {resolving && <span className="admin-panel__spinner admin-panel__spinner--inline" aria-hidden="true" />}
                    <span>{resolving ? "Resolving…" : "Resolve phrase"}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--primary admin-panel__btn--compact"
                  onClick={() => void handleExecuteResolved()}
                  disabled={!resolutionQuery.trim() || executing}
                >
                  <span className="admin-panel__btn-content">
                    {executing && <span className="admin-panel__spinner admin-panel__spinner--inline" aria-hidden="true" />}
                    <span>{executing ? "Executing…" : "Execute snapshot"}</span>
                  </span>
                </button>
              </div>

              {/* Inline results — 2 col */}
              {(resolutionAttempted || executionAttempted) && (
                <div className="admin-panel__semantic-inline-results">
                  {/* Resolution */}
                  <div className="admin-panel__semantic-result-card">
                    <strong>Resolution</strong>
                    {resolutionError ? (
                      <div className="admin-panel__semantic-result-note admin-panel__semantic-result-note--error">{resolutionError}</div>
                    ) : resolving ? (
                      <div className="admin-panel__semantic-loading-state">
                        <span className="admin-panel__spinner admin-panel__spinner--inline-card" aria-hidden="true" />
                        <span className="admin-panel__muted">Resolving…</span>
                      </div>
                    ) : resolutionResult?.resolvedConcept ? (
                      <>
                        <div className="admin-panel__semantic-result-line">
                          <span>Matched</span>
                          <strong>{resolutionResult.resolvedConcept.displayName}</strong>
                        </div>
                        <div className="admin-panel__semantic-result-candidates">
                          {resolveCandidates.slice(0, 4).map((c) => (
                            <div key={c.concept.id} className="admin-panel__semantic-result-candidate">
                              <span>{c.concept.displayName}</span>
                              <span className="admin-panel__muted">{c.matchReason} · {c.score}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : resolutionAttempted ? (
                      <span className="admin-panel__muted">No match found.</span>
                    ) : (
                      <span className="admin-panel__muted">–</span>
                    )}
                  </div>

                  {/* Execution */}
                  <div className="admin-panel__semantic-result-card">
                    <strong>Execution</strong>
                    {executionError ? (
                      <div className="admin-panel__semantic-result-note admin-panel__semantic-result-note--error">{executionError}</div>
                    ) : executing ? (
                      <div className="admin-panel__semantic-loading-state">
                        <span className="admin-panel__spinner admin-panel__spinner--inline-card" aria-hidden="true" />
                        <span className="admin-panel__muted">Executing…</span>
                      </div>
                    ) : executionResult ? (
                      <>
                        <div className="admin-panel__semantic-result-line">
                          <span>Value</span>
                          <strong>{formatExecutionValue(executionResult)}</strong>
                        </div>
                        <div className="admin-panel__semantic-result-candidates">
                          {executionResult.result.members.slice(0, 4).map((m) => (
                            <div key={m.memberId} className="admin-panel__semantic-result-candidate">
                              <span>{m.label}</span>
                              <span className="admin-panel__muted">{m.key ? `${m.key}: ${String(m.value)}` : String(m.value)}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : executionAttempted ? (
                      <span className="admin-panel__muted">No result.</span>
                    ) : (
                      <span className="admin-panel__muted">–</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Member picker modal ── */}
      {showMemberModal && (
        <MemberModal
          allMetrics={flatMetrics}
          selectedIds={selectedMetricIds}
          onAdd={addMetricMember}
          onClose={() => setShowMemberModal(false)}
        />
      )}
    </div>
  );
}
