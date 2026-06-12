import { AssetEntity } from '../../assets/entities/asset.entity';
import { AssetCandidate } from './metric-understanding.types';

/**
 * Pre-filter the 1500+ asset list down to a manageable shortlist (~20-50)
 * that's plausibly relevant to the metric being analyzed. Keeps the LLM
 * prompt bounded and the cost low.
 *
 * Strategy is cheap-and-cheerful:
 *   1. Score each asset by token-overlap with the measurement+field.
 *   2. Always include the side (PS/SB) sibling and parent assets when the
 *      measurement encodes a side.
 *   3. Take the top-N scored, fall back to a uniform sample if scores are
 *      all zero (so the LLM still has something to pick from).
 */
export function buildAssetShortlist(
  measurement: string,
  field: string,
  assets: AssetEntity[],
  topN: number = 40,
): AssetCandidate[] {
  if (assets.length === 0) return [];
  if (assets.length <= topN) {
    return assets.map(toCandidate);
  }

  const measurementTokens = tokenize(measurement);
  const fieldTokens = tokenize(field);
  const sideHint = detectSide(measurement);

  const scored: Array<{ asset: AssetEntity; score: number }> = assets.map((a) => {
    let score = 0;
    const assetTokens = new Set<string>([
      ...tokenize(a.assetIdInternal),
      ...tokenize(a.displayName),
      ...tokenize(a.sfiSubName ?? ''),
      ...tokenize(a.brand ?? ''),
      ...tokenize(a.model ?? ''),
    ]);

    for (const t of measurementTokens) {
      if (assetTokens.has(t)) score += 2;
    }
    for (const t of fieldTokens) {
      if (assetTokens.has(t)) score += 1;
    }
    if (sideHint && assetTokens.has(sideHint)) score += 3;

    return { asset: a, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // If nothing matched, fall back to a uniform sample so the LLM has *some*
  // closed list to choose from (it will likely return "NONE" anyway).
  if (scored[0].score === 0) {
    return assets.slice(0, topN).map(toCandidate);
  }

  return scored.slice(0, topN).map((s) => toCandidate(s.asset));
}

function toCandidate(a: AssetEntity): AssetCandidate {
  return {
    asset_id_internal: a.assetIdInternal,
    display_name: a.displayName,
    sfi_sub_name: a.sfiSubName,
    brand: a.brand,
    model: a.model,
    location: a.location,
  };
}

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw && raw.length > 1) out.add(raw);
  }
  return out;
}

function detectSide(measurement: string): string | null {
  if (/-ps$/i.test(measurement) || /\bport\b/i.test(measurement)) return 'ps';
  if (/-sb$/i.test(measurement) || /\bstbd\b/i.test(measurement) || /\bstarboard\b/i.test(measurement)) {
    return 'sb';
  }
  return null;
}
