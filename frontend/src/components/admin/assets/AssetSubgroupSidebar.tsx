import type { RefObject } from "react";
import type { SfiNode } from "../../../hooks/admin/useAssetRegisterView";
import { GROUP_ALL } from "../../../hooks/admin/useAssetRegisterView";

/**
 * Search box plus the sub-groups of whichever system is in focus.
 *
 * The search field is the one the Cmd+K shortcut lands on, so it takes a ref
 * from the section rather than owning one.
 */
export function AssetSubgroupSidebar({
  search,
  onSearchChange,
  searchInputRef,
  searchActive,
  matchCount,
  groupCount,
  selectedGroup,
  subgroups,
  selectedSub,
  onSelectSub,
  groupTotal,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchActive: boolean;
  matchCount: number;
  groupCount: number;
  selectedGroup: string;
  subgroups: SfiNode[];
  selectedSub: string | null;
  onSelectSub: (code: string | null) => void;
  groupTotal: number;
}) {
  return (
    <aside className="assets-section__sidebar">
      <div className="assets-section__sidebar-search">
        <input
          ref={searchInputRef}
          type="search"
          className="assets-section__sidebar-input"
          placeholder="Search vessel (Cmd+K)…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && search) {
              e.preventDefault();
              onSearchChange("");
            }
          }}
        />
        {search && (
          <button
            type="button"
            className="assets-section__sidebar-clear"
            onClick={() => onSearchChange("")}
            title="Clear search (Esc)"
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>
      {searchActive && (
        <div className="assets-section__search-hint">
          {matchCount} match{matchCount === 1 ? "" : "es"} across {groupCount}{" "}
          group{groupCount === 1 ? "" : "s"}
        </div>
      )}
      <div className="assets-section__sidebar-section">
        <div className="assets-section__sidebar-head">
          Focused hierarchy{" "}
          <span className="assets-section__sidebar-head-tag">
            {selectedGroup === GROUP_ALL ? "all" : selectedGroup}
          </span>
        </div>
        <button
          type="button"
          className={`assets-section__sub ${selectedSub === null ? "assets-section__sub--active" : ""}`}
          onClick={() => onSelectSub(null)}
        >
          <span className="assets-section__sub-code">—</span>
          <span className="assets-section__sub-name">
            All in{" "}
            {selectedGroup === GROUP_ALL ? "vessel" : `group ${selectedGroup}`}
          </span>
          <span className="assets-section__sub-count">{groupTotal}</span>
        </button>
        {subgroups.map((s) => (
          <button
            key={s.code}
            type="button"
            className={`assets-section__sub ${s.code === selectedSub ? "assets-section__sub--active" : ""}`}
            onClick={() => onSelectSub(s.code)}
          >
            <span className="assets-section__sub-code">{s.code}</span>
            <span className="assets-section__sub-name" title={s.name}>
              {s.name}
            </span>
            <span className="assets-section__sub-count">{s.count}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
