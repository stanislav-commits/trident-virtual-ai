import { useEffect, useMemo, useState } from "react";
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
  shipName: string | null;
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
  slug: string;
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
  slugSuffix: string;
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
    slugSuffix: "single_metric",
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
    slugSuffix: "metric_group",
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
    slugSuffix: "composite_total",
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
    slugSuffix: "vessel_location",
    category: "navigation",
    type: "paired",
    aggregationRule: "coordinate_pair",
    unit: "coordinate pair",
  },
];

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function createEmptyDraft(shipName?: string | null): ConceptDraft {
  const shipSlug = slugify(shipName ?? "");

  return {
    id: null,
    slug: shipSlug ? `${shipSlug}_` : "",
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
    slug: concept.slug,
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
  return CONCEPT_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

function formatAggregationRule(value: MetricAggregationRule): string {
  return (
    AGGREGATION_RULE_OPTIONS.find((option) => option.value === value)?.label ??
    value
  );
}

function formatExecutionValue(result: MetricConceptExecutionResponse | null): string {
  if (!result) {
    return "-";
  }

  const { value, unit } = result.result;

  if (typeof value === "number") {
    return `${value}${unit ? ` ${unit}` : ""}`;
  }

  if (typeof value === "string") {
    return `${value}${unit ? ` ${unit}` : ""}`;
  }

  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }

  if (value === null || value === undefined) {
    return "No data";
  }

  return String(value);
}

function getReadinessBadgeClass(tone: ReadinessState["tone"]): string {
  if (tone === "ready") {
    return "admin-panel__badge admin-panel__badge--manual-done";
  }

  if (tone === "inactive") {
    return "admin-panel__badge admin-panel__badge--manual-cancel";
  }

  return "admin-panel__badge admin-panel__badge--manual-pending";
}

function evaluateReadiness(input: {
  isActive: boolean;
  type: MetricConceptType;
  memberCount: number;
  memberRoles: string[];
}): ReadinessState {
  if (!input.isActive) {
    return {
      label: "Inactive",
      tone: "inactive",
      hint: "Enable this concept before the chat planner can use it.",
    };
  }

  if (input.memberCount === 0) {
    return {
      label: "Needs members",
      tone: "warning",
      hint: "Attach raw metrics so this concept can execute.",
    };
  }

  if (input.type === "paired" && input.memberCount < 2) {
    return {
      label: "Needs pair",
      tone: "warning",
      hint: "A paired concept should contain two members such as latitude and longitude.",
    };
  }

  if (
    input.type === "paired" &&
    !input.memberRoles.includes("latitude") &&
    !input.memberRoles.includes("longitude")
  ) {
    return {
      label: "Needs roles",
      tone: "warning",
      hint: "Add clear member roles like latitude and longitude for paired concepts.",
    };
  }

  return {
    label: "Ready",
    tone: "ready",
    hint: "This concept is ready for semantic testing in chat and in the validation panel.",
  };
}

function getConceptReadiness(concept: MetricConcept): ReadinessState {
  return evaluateReadiness({
    isActive: concept.isActive,
    type: concept.type,
    memberCount: concept.members.length,
    memberRoles: concept.members
      .map((member) => member.role?.trim().toLowerCase())
      .filter((role): role is string => Boolean(role)),
  });
}

export function MetricsSemanticConceptsPanel({
  token,
  shipId,
  shipName,
  catalog,
  syncMarker,
}: MetricsSemanticConceptsPanelProps) {
  const {
    concepts,
    loading,
    saving,
    bootstrapping,
    error,
    setError,
    refreshConcepts,
    bootstrapConcepts,
    saveConcept,
    resolveQuery,
    executeConcept,
  } = useMetricConceptsAdminData(token, shipId, Boolean(token && shipId));
  const [conceptSearch, setConceptSearch] = useState("");
  const [metricSearch, setMetricSearch] = useState("");
  const [resolutionQuery, setResolutionQuery] = useState("");
  const [resolutionResult, setResolutionResult] =
    useState<MetricConceptResolutionResult | null>(null);
  const [executionResult, setExecutionResult] =
    useState<MetricConceptExecutionResponse | null>(null);
  const [resolutionAttempted, setResolutionAttempted] = useState(false);
  const [executionAttempted, setExecutionAttempted] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [resolutionError, setResolutionError] = useState("");
  const [executionError, setExecutionError] = useState("");
  const [bootstrapResult, setBootstrapResult] =
    useState<MetricConceptBootstrapResult | null>(null);
  const [draft, setDraft] = useState<ConceptDraft>(() => createEmptyDraft(shipName));

  if (!shipId) {
    return (
      <div className="admin-panel__state-box">
        <span className="admin-panel__muted">
          Select a ship to manage its semantic concepts.
        </span>
      </div>
    );
  }

  useEffect(() => {
    setDraft(createEmptyDraft(shipName));
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
  }, [shipId, shipName]);

  useEffect(() => {
    if (syncMarker) {
      void refreshConcepts();
    }
  }, [refreshConcepts, syncMarker]);

  const flatMetrics = useMemo(() => {
    if (!catalog) {
      return [];
    }

    return catalog.buckets.flatMap((bucketGroup) =>
      bucketGroup.metrics.map((metric) => ({
        ...metric,
        bucket: bucketGroup.bucket,
        label: humanizeMetricLabel(metric.key),
      })),
    );
  }, [catalog]);

  const filteredConcepts = useMemo(() => {
    const normalizedSearch = conceptSearch.trim().toLowerCase();

    if (!normalizedSearch) {
      return concepts;
    }

    return concepts.filter((concept) => {
      const haystack = [
        concept.displayName,
        concept.slug,
        concept.category,
        concept.type,
        concept.aggregationRule,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    });
  }, [conceptSearch, concepts]);

  const selectedMetricIds = useMemo(
    () =>
      new Set(
        draft.members
          .map((member) => member.metricCatalogId)
          .filter((value): value is string => Boolean(value)),
      ),
    [draft.members],
  );

  const availableMetricCandidates = useMemo(() => {
    const normalizedSearch = metricSearch.trim().toLowerCase();

    return flatMetrics
      .filter((metric) => !selectedMetricIds.has(metric.id))
      .filter((metric) => {
        if (!normalizedSearch) {
          return true;
        }

        const haystack = [
          metric.label,
          metric.key,
          metric.field,
          metric.bucket,
          metric.description,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return haystack.includes(normalizedSearch);
      })
      .slice(0, 16);
  }, [flatMetrics, metricSearch, selectedMetricIds]);

  const resolveCandidates = resolutionResult?.candidates ?? [];
  const draftReadiness = useMemo(
    () =>
      evaluateReadiness({
        isActive: draft.isActive,
        type: draft.type,
        memberCount: draft.members.length,
        memberRoles: draft.members
          .map((member) => member.role.trim().toLowerCase())
          .filter(Boolean),
      }),
    [draft.isActive, draft.type, draft.members],
  );
  const conceptHealthSummary = useMemo(() => {
    return concepts.reduce(
      (summary, concept) => {
        const readiness = getConceptReadiness(concept);

        if (readiness.tone === "ready") {
          summary.ready += 1;
        } else if (readiness.tone === "inactive") {
          summary.inactive += 1;
        } else {
          summary.needsAttention += 1;
        }

        return summary;
      },
      {
        ready: 0,
        needsAttention: 0,
        inactive: 0,
      },
    );
  }, [concepts]);

  const applyTemplate = (templateId: string) => {
    const template = CONCEPT_TEMPLATES.find((entry) => entry.id === templateId);

    if (!template) {
      return;
    }

    const shipSlug = slugify(shipName ?? "");
    const nextSlug = shipSlug
      ? `${shipSlug}_${template.slugSuffix}`
      : template.slugSuffix;

    setDraft({
      id: null,
      slug: nextSlug,
      displayName: template.displayName,
      description: template.description,
      category: template.category,
      type: template.type,
      aggregationRule: template.aggregationRule,
      unit: template.unit,
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
  };

  const handleCreateNew = () => {
    setDraft(createEmptyDraft(shipName));
    setExecutionResult(null);
    setResolutionResult(null);
    setResolutionAttempted(false);
    setExecutionAttempted(false);
    setResolutionError("");
    setExecutionError("");
    setError("");
  };

  const handleDraftChange = (
    field: keyof Omit<ConceptDraft, "members">,
    value: string | boolean,
  ) => {
    setDraft((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleDisplayNameBlur = () => {
    setDraft((current) => {
      if (current.slug.trim()) {
        return current;
      }

      const prefix = slugify(shipName ?? "");
      const nextSlug = slugify(current.displayName);

      return {
        ...current,
        slug: prefix && nextSlug ? `${prefix}_${nextSlug}` : nextSlug,
      };
    });
  };

  const addMetricMember = (metricId: string) => {
    const metric = flatMetrics.find((entry) => entry.id === metricId);

    if (!metric) {
      return;
    }

    setDraft((current) => ({
      ...current,
      members: [
        ...current.members,
        {
          localId: `metric-${metric.id}`,
          metricCatalogId: metric.id,
          role: "",
          sortOrder: current.members.length,
          label: metric.label,
          subtitle: metric.key,
        },
      ],
    }));
  };

  const removeMember = (localId: string) => {
    setDraft((current) => ({
      ...current,
      members: current.members
        .filter((member) => member.localId !== localId)
        .map((member, index) => ({
          ...member,
          sortOrder: index,
        })),
    }));
  };

  const updateMemberRole = (localId: string, role: string) => {
    setDraft((current) => ({
      ...current,
      members: current.members.map((member) =>
        member.localId === localId ? { ...member, role } : member,
      ),
    }));
  };

  const buildPayload = (): SaveMetricConceptInput => ({
    slug: draft.slug.trim(),
    displayName: draft.displayName.trim(),
    description: draft.description.trim() || null,
    category: draft.category.trim() || null,
    type: draft.type,
    aggregationRule: draft.aggregationRule,
    unit: draft.unit.trim() || null,
    isActive: draft.isActive,
    members: draft.members.map((member, index) => ({
      metricCatalogId: member.metricCatalogId,
      role: member.role.trim() || undefined,
      sortOrder: index,
    })),
  });

  const handleSave = async () => {
    if (!draft.slug.trim() || !draft.displayName.trim()) {
      setError("Slug and display name are required.");
      return;
    }

    const savedConcept = await saveConcept(draft.id, buildPayload());

    if (savedConcept) {
      setDraft(conceptToDraft(savedConcept));
    }
  };

  const handleResolve = async () => {
    if (!resolutionQuery.trim()) {
      setError("Enter a phrase to test concept resolution.");
      return;
    }

    setError("");
    setResolutionAttempted(true);
    setExecutionAttempted(false);
    setResolutionError("");
    setExecutionError("");
    setExecutionResult(null);
    setResolving(true);

    try {
      const result = await resolveQuery(resolutionQuery.trim());
      setResolutionResult(result);
    } catch (resolveError) {
      setResolutionResult(null);
      setResolutionError(
        resolveError instanceof Error
          ? resolveError.message
          : "Failed to resolve metric concept",
      );
    } finally {
      setResolving(false);
    }
  };

  const handleExecuteResolved = async () => {
    const query = resolutionQuery.trim();

    if (!query) {
      setError("Enter a phrase to execute.");
      return;
    }

    setError("");
    setExecutionAttempted(true);
    setExecutionError("");
    setExecuting(true);

    try {
      const result = await executeConcept({
        query,
        timeMode: "snapshot",
      });
      if (result) {
        setExecutionResult(result);
      }
    } catch (executeError) {
      setExecutionResult(null);
      setExecutionError(
        executeError instanceof Error
          ? executeError.message
          : "Failed to execute metric concept",
      );
    } finally {
      setExecuting(false);
    }
  };

  const handleExecuteDraft = async () => {
    const conceptId = draft.id;

    if (!conceptId) {
      setError("Save the concept before executing it.");
      return;
    }

    setError("");
    setExecutionAttempted(true);
    setExecutionError("");
    setExecuting(true);

    try {
      const result = await executeConcept({
        conceptId,
        timeMode: "snapshot",
      });

      if (result) {
        setExecutionResult(result);
      }
    } catch (executeError) {
      setExecutionResult(null);
      setExecutionError(
        executeError instanceof Error
          ? executeError.message
          : "Failed to execute metric concept",
      );
    } finally {
      setExecuting(false);
    }
  };

  const handleBootstrap = async () => {
    const result = await bootstrapConcepts();

    if (result) {
      setBootstrapResult(result);
    }
  };

  return (
    <div className="admin-panel__semantic-layout">
      <div className="admin-panel__metrics-group-card">
        <div className="admin-panel__metrics-group-header">
          <div className="admin-panel__metrics-group-meta">
            <span className="admin-panel__metrics-bucket-badge admin-panel__metrics-bucket-badge--active">
              Semantic concepts
            </span>
            <span className="admin-panel__muted">
              Build ship-aware concepts like fuel total, fuel tanks, or vessel
              location on top of the raw Influx catalog.
            </span>
          </div>
          <div className="admin-panel__actions">
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
              onClick={() => void refreshConcepts()}
              disabled={!shipId || loading}
            >
              Refresh concepts
            </button>
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--primary admin-panel__btn--compact"
              onClick={() => void handleBootstrap()}
              disabled={!shipId || bootstrapping}
            >
              {bootstrapping ? "Generating..." : "Generate base concepts"}
            </button>
          </div>
        </div>

        {error ? (
          <div className="admin-panel__error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="admin-panel__semantic-summary">
          <span className="admin-panel__muted">
            {loading
              ? "Loading semantic concepts..."
              : `${concepts.length} concepts linked to this ship`}
          </span>
          <div className="admin-panel__semantic-summary-chips">
            <span className="admin-panel__semantic-stat admin-panel__semantic-stat--ready">
              {conceptHealthSummary.ready} ready
            </span>
            <span className="admin-panel__semantic-stat admin-panel__semantic-stat--warning">
              {conceptHealthSummary.needsAttention} need attention
            </span>
            <span className="admin-panel__semantic-stat">
              {conceptHealthSummary.inactive} inactive
            </span>
          </div>
          {bootstrapResult ? (
            <span className="admin-panel__muted">
              Bootstrap: +{bootstrapResult.conceptsCreated} created,{" "}
              {bootstrapResult.conceptsUpdated} updated.
            </span>
          ) : null}
        </div>
      </div>

      <div className="admin-panel__metrics-group-card">
        <div className="admin-panel__metrics-group-header">
          <div className="admin-panel__metrics-group-meta">
            <span className="admin-panel__form-card-title">Quick start templates</span>
            <span className="admin-panel__muted">
              Start from a guided shape instead of an empty semantic form.
            </span>
          </div>
        </div>

        <div className="admin-panel__semantic-template-grid">
          {CONCEPT_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className="admin-panel__semantic-template-card"
              onClick={() => applyTemplate(template.id)}
            >
              <strong>{template.label}</strong>
              <span className="admin-panel__muted">{template.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="admin-panel__semantic-grid">
        <div className="admin-panel__metrics-group-card">
          <div className="admin-panel__metrics-group-header">
            <div className="admin-panel__metrics-group-meta">
              <span className="admin-panel__form-card-title">Concepts</span>
            </div>
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
              onClick={handleCreateNew}
            >
              New concept
            </button>
          </div>

          <label className="admin-panel__metrics-search admin-panel__semantic-search">
            <SearchIcon />
            <input
              className="admin-panel__metrics-search-input"
              value={conceptSearch}
              onChange={(event) => setConceptSearch(event.target.value)}
              placeholder="Search display name, slug, category..."
            />
          </label>

          <div className="admin-panel__semantic-concept-list">
            {filteredConcepts.length === 0 ? (
              <div className="admin-panel__state-box">
                <span className="admin-panel__muted">
                  No semantic concepts found for this ship.
                </span>
              </div>
            ) : (
              filteredConcepts.map((concept) => {
                const readiness = getConceptReadiness(concept);

                return (
                  <button
                    key={concept.id}
                    type="button"
                    className={`admin-panel__semantic-concept-item ${
                      draft.id === concept.id
                        ? "admin-panel__semantic-concept-item--active"
                        : ""
                    }`}
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
                      <code className="admin-panel__code-inline admin-panel__code-inline--metric">
                        {concept.slug}
                      </code>
                      <span>{formatAggregationRule(concept.aggregationRule)}</span>
                      <span>{concept.members.length} members</span>
                    </div>
                    <span className="admin-panel__muted">{readiness.hint}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="admin-panel__metrics-group-card">
          <div className="admin-panel__metrics-group-header">
            <div className="admin-panel__metrics-group-meta">
              <span className="admin-panel__form-card-title">
                {draft.id ? "Edit concept" : "Create concept"}
              </span>
            </div>
            {draft.id ? (
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                onClick={handleCreateNew}
              >
                Clear form
              </button>
            ) : null}
          </div>

          <div className="admin-panel__semantic-editor-summary">
            <div className="admin-panel__semantic-editor-summary-top">
              <span className={getReadinessBadgeClass(draftReadiness.tone)}>
                {draftReadiness.label}
              </span>
              <div className="admin-panel__semantic-concept-badges">
                <span className="admin-panel__badge admin-panel__badge--user">
                  {formatConceptType(draft.type)}
                </span>
                <span className="admin-panel__semantic-stat">
                  {draft.members.length} members
                </span>
              </div>
            </div>
            <span className="admin-panel__muted">{draftReadiness.hint}</span>
          </div>

          <div className="admin-panel__form-row">
            <div className="admin-panel__field">
              <label className="admin-panel__field-label">Slug</label>
              <input
                className="admin-panel__input"
                value={draft.slug}
                onChange={(event) => handleDraftChange("slug", event.target.value)}
                placeholder="x_wolf_fuel_total"
              />
            </div>
            <div className="admin-panel__field">
              <label className="admin-panel__field-label">Display name</label>
              <input
                className="admin-panel__input"
                value={draft.displayName}
                onBlur={handleDisplayNameBlur}
                onChange={(event) =>
                  handleDraftChange("displayName", event.target.value)
                }
                placeholder="Fuel Total"
              />
            </div>
          </div>

          <div className="admin-panel__form-row">
            <div className="admin-panel__field">
              <label className="admin-panel__field-label">Type</label>
              <select
                className="admin-panel__select"
                value={draft.type}
                onChange={(event) =>
                  handleDraftChange(
                    "type",
                    event.target.value as MetricConceptType,
                  )
                }
              >
                {CONCEPT_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="admin-panel__field">
              <label className="admin-panel__field-label">Aggregation</label>
              <select
                className="admin-panel__select"
                value={draft.aggregationRule}
                onChange={(event) =>
                  handleDraftChange(
                    "aggregationRule",
                    event.target.value as MetricAggregationRule,
                  )
                }
              >
                {AGGREGATION_RULE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="admin-panel__field">
              <label className="admin-panel__field-label">Unit</label>
              <input
                className="admin-panel__input"
                value={draft.unit}
                onChange={(event) => handleDraftChange("unit", event.target.value)}
                placeholder="knots / liters / coordinate"
              />
            </div>
          </div>

          <div className="admin-panel__form-row">
            <div className="admin-panel__field">
              <label className="admin-panel__field-label">Category</label>
              <input
                className="admin-panel__input"
                value={draft.category}
                onChange={(event) =>
                  handleDraftChange("category", event.target.value)
                }
                placeholder="navigation / fuel / engine"
              />
            </div>
            <div className="admin-panel__field">
              <label className="admin-panel__field-label">Status</label>
              <label className="admin-panel__semantic-checkbox">
                <input
                  type="checkbox"
                  checked={draft.isActive}
                  onChange={(event) =>
                    handleDraftChange("isActive", event.target.checked)
                  }
                />
                <span>Concept is active</span>
              </label>
            </div>
          </div>

          <div className="admin-panel__field">
            <label className="admin-panel__field-label">Description</label>
            <textarea
              className="admin-panel__input admin-panel__textarea"
              rows={3}
              value={draft.description}
              onChange={(event) =>
                handleDraftChange("description", event.target.value)
              }
              placeholder="Short explanation of what this concept means."
            />
          </div>

          <div className="admin-panel__semantic-members">
            <div className="admin-panel__field">
              <label className="admin-panel__field-label">Selected members</label>
              {draft.members.length === 0 ? (
                <div className="admin-panel__state-box admin-panel__state-box--compact">
                  <span className="admin-panel__muted">
                    Add raw metrics to define this semantic concept.
                  </span>
                </div>
              ) : (
                <div className="admin-panel__semantic-member-list">
                  {draft.members.map((member) => (
                    <div
                      key={member.localId}
                      className="admin-panel__semantic-member-item"
                    >
                      <div className="admin-panel__semantic-member-main">
                        <div className="admin-panel__semantic-member-copy">
                          <strong>{member.label}</strong>
                          <span className="admin-panel__muted">
                            {member.subtitle}
                          </span>
                        </div>
                      </div>
                      <div className="admin-panel__semantic-member-controls">
                        <input
                          className="admin-panel__input admin-panel__input--compact"
                          value={member.role}
                          onChange={(event) =>
                            updateMemberRole(member.localId, event.target.value)
                          }
                          placeholder="role (latitude, longitude, primary...)"
                        />
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                          onClick={() => removeMember(member.localId)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="admin-panel__semantic-adders">
              <div className="admin-panel__field">
                <label className="admin-panel__field-label">Add metric member</label>
                <label className="admin-panel__metrics-search admin-panel__semantic-search">
                  <SearchIcon />
                  <input
                    className="admin-panel__metrics-search-input"
                    value={metricSearch}
                    onChange={(event) => setMetricSearch(event.target.value)}
                    placeholder="Search bucket, key, or description..."
                  />
                </label>
                <div className="admin-panel__semantic-candidate-list">
                  {availableMetricCandidates.map((metric) => (
                    <button
                      key={metric.id}
                      type="button"
                      className="admin-panel__semantic-candidate-item"
                      onClick={() => addMetricMember(metric.id)}
                    >
                      <strong>{metric.label}</strong>
                      <span className="admin-panel__muted">{metric.key}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="admin-panel__actions admin-panel__semantic-actions">
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--primary"
              onClick={() => void handleSave()}
              disabled={saving || !shipId}
              aria-busy={saving}
            >
              <span className="admin-panel__btn-content">
                {saving ? (
                  <span
                    className="admin-panel__spinner admin-panel__spinner--inline"
                    aria-hidden="true"
                  />
                ) : null}
                <span>
                  {saving ? "Saving..." : draft.id ? "Save concept" : "Create concept"}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--ghost"
              onClick={() => void handleExecuteDraft()}
              disabled={!draft.id || executing}
              aria-busy={executing}
            >
              <span className="admin-panel__btn-content">
                {executing ? (
                  <span
                    className="admin-panel__spinner admin-panel__spinner--inline"
                    aria-hidden="true"
                  />
                ) : null}
                <span>{executing ? "Executing..." : "Execute saved concept"}</span>
              </span>
            </button>
          </div>
        </div>
      </div>

      <div className="admin-panel__metrics-group-card">
        <div className="admin-panel__metrics-group-header">
          <div className="admin-panel__metrics-group-meta">
            <span className="admin-panel__form-card-title">
              Validate how AI will understand this phrase
            </span>
            <span className="admin-panel__muted">
              Test semantic matching and live execution without going back to chat.
            </span>
          </div>
        </div>

        <div className="admin-panel__semantic-tester">
          <div className="admin-panel__field">
            <label className="admin-panel__field-label">
              Natural-language phrase
            </label>
            <textarea
              className="admin-panel__input admin-panel__textarea"
              rows={3}
              value={resolutionQuery}
              onChange={(event) => setResolutionQuery(event.target.value)}
              placeholder="а кількість палива / where is the yacht now?"
            />
            <span className="admin-panel__semantic-helper">
              Type a real phrase to test how the resolver matches by concept
              meaning, description, and member structure for the selected ship.
            </span>
            <div className="admin-panel__semantic-examples">
              {SAMPLE_RESOLUTION_QUERIES.map((sample) => (
                <button
                  key={sample}
                  type="button"
                  className="admin-panel__semantic-example-chip"
                  onClick={() => setResolutionQuery(sample)}
                >
                  {sample}
                </button>
              ))}
            </div>
          </div>

          <div className="admin-panel__actions">
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--ghost"
              onClick={() => void handleResolve()}
              disabled={!resolutionQuery.trim() || resolving}
              aria-busy={resolving}
            >
              <span className="admin-panel__btn-content">
                {resolving ? (
                  <span
                    className="admin-panel__spinner admin-panel__spinner--inline"
                    aria-hidden="true"
                  />
                ) : null}
                <span>{resolving ? "Resolving..." : "Resolve phrase"}</span>
              </span>
            </button>
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--primary"
              onClick={() => void handleExecuteResolved()}
              disabled={!resolutionQuery.trim() || executing}
              aria-busy={executing}
            >
              <span className="admin-panel__btn-content">
                {executing ? (
                  <span
                    className="admin-panel__spinner admin-panel__spinner--inline"
                    aria-hidden="true"
                  />
                ) : null}
                <span>{executing ? "Executing..." : "Execute snapshot"}</span>
              </span>
            </button>
          </div>

          <div className="admin-panel__semantic-results">
            <div className="admin-panel__semantic-result-card">
              <strong>Resolution result</strong>
              {resolutionError ? (
                <div className="admin-panel__semantic-result-note admin-panel__semantic-result-note--error">
                  {resolutionError}
                </div>
              ) : resolving ? (
                <div className="admin-panel__semantic-loading-state">
                  <span
                    className="admin-panel__spinner admin-panel__spinner--inline-card"
                    aria-hidden="true"
                  />
                  <span className="admin-panel__muted">
                    Resolving phrase against semantic concepts...
                  </span>
                </div>
              ) : resolutionResult?.resolvedConcept ? (
                <>
                  <div className="admin-panel__semantic-result-line">
                    <span>Resolved concept</span>
                    <strong>{resolutionResult.resolvedConcept.displayName}</strong>
                  </div>
                  <div className="admin-panel__semantic-result-line">
                    <span>Slug</span>
                    <code className="admin-panel__code-inline admin-panel__code-inline--metric">
                      {resolutionResult.resolvedConcept.slug}
                    </code>
                  </div>
                  <div className="admin-panel__semantic-result-candidates">
                    {resolveCandidates.slice(0, 5).map((candidate) => (
                      <div
                        key={candidate.concept.id}
                        className="admin-panel__semantic-result-candidate"
                      >
                        <span>{candidate.concept.displayName}</span>
                        <span className="admin-panel__muted">
                          {candidate.matchReason} · {candidate.score}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : resolutionAttempted && resolutionResult ? (
                <>
                  <div className="admin-panel__semantic-result-note">
                    No matching concept was found for this phrase on the selected
                    ship.
                  </div>
                  {resolveCandidates.length > 0 ? (
                    <div className="admin-panel__semantic-result-candidates">
                      {resolveCandidates.slice(0, 5).map((candidate) => (
                        <div
                          key={candidate.concept.id}
                          className="admin-panel__semantic-result-candidate"
                        >
                          <span>{candidate.concept.displayName}</span>
                          <span className="admin-panel__muted">
                            {candidate.matchReason} · {candidate.score}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="admin-panel__muted">
                      Create a concept with a clear name, description, and member
                      structure if this phrase should be supported.
                    </span>
                  )}
                </>
              ) : (
                <span className="admin-panel__muted">
                  No phrase has been resolved yet.
                </span>
              )}
            </div>

            <div className="admin-panel__semantic-result-card">
              <strong>Execution result</strong>
              {executionError ? (
                <div className="admin-panel__semantic-result-note admin-panel__semantic-result-note--error">
                  {executionError}
                </div>
              ) : executing ? (
                <div className="admin-panel__semantic-loading-state">
                  <span
                    className="admin-panel__spinner admin-panel__spinner--inline-card"
                    aria-hidden="true"
                  />
                  <span className="admin-panel__muted">
                    Executing concept against live Influx data...
                  </span>
                </div>
              ) : executionResult ? (
                <>
                  <div className="admin-panel__semantic-result-line">
                    <span>Concept</span>
                    <strong>{executionResult.concept.displayName}</strong>
                  </div>
                  <div className="admin-panel__semantic-result-line">
                    <span>Value</span>
                    <strong>{formatExecutionValue(executionResult)}</strong>
                  </div>
                  <div className="admin-panel__semantic-result-line">
                    <span>Timestamp</span>
                    <span>{executionResult.result.timestamp ?? "-"}</span>
                  </div>
                  <div className="admin-panel__semantic-result-candidates">
                    {executionResult.result.members.slice(0, 6).map((member) => (
                      <div
                        key={member.memberId}
                        className="admin-panel__semantic-result-candidate"
                      >
                        <span>{member.label}</span>
                        <span className="admin-panel__muted">
                          {member.key
                            ? `${member.key}: ${String(member.value)}`
                            : String(member.value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : executionAttempted ? (
                <div className="admin-panel__semantic-result-note">
                  Execution did not return a result for this test phrase.
                </div>
              ) : (
                <span className="admin-panel__muted">
                  No concept has been executed yet.
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
