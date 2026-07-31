import type { AssetItem, UpdateAssetInput } from "../../../api/assetsApi";
import type { SortKey } from "../../../hooks/admin/useAssetRegisterView";
import { groupCode } from "../../../hooks/admin/useAssetRegisterView";
import { EditableCell } from "./EditableCell";
import { sfiColorForGroup } from "./sfi-colors";

const COLUMNS: Array<[SortKey, string]> = [
  ["assetIdInternal", "SFI"],
  ["displayName", "Name"],
  ["brand", "Mfr"],
  ["model", "Model"],
  ["location", "Location"],
];

/**
 * The register itself. Every cell edits in place; the row tint says how well
 * the asset is documented — green for a manual AND telemetry, yellow for one
 * of them, grey for neither.
 */
export function AssetTable({
  assets,
  selectedAssetId,
  onSelectAsset,
  selectedIds,
  onToggleRow,
  allVisibleSelected,
  someSelected,
  onToggleAll,
  sort,
  onToggleSort,
  savingAssetId,
  makeFieldSaver,
  loading,
}: {
  assets: AssetItem[];
  selectedAssetId: string | null;
  onSelectAsset: (id: string) => void;
  selectedIds: Set<string>;
  onToggleRow: (id: string) => void;
  allVisibleSelected: boolean;
  someSelected: boolean;
  onToggleAll: () => void;
  sort: { key: SortKey; dir: "asc" | "desc" } | null;
  onToggleSort: (key: SortKey) => void;
  savingAssetId: string | null;
  makeFieldSaver: (
    id: string,
    field: keyof UpdateAssetInput,
  ) => (next: string | null) => void | Promise<void>;
  loading: boolean;
}) {
  return (
    <div className="assets-section__table-wrap">
      <table className="assets-section__table">
        <thead>
          <tr>
            <th className="assets-section__th-check">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                ref={(el) => {
                  // Indeterminate is a DOM property, not an attribute — React
                  // cannot set it declaratively.
                  if (el) el.indeterminate = someSelected && !allVisibleSelected;
                }}
                onChange={onToggleAll}
                aria-label="Select every row in view"
              />
            </th>
            {COLUMNS.map(([key, label]) => (
              <th
                key={key}
                className="assets-section__th-sortable"
                onClick={() => onToggleSort(key)}
                title={`Sort by ${label}`}
              >
                {label}
                <span className="assets-section__sort-mark">
                  {sort?.key === key ? (sort.dir === "asc" ? "▲" : "▼") : ""}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {assets.map((a) => {
            const color = sfiColorForGroup(groupCode(a));
            const active = a.id === selectedAssetId;
            const hasManual = (a.manualCount ?? 0) > 0;
            const hasMetric = (a.metricCount ?? 0) > 0;
            const coverage =
              hasManual && hasMetric
                ? "full"
                : hasManual || hasMetric
                  ? "partial"
                  : "none";
            return (
              <tr
                key={a.id}
                className={
                  [
                    active ? "assets-section__row--active" : "",
                    `assets-section__row--cov-${coverage}`,
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                title={`Manual: ${a.manualCount ?? 0} · Metrics: ${a.metricCount ?? 0}`}
                onClick={() => onSelectAsset(a.id)}
              >
                <td
                  className="assets-section__cell-check"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(a.id)}
                    onChange={() => onToggleRow(a.id)}
                    aria-label={`Select ${a.assetIdInternal}`}
                  />
                </td>
                <td className="assets-section__cell-mono">
                  <span
                    className="assets-section__row-dot"
                    style={{ background: color }}
                  />
                  <EditableCell
                    value={a.assetIdInternal}
                    saving={savingAssetId === a.id}
                    onSave={makeFieldSaver(a.id, "assetIdInternal")}
                  />
                </td>
                <td className="assets-section__cell-name">
                  <EditableCell
                    value={a.displayName}
                    saving={savingAssetId === a.id}
                    onSave={makeFieldSaver(a.id, "displayName")}
                  />
                </td>
                <td>
                  <EditableCell
                    value={a.brand}
                    saving={savingAssetId === a.id}
                    onSave={makeFieldSaver(a.id, "brand")}
                  />
                </td>
                <td>
                  <EditableCell
                    value={a.model}
                    saving={savingAssetId === a.id}
                    onSave={makeFieldSaver(a.id, "model")}
                  />
                </td>
                <td className="assets-section__cell-loc">
                  <EditableCell
                    value={a.location}
                    saving={savingAssetId === a.id}
                    onSave={makeFieldSaver(a.id, "location")}
                  />
                </td>
              </tr>
            );
          })}
          {assets.length === 0 && !loading && (
            <tr>
              <td
                colSpan={6}
                className="assets-section__placeholder"
                style={{ padding: "32px 16px" }}
              >
                No assets match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
