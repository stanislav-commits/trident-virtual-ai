import type { SfiNode } from "../../../hooks/admin/useAssetRegisterView";
import { GROUP_ALL } from "../../../hooks/admin/useAssetRegisterView";
import { sfiColorForGroup } from "./sfi-colors";

/**
 * The vessel's systems, across the top. Counts follow the active search, so a
 * tab reads "13 matches in group 7" rather than its unhelpful global total.
 */
export function AssetGroupTabs({
  groups,
  selectedGroup,
  totalCount,
  onSelect,
}: {
  groups: SfiNode[];
  selectedGroup: string;
  totalCount: number;
  onSelect: (code: string) => void;
}) {
  return (
    <nav className="assets-section__tabs" aria-label="SFI groups">
      <button
        type="button"
        className={`assets-section__tab ${
          selectedGroup === GROUP_ALL ? "assets-section__tab--active" : ""
        }`}
        style={{ ["--tab-color" as never]: "#94A3B8" }}
        onClick={() => onSelect(GROUP_ALL)}
      >
        <span className="assets-section__tab-code">ALL</span>
        <span className="assets-section__tab-name">All systems</span>
        <span className="assets-section__tab-meta">{totalCount} assets</span>
      </button>
      {groups.map((g) => {
        const active = g.code === selectedGroup;
        return (
          <button
            key={g.code}
            type="button"
            className={`assets-section__tab ${active ? "assets-section__tab--active" : ""}`}
            style={{ ["--tab-color" as never]: sfiColorForGroup(g.code) }}
            onClick={() => onSelect(g.code)}
          >
            <span className="assets-section__tab-code">
              {g.code.padStart(2, "0")}
            </span>
            <span className="assets-section__tab-name" title={g.name}>
              {g.name}
            </span>
            <span className="assets-section__tab-meta">{g.count} assets</span>
          </button>
        );
      })}
    </nav>
  );
}
