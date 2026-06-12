/**
 * Lightweight token-overlap scorer used by `find_metrics_by_intent`,
 * `find_assets_by_function`, and the `asset_query` paths of `find_pms_due`
 * + `find_running_hours`.
 */

const STOP_WORDS = new Set([
  // English
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'of', 'in',
  'on', 'at', 'to', 'for', 'with', 'and', 'or', 'as', 'by', 'this', 'that',
  'these', 'those', 'it', 'its', 'value', 'metric',
  // Russian
  'и', 'в', 'на', 'с', 'у', 'или', 'из', 'к', 'по', 'для', 'не', 'что',
  'это', 'ли', 'же', 'есть', 'был', 'была',
  // Italian (Med-region crew language)
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'da', 'in',
  'su', 'con', 'per', 'tra', 'fra', 'e', 'o', 'ma', 'che', 'è', 'sono',
  'era', 'erano', 'sta', 'questa', 'questo', 'quella', 'quello', 'al',
  'del', 'dei', 'della', 'delle', 'nel', 'nella',
  // French (Med-region crew language)
  'le', 'les', 'un', 'une', 'des', 'de', 'du', 'la', 'et', 'ou', 'que',
  'qui', 'quoi', 'est', 'sont', 'était', 'étaient', 'avec', 'sans', 'dans',
  'sur', 'pour', 'par', 'au', 'aux', 'ce', 'cette', 'ces', 'ceci', 'cela',
]);

export function tokenizeForSearch(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t)),
  );
}
