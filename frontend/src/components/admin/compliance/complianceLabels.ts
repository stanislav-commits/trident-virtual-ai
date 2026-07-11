// Shared label/field helpers for the compliance surfaces (type row, doc modal,
// batch ingest modal) — one definition instead of three copies.

const ACRONYMS = new Set([
  "id", "imo", "gt", "hru", "coc", "stcw", "gmdss", "ecdis", "sea", "nc",
  "poa", "kyc", "vat", "mlc", "ism", "isps", "sdr", "nox",
]);

/** Backend keeps snake_case field keys; the UI shows a human label. */
export function prettyLabel(field: string): string {
  const cleaned = field.replace(/_id$/, "").replace(/[._]/g, " ");
  const out = cleaned
    .split(" ")
    .map((w) =>
      w
        .split("/")
        .map((p) => (ACRONYMS.has(p.toLowerCase()) ? p.toUpperCase() : p))
        .join("/"),
    )
    .join(" ");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * Map extracted / saved values onto the schema's field keys. The AI often keys
 * a compound schema field (e.g. `vessel_gt/imo/callsign/flag`) by its parts
 * (`vessel_gt`, `vessel_imo`), so gather those into the compound key instead of
 * losing them. Simple keys match exactly.
 */
export function foldToSchema(
  fieldKeys: string[],
  raw: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const k of fieldKeys) {
    if (raw[k] != null && raw[k] !== "") {
      out[k] = raw[k];
      used.add(k);
    }
  }
  for (const k of fieldKeys) {
    if (!k.includes("/") || out[k]) continue;
    const parts = k.split("/");
    const first = parts[0];
    const us = first.lastIndexOf("_");
    const prefix = us >= 0 ? first.slice(0, us + 1) : "";
    const comps = [first.slice(prefix.length), ...parts.slice(1)];
    const cand = new Set<string>();
    for (const c of comps) {
      cand.add(c);
      if (prefix) cand.add(prefix + c);
    }
    const pieces: string[] = [];
    for (const [rk, rv] of Object.entries(raw)) {
      if (used.has(rk) || rv == null || rv === "") continue;
      if (cand.has(rk)) {
        const label = prefix && rk.startsWith(prefix) ? rk.slice(prefix.length) : rk;
        pieces.push(`${label.toUpperCase()}: ${rv}`);
        used.add(rk);
      }
    }
    if (pieces.length) out[k] = pieces.join(", ");
  }
  return out;
}

/** ISO (yyyy-mm-dd…) → display dd/mm/yyyy; non-dates pass through. */
export function formatDateDMY(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** HTML input type for an archetype field datatype. */
export function inputTypeFor(datatype: string): string {
  return datatype === "date"
    ? "date"
    : datatype === "int" || datatype === "number"
      ? "number"
      : "text";
}
