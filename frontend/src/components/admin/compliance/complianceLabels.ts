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

/** HTML input type for an archetype field datatype. */
export function inputTypeFor(datatype: string): string {
  return datatype === "date"
    ? "date"
    : datatype === "int" || datatype === "number"
      ? "number"
      : "text";
}
