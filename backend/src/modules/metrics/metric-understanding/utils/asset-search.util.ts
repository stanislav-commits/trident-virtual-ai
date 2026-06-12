/**
 * Shared token-overlap asset scorer used by `find_assets_by_function`,
 * `find_pms_due`, and `find_running_hours`. Each scored field is a string we
 * already display on the asset card (id, name, SFI sub-name, brand, model,
 * notes, optional location).
 *
 * Scoring:
 *   +1.0 for every query token whose lowercased form appears as a discrete
 *        token in the haystack (after stop-word removal).
 *   +0.5 for every query token that appears as a substring of the joined
 *        lowercase haystack (catches partial matches like "MASE" inside
 *        "MASE-PS-GENSET").
 */

import { AssetEntity } from '../../../assets/entities/asset.entity';
import { tokenizeForSearch } from './text.util';

export interface AssetSearchHit {
  asset: AssetEntity;
  score: number;
  matched: string[];
}

export interface AssetSearchOptions {
  topN: number;
  includeLocation?: boolean;
}

export interface AssetSearchResult {
  /** Top N scored matches, sorted by descending score. */
  hits: AssetSearchHit[];
  /** Total number of assets that scored > 0 (before the topN slice). */
  totalMatches: number;
}

export function scoreAssetsByQuery(
  assets: AssetEntity[],
  query: string,
  opts: AssetSearchOptions,
): AssetSearchResult {
  const tokens = tokenizeForSearch(query);
  const includeLocation = opts.includeLocation !== false;

  const scored: AssetSearchHit[] = assets
    .map((a) => {
      const fields: string[] = [
        a.assetIdInternal,
        a.displayName,
        a.sfiSubName ?? '',
        a.brand ?? '',
        a.model ?? '',
        a.notes ?? '',
      ];
      if (includeLocation) fields.push(a.location ?? '');
      const haystack = fields.join(' ').toLowerCase();
      const haystackTokens = tokenizeForSearch(haystack);

      let score = 0;
      const matched: string[] = [];
      for (const t of tokens) {
        if (haystackTokens.has(t)) {
          score += 1;
          matched.push(t);
        }
        if (haystack.includes(t)) score += 0.5;
      }
      return { asset: a, score, matched };
    })
    .filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return { hits: scored.slice(0, opts.topN), totalMatches: scored.length };
}
