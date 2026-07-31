import { BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import * as XLSXStyle from 'xlsx-js-style';
import { CreateAssetDto } from './dto/create-asset.dto';
import { AssetEntity } from './entities/asset.entity';
import { normalizeHeaderKey } from './assets.normalization';
import {
  isValidDeckRoleCode,
  isValidZoneCode,
} from './enums/asset-location-vocab';

/**
 * The register as a spreadsheet: reading one in, writing one out.
 *
 * Split out of AssetsService because this is a file format, not register
 * logic — the column names, the header sniffing, the per-cell coercion and the
 * styled sheet are one subject, and nothing here touches the database.
 *
 * The two directions must stay symmetric. Export, edit a column for 400 rows in
 * Excel, import — that loop is what the sheet is for, and a column written on
 * the way out but ignored on the way in silently discards the operator's work.
 */

// Map our DTO field → list of acceptable xlsx headers (case-insensitive,
// whitespace-trimmed match). Names below match the real Trident Asset
// Register format; we also accept some shorter aliases for hand-rolled files.
const COLUMN_ALIASES: Record<keyof CreateAssetDto, string[]> = {
  assetIdInternal:  ['asset_id_internal', 'asset id', 'asset_id', 'id', 'sfi_asset_id'],
  displayName:      ['display_name', 'name', 'asset name', 'description'],
  sfiGroup:         ['sfi_group', 'sfi group'],
  sfiGroupName:     ['sfi_group_name', 'sfi group name'],
  sfiSub:           ['sfi_sub', 'sfi sub', 'sfi_sub_group', 'sfi sub group'],
  sfiSubName:       ['sfi_sub_name', 'sfi sub name', 'sub-group', 'sub_group', 'sub group', 'category'],
  parentAssetId:    ['parent_asset_id', 'parent'],
  servedByAssetId:  ['served_by_asset_id', 'served by', 'served_by'],
  locationAssetId:  ['location_asset_id', 'located_in'],
  brand:            ['brand', 'manufacturer', 'mfr', 'oem', 'maker'],
  model:            ['model', 'type'],
  serialNo:         ['serial_no', 'serial', 'serial number', 'sn', 's/n'],
  criticality:      ['criticality', 'criticality_class'],
  commissionedDate: ['commissioned_date', 'install date', 'installation date', 'installed', 'commissioned'],
  location:         ['location', 'compartment'],
  department:       ['department', 'dept'],
  rinaRef:          ['rina_ref', 'class', 'class society', 'classification society'],
  notes:            ['notes', 'remark', 'remarks', 'comments'],
  // v14.6 location schema
  zone:                 ['zone'],
  deckRole:             ['deck_role', 'deck role'],
  deckLevel:            ['deck_level', 'deck level'],
  spaceInstance:        ['space_instance', 'space instance'],
  spaceLabel:           ['space_label', 'space label'],
  // Maintenance / drawings
  drawingRef:           ['drawing_ref', 'drawing', 'drawing ref'],
  drawingCode:          ['drawing_code', 'drawing code'],
  inspectionObligation: ['inspection_obligation', 'inspection', 'inspection obligation'],
  // Provenance
  parentAutoPopulated:      ['parent_auto_populated', 'parent auto populated'],
  criticalityAutoPopulated: ['criticality_auto_populated', 'criticality auto populated'],
  sourceSheet:              ['tab', 'source_sheet', 'sheet'],
  // Catch-all (importer fills this from non-canonical columns; the xlsx
  // doesn't have a single "extras" column to map directly)
  extras: [],
};

// Non-canonical (not in v14.6) columns that go into the JSONB `extras`
// bucket as-is. Stored under the original snake_case header so they
// stay greppable. Anything not in COLUMN_ALIASES *and* not here is
// silently dropped during import.
const EXTRAS_COLUMNS = [
  'asset_voltage_class',
  'served_by_emergency',
  'governing_certs',
  'linked_to_asset_id',
  'id_source',
  'required_minimum_quantity',
  'batch_number',
  'kit_contents_summary',
  'drug_schedule',
  'asset_full_locator', // we recompute this but keep the import-time value
  'zone_name',          // some templates carry the long label alongside the code
];

// xlsx sheet we read for the bulk register. The Trident template puts a
// banner in row 1 and the actual header row in row 2 — sheet_to_json with
// `range: 1` skips the banner.
const REGISTER_SHEET_NAME = 'Asset Register';

// SFI top-level group → export row fill (a light tint of the app's group
// colour, kept pale so the black text stays readable). Renumbered -1 scheme,
// mirrors frontend sfi-colors.ts.
const GROUP_ROW_FILL: Record<string, string> = {
  '1': 'DCE9F7',
  '2': 'D8F0E0',
  '3': 'F6E1D0',
  '4': 'ECDCF4',
  '5': 'F4EAD1',
  '6': 'CCF0F7',
  '7': 'F7D2DA',
  '8': 'E1E1FF',
  '9': 'CCF6F1',
  '10': 'FADCEF',
  '11': 'F6E4D0',
  '12': 'FFE0F0',
  '13': 'E4F4D5',
  '14': 'FBEAE0',
  '15': 'DCEDF8',
  '16': 'E7ECF3',
  '17': 'E6EBF3',
  '18': 'E3EAF2',
  '19': 'E0E8F1',
  '20': 'DDE5EF',
};

/** ExcelJS/xlsx-js-style solid fill for an SFI group, or null (no tint). */
function groupRowFill(group: string | null): { fgColor: { rgb: string } } | null {
  if (!group) return null;
  const key = String(group).trim().split('.')[0].replace(/^0/, '');
  const rgb = GROUP_ROW_FILL[key];
  return rgb ? { fgColor: { rgb } } : null;
}

/**
 * Natural compare of dotted asset IDs so groups/subs sort numerically:
 * SWX.2.11.01 < SWX.10.1.01 (a plain string sort put "10" before "2").
 * Splits each id into number / non-number tokens and compares in order.
 */
export function naturalCompareIds(a: string, b: string): number {
  const tok = (s: string) =>
    (s.match(/\d+|\D+/g) ?? []).map((t) => (/^\d+$/.test(t) ? Number(t) : t));
  const ta = tok(a);
  const tb = tok(b);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else {
      const cmp = String(x).localeCompare(String(y));
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

function looksLikeRegisterHeader(row: Record<string, unknown>): boolean {
  const keys = Object.keys(row).map((k) => k.toLowerCase());
  return (
    keys.includes('asset_id_internal') ||
    keys.includes('display_name') ||
    keys.some((k) => k.includes('sfi'))
  );
}

function buildHeaderResolver(
  sampleKeys: string[],
): Partial<Record<keyof CreateAssetDto, string>> {
  const norm = normalizeHeaderKey;
  const lookup: Record<string, string> = {};
  for (const k of sampleKeys) lookup[norm(k)] = k;

  const resolved: Partial<Record<keyof CreateAssetDto, string>> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [
    keyof CreateAssetDto,
    string[],
  ][]) {
    const hit = aliases.map(norm).find((a) => lookup[a]);
    if (hit) resolved[field] = lookup[hit];
  }
  return resolved;
}

export function mapRowToDraft(
  row: Record<string, unknown>,
  resolver: Partial<Record<keyof CreateAssetDto, string>>,
): Partial<CreateAssetDto> {
  const get = (field: keyof CreateAssetDto): string | undefined => {
    const key = resolver[field];
    if (!key) return undefined;
    const v = row[key];
    if (v == null) return undefined;
    const s = String(v).trim();
    return s.length > 0 ? s : undefined;
  };

  const rawCriticality = get('criticality');
  let criticality: number | undefined;
  if (rawCriticality !== undefined) {
    const parsed = Number(rawCriticality);
    if (Number.isFinite(parsed)) {
      const rounded = Math.round(parsed);
      if (rounded >= 1 && rounded <= 5) criticality = rounded;
    }
  }

  // commissioned_date may come in as a Date instance (cellDates: true) or
  // a string. Normalize to YYYY-MM-DD or undefined.
  let commissionedDate: string | undefined;
  const rawDateKey = resolver.commissionedDate;
  if (rawDateKey && row[rawDateKey] instanceof Date) {
    commissionedDate = (row[rawDateKey] as Date).toISOString().slice(0, 10);
  } else if (rawDateKey && row[rawDateKey] != null) {
    const s = String(row[rawDateKey]).trim();
    if (s.length > 0) {
      const d = new Date(s);
      commissionedDate = Number.isFinite(d.valueOf())
        ? d.toISOString().slice(0, 10)
        : undefined;
    }
  }

  // ── v14.6 location fields ──
  // Validate zone + deck_role against the controlled vocab; unknown
  // codes are dropped (not stored) so chat queries can rely on the
  // value being one of the canonical 15 / 16 codes.
  const rawZone = get('zone')?.toUpperCase();
  const zone = rawZone && isValidZoneCode(rawZone) ? rawZone : undefined;
  const rawDeck = get('deckRole')?.toUpperCase();
  const deckRole = rawDeck && isValidDeckRoleCode(rawDeck) ? rawDeck : undefined;
  const rawDeckLevel = get('deckLevel');
  let deckLevel: number | undefined;
  if (rawDeckLevel !== undefined) {
    const n = Number(rawDeckLevel);
    if (Number.isFinite(n)) deckLevel = Math.round(n);
  }

  // ── provenance booleans (xlsx writes "TRUE"/"FALSE" as strings) ──
  const parseBool = (s: string | undefined): boolean | undefined => {
    if (!s) return undefined;
    const t = s.toLowerCase();
    if (t === 'true' || t === 'yes' || t === '1') return true;
    if (t === 'false' || t === 'no' || t === '0') return false;
    return undefined;
  };

  // ── extras bucket ──
  // Read EXTRAS_COLUMNS by their raw header (case-insensitive) and
  // pack everything non-null into a single object. Empty → undefined
  // so we don't store `{}` rows.
  const norm = normalizeHeaderKey;
  const rowKeysByNorm: Record<string, string> = {};
  for (const k of Object.keys(row)) rowKeysByNorm[norm(k)] = k;
  const extras: Record<string, unknown> = {};
  for (const col of EXTRAS_COLUMNS) {
    const realKey = rowKeysByNorm[norm(col)];
    if (!realKey) continue;
    const v = row[realKey];
    if (v == null) continue;
    const s = String(v).trim();
    if (s.length === 0) continue;
    extras[col] = s;
  }

  // sfi_group comes in as wildly inconsistent strings across spreadsheet
  // versions: "2", "2.0", "02" all mean group 2. Some rows in the v6.20
  // file even leak the sub-code ("4.1" in sfi_group when it should be
  // "4"). Without normalization they end up as separate rows in the
  // admin sidebar / chat group-filter and "all subgroups appear mixed
  // up". Canonicalize to a plain integer string ("2", "10", "21") by
  // taking the leading integer part. sfi_sub keeps its dotted form —
  // it's the meaningful hierarchy unit there.
  const normalizeSfiGroup = (s: string | undefined): string | undefined => {
    if (s === undefined) return undefined;
    const trimmed = s.trim();
    if (!trimmed) return undefined;
    const m = trimmed.match(/^0*(\d+)/);
    return m ? m[1] : trimmed;
  };

  // When sfi_sub looks like "10.2" but sfi_group says "9", trust the
  // sub. The v6.20 file has a known cluster of rows where sfi_group is
  // typo'd but sfi_sub is correct, and these end up scattered across
  // wrong tabs in the UI. sfi_sub-derived group also matches the
  // asset_id_internal prefix in practice.
  const rawGroup = normalizeSfiGroup(get('sfiGroup'));
  const rawSub = get('sfiSub');
  const subLeading = rawSub?.match(/^0*(\d+)/)?.[1];
  const sfiGroup = subLeading ?? rawGroup;

  return {
    assetIdInternal: get('assetIdInternal'),
    displayName: get('displayName'),
    sfiGroup,
    sfiGroupName: get('sfiGroupName'),
    sfiSub: rawSub,
    sfiSubName: get('sfiSubName'),
    parentAssetId: get('parentAssetId'),
    servedByAssetId: get('servedByAssetId'),
    locationAssetId: get('locationAssetId'),
    brand: get('brand'),
    model: get('model'),
    serialNo: get('serialNo'),
    criticality,
    commissionedDate,
    location: get('location'),
    department: get('department'),
    rinaRef: get('rinaRef'),
    notes: get('notes'),
    zone,
    deckRole,
    deckLevel,
    spaceInstance: get('spaceInstance'),
    spaceLabel: get('spaceLabel'),
    drawingRef: get('drawingRef'),
    drawingCode: get('drawingCode'),
    inspectionObligation: get('inspectionObligation'),
    parentAutoPopulated: parseBool(get('parentAutoPopulated')),
    criticalityAutoPopulated: parseBool(get('criticalityAutoPopulated')),
    sourceSheet: get('sourceSheet'),
    extras: Object.keys(extras).length > 0 ? extras : undefined,
  };
}

/**
 * Build the register workbook. Writes the canonical "Asset Register" sheet
 * (banner row 0, header row 1, data row 2+) using the primary COLUMN_ALIASES
 * names so the file round-trips back through import. Non-canonical `extras`
 * keys are flattened into their own columns (union across all assets).
 */
export function buildRegisterWorkbook(
  shipName: string,
  assets: AssetEntity[],
): { buffer: Buffer; filename: string } {
  // Natural numeric order by SFI group → sub → sequence, so the sheet reads
  // 1, 2 … 20 (a plain string sort put "SWX.10" before "SWX.2" and
  // "sub 10" before "sub 2" — that is the "table starts at 10" bug).
  assets.sort((a, b) =>
    naturalCompareIds(a.assetIdInternal, b.assetIdInternal),
  );

  // Register standard columns only. Dropped: criticality,
  // commissioned_date, location_asset_id, rina_ref and the v14.6 location
  // fields (zone/deck_role/deck_level/space_*) and inspection_obligation —
  // all retired / empty and never part of the agreed register format.
  //
  // Every column here is also READ back by mapRowToDraft. That symmetry is
  // the point of the sheet: export, edit a column for 400 rows in Excel,
  // import. A column the export writes and the import ignores silently
  // discards the operator's work — which is what sfi_group_name and
  // drawing_code did until they were added to the draft mapping.
  const COLUMNS: Array<[string, (a: AssetEntity) => unknown]> = [
    ['asset_id_internal', (a) => a.assetIdInternal],
    ['display_name', (a) => a.displayName],
    ['sfi_group', (a) => a.sfiGroup],
    ['sfi_group_name', (a) => a.sfiGroupName],
    ['sfi_sub', (a) => a.sfiSub],
    ['sfi_sub_name', (a) => a.sfiSubName],
    ['parent_asset_id', (a) => a.parentAssetId],
    ['served_by_asset_id', (a) => a.servedByAssetId],
    ['brand', (a) => a.brand],
    ['model', (a) => a.model],
    ['serial_no', (a) => a.serialNo],
    ['location', (a) => a.location],
    ['department', (a) => a.department],
    ['drawing_ref', (a) => a.drawingRef],
    ['drawing_code', (a) => a.drawingCode],
    ['notes', (a) => a.notes],
  ];

  // Spill custom (non-canonical) attrs, but never re-emit a key that is
  // already a standard column — some imports stashed canonical names
  // (drawing_code, sfi_group_name…) into extras, which duplicated columns.
  const canonical = new Set(COLUMNS.map(([h]) => h));
  const extrasKeys = new Set<string>();
  for (const a of assets) {
    if (a.extras) {
      for (const k of Object.keys(a.extras)) {
        if (!canonical.has(k)) extrasKeys.add(k);
      }
    }
  }
  const extrasCols = Array.from(extrasKeys).sort();

  const header = [...COLUMNS.map(([h]) => h), ...extrasCols];
  const banner = `Asset Register export · ${shipName} · ${assets.length} assets · ${new Date()
    .toISOString()
    .slice(0, 10)}`;

  const aoa: unknown[][] = [[banner], header];
  for (const a of assets) {
    const row: unknown[] = COLUMNS.map(([, get]) => get(a) ?? '');
    const extras = (a.extras ?? {}) as Record<string, unknown>;
    for (const k of extrasCols) row.push(extras[k] ?? '');
    aoa.push(row);
  }

  const ws = XLSXStyle.utils.aoa_to_sheet(aoa);
  const colCount = header.length;

  // Header row (row index 1) — bold. Data rows tinted by SFI group so the
  // register reads at a glance, matching the app's group colours.
  for (let c = 0; c < colCount; c++) {
    const headerCell = ws[XLSXStyle.utils.encode_cell({ r: 1, c })];
    if (headerCell) headerCell.s = { font: { bold: true } };
  }
  assets.forEach((a, i) => {
    const fill = groupRowFill(a.sfiGroup);
    if (!fill) return;
    const r = i + 2; // banner + header offset
    for (let c = 0; c < colCount; c++) {
      const cell = ws[XLSXStyle.utils.encode_cell({ r, c })];
      if (cell) cell.s = { ...(cell.s ?? {}), fill };
    }
  });
  // Column widths for readability.
  ws['!cols'] = header.map((h) => ({ wch: Math.max(12, h.length + 2) }));

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, REGISTER_SHEET_NAME);
  const buffer = XLSXStyle.write(wb, {
    type: 'buffer',
    bookType: 'xlsx',
  }) as Buffer;

  const safeName = shipName.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
  const filename = `${safeName || 'asset_register'}_${new Date()
    .toISOString()
    .slice(0, 10)}.xlsx`;
  return { buffer, filename };
}

/**
 * Parse an xlsx buffer into validated drafts + structural errors — no database
 * access at all. Used by both /preview (to show the diff) and /commit (which
 * then applies the drafts).
 */
export function parseXlsxToDrafts(buffer: Buffer): {
  drafts: Array<{ rowNum: number; draft: Partial<CreateAssetDto> }>;
  parseErrors: Array<{ row: number; reason: string }>;
  totalRows: number;
} {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (err) {
    throw new BadRequestException(
      `Could not parse xlsx: ${(err as Error).message}`,
    );
  }
  if (workbook.SheetNames.length === 0) {
    throw new BadRequestException('xlsx has no sheets');
  }
  const targetSheetName =
    workbook.SheetNames.find((n) => n === REGISTER_SHEET_NAME) ??
    workbook.SheetNames[0];
  const sheet = workbook.Sheets[targetSheetName];

  let rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    range: 1,
    defval: null,
    raw: false,
  });
  if (rows.length === 0 || !looksLikeRegisterHeader(rows[0])) {
    rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: null,
      raw: false,
    });
  }

  if (rows.length === 0) {
    return { drafts: [], parseErrors: [], totalRows: 0 };
  }

  const resolveHeader = buildHeaderResolver(Object.keys(rows[0] ?? {}));
  const drafts: Array<{ rowNum: number; draft: Partial<CreateAssetDto> }> = [];
  const parseErrors: Array<{ row: number; reason: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 3; // banner row 1 + header row 2 + 1-based
    const draft = mapRowToDraft(rows[i], resolveHeader);

    // Banner / spacer rows — silently skip.
    if (!draft.assetIdInternal && !draft.displayName) continue;

    if (!draft.assetIdInternal || !draft.displayName) {
      parseErrors.push({
        row: rowNum,
        reason: 'Missing required column "asset_id_internal" or "display_name"',
      });
      continue;
    }

    drafts.push({ rowNum, draft });
  }

  return { drafts, parseErrors, totalRows: rows.length };
}
