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
  metricCatalogId?: string;
  childConceptId?: string;
  role: string;
  sortOrder: number;
  label: string;
  subtitle: string;
  kind: "metric" | "concept";
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
  aliasesText: string;
  members: EditableConceptMember[];
}

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
    aliasesText: "",
    members: [],
  };
}

function parseAliases(aliasesText: string): string[] {
  return [...new Set(
    aliasesText
      .split(/\n|,/)
      .map((alias) => alias.trim())
      .filter(Boolean),
  )];
}

function formatMemberSubtitle(member: MetricConceptMember): string {
  if (member.metric) {
    return member.metric.key;
  }

  if (member.childConcept) {
    return member.childConcept.slug;
  }

  return "Unknown member";
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
    aliasesText: concept.aliases.join("\n"),
    members: concept.members.map((member, index) => ({
      localId: member.id,
      metricCatalogId: member.metricCatalogId ?? undefined,
      childConceptId: member.childConceptId ?? undefined,
      role: member.role ?? "",
      sortOrder: member.sortOrder ?? index,
      label: member.metric
        ? humanizeMetricLabel(member.metric.key)
        : member.childConcept?.displayName ?? "Nested concept",
      subtitle: formatMemberSubtitle(member),
      kind: member.metric ? "metric" : "concept",
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
  const [childConceptSearch, setChildConceptSearch] = useState("");
  const [resolutionQuery, setResolutionQuery] = useState("");
  const [resolutionResult, setResolutionResult] =
    useState<MetricConceptResolutionResult | null>(null);
  const [executionResult, setExecutionResult] =
    useState<MetricConceptExecutionResponse | null>(null);
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
        ...concept.aliases,
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

  const selectedChildConceptIds = useMemo(
    () =>
      new Set(
        draft.members
          .map((member) => member.childConceptId)
          .filter((value): value is string => Boolean(value)),
      ),
    [draft.members],
  );

  const availableChildConceptCandidates = useMemo(() => {
    const normalizedSearch = childConceptSearch.trim().toLowerCase();

    return concepts
      .filter((concept) => concept.id !== draft.id)
      .filter((concept) => !selectedChildConceptIds.has(concept.id))
      .filter((concept) => {
        if (!normalizedSearch) {
          return true;
        }

        const haystack = [
          concept.displayName,
          concept.slug,
          concept.category,
          ...concept.aliases,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return haystack.includes(normalizedSearch);
      })
      .slice(0, 12);
  }, [childConceptSearch, concepts, draft.id, selectedChildConceptIds]);

  const resolveCandidates = resolutionResult?.candidates ?? [];

  const handleSelectConcept = (concept: MetricConcept) => {
    setDraft(conceptToDraft(concept));
    setExecutionResult(null);
    setResolutionResult(null);
    setError("");
  };

  const handleCreateNew = () => {
    setDraft(createEmptyDraft(shipName));
    setExecutionResult(null);
    setResolutionResult(null);
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
          kind: "metric",
        },
      ],
    }));
  };

  const addChildConceptMember = (conceptId: string) => {
    const concept = concepts.find((entry) => entry.id === conceptId);

    if (!concept) {
      return;
    }

    setDraft((current) => ({
      ...current,
      members: [
        ...current.members,
        {
          localId: `concept-${concept.id}`,
          childConceptId: concept.id,
          role: "",
          sortOrder: current.members.length,
          label: concept.displayName,
          subtitle: concept.slug,
          kind: "concept",
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
    aliases: parseAliases(draft.aliasesText),
    members: draft.members.map((member, index) => ({
      metricCatalogId: member.metricCatalogId,
      childConceptId: member.childConceptId,
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

    setExecutionResult(null);
    const result = await resolveQuery(resolutionQuery.trim());

    if (result) {
      setResolutionResult(result);
    }
  };

  const handleExecuteResolved = async () => {
    const query = resolutionQuery.trim();

    if (!query) {
      setError("Enter a phrase to execute.");
      return;
    }

    const result = await executeConcept({
      query,
      timeMode: "snapshot",
    });

    if (result) {
      setExecutionResult(result);
    }
  };

  const handleExecuteDraft = async () => {
    const conceptId = draft.id;

    if (!conceptId) {
      setError("Save the concept before executing it.");
      return;
    }

    const result = await executeConcept({
      conceptId,
      timeMode: "snapshot",
    });

    if (result) {
      setExecutionResult(result);
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
              {bootstrapping ? "Bootstrapping..." : "Bootstrap semantics"}
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
          {bootstrapResult ? (
            <span className="admin-panel__muted">
              Bootstrap: +{bootstrapResult.conceptsCreated} created,{" "}
              {bootstrapResult.conceptsUpdated} updated,{" "}
              {bootstrapResult.aliasesAdded} aliases added.
            </span>
          ) : null}
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
              placeholder="Search display name, slug, alias..."
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
              filteredConcepts.map((concept) => (
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
                    <span className="admin-panel__badge admin-panel__badge--user">
                      {formatConceptType(concept.type)}
                    </span>
                  </div>
                  <div className="admin-panel__semantic-concept-item-meta">
                    <code className="admin-panel__code-inline admin-panel__code-inline--metric">
                      {concept.slug}
                    </code>
                    <span>{formatAggregationRule(concept.aggregationRule)}</span>
                    <span>{concept.members.length} members</span>
                  </div>
                </button>
              ))
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

          <div className="admin-panel__field">
            <label className="admin-panel__field-label">
              Aliases (one per line or comma-separated)
            </label>
            <textarea
              className="admin-panel__input admin-panel__textarea"
              rows={4}
              value={draft.aliasesText}
              onChange={(event) =>
                handleDraftChange("aliasesText", event.target.value)
              }
              placeholder="fuel on board&#10;remaining fuel&#10;кількість палива"
            />
          </div>

          <div className="admin-panel__semantic-members">
            <div className="admin-panel__field">
              <label className="admin-panel__field-label">Selected members</label>
              {draft.members.length === 0 ? (
                <div className="admin-panel__state-box admin-panel__state-box--compact">
                  <span className="admin-panel__muted">
                    Add metrics or nested concepts to define this semantic
                    concept.
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
                        <span className="admin-panel__badge admin-panel__badge--user">
                          {member.kind}
                        </span>
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

              <div className="admin-panel__field">
                <label className="admin-panel__field-label">Add child concept</label>
                <label className="admin-panel__metrics-search admin-panel__semantic-search">
                  <SearchIcon />
                  <input
                    className="admin-panel__metrics-search-input"
                    value={childConceptSearch}
                    onChange={(event) =>
                      setChildConceptSearch(event.target.value)
                    }
                    placeholder="Search existing concepts..."
                  />
                </label>
                <div className="admin-panel__semantic-candidate-list">
                  {availableChildConceptCandidates.map((concept) => (
                    <button
                      key={concept.id}
                      type="button"
                      className="admin-panel__semantic-candidate-item"
                      onClick={() => addChildConceptMember(concept.id)}
                    >
                      <strong>{concept.displayName}</strong>
                      <span className="admin-panel__muted">{concept.slug}</span>
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
            >
              {saving ? "Saving..." : draft.id ? "Save concept" : "Create concept"}
            </button>
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--ghost"
              onClick={() => void handleExecuteDraft()}
              disabled={!draft.id}
            >
              Execute saved concept
            </button>
          </div>
        </div>
      </div>

      <div className="admin-panel__metrics-group-card">
        <div className="admin-panel__metrics-group-header">
          <div className="admin-panel__metrics-group-meta">
            <span className="admin-panel__form-card-title">
              Resolve and execute test
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
          </div>

          <div className="admin-panel__actions">
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--ghost"
              onClick={() => void handleResolve()}
              disabled={!resolutionQuery.trim()}
            >
              Resolve phrase
            </button>
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--primary"
              onClick={() => void handleExecuteResolved()}
              disabled={!resolutionQuery.trim()}
            >
              Execute snapshot
            </button>
          </div>

          <div className="admin-panel__semantic-results">
            <div className="admin-panel__semantic-result-card">
              <strong>Resolution result</strong>
              {resolutionResult?.resolvedConcept ? (
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
              ) : (
                <span className="admin-panel__muted">
                  No phrase has been resolved yet.
                </span>
              )}
            </div>

            <div className="admin-panel__semantic-result-card">
              <strong>Execution result</strong>
              {executionResult ? (
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
