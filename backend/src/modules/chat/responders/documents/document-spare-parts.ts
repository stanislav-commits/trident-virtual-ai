/**
 * Supplemental spare-parts retrieval for replacement/service procedure asks.
 *
 * Such questions retrieve PROCEDURE chunks, but the part numbers live in a
 * separate "Spare Parts List" section of the manual that never ranks into
 * the procedure top-K (observed: Mase codes 913725/913722 at sim ~0.24 vs
 * procedure chunks ~0.34). For these questions we run one extra
 * parts-focused retrieval and merge its top chunks into the evidence, so
 * the answer can cite exact part codes.
 */

import { formatError } from '../../../../common/utils/error.utils';
import { Logger } from '@nestjs/common';
import { DocumentsService } from '../../../documents/documents.service';
import { DocumentRetrievalResponseDto } from '../../../documents/dto/document-retrieval-response.dto';
import { DocumentDocClass } from '../../../documents/enums/document-doc-class.enum';

const logger = new Logger('DocumentSpareParts');

/** True when the ask is a replacement/service/consumables procedure (RU or EN). */
export function isReplacementProcedureAsk(question: string): boolean {
  return /(заме[нт]|смен[аи]|обслуж|ремонт|запчаст|расходн|фильтр|импеллер|replace|replac|change|changing|service|servicing|overhaul|maintenance|filter|impeller|spare)/i.test(
    question,
  );
}

/**
 * Map the component nouns of the ask (RU or EN) to compact English search
 * terms. Passing the full verbose ask as the parts query diluted the
 * keywords and surfaced other equipment's catalogs; a tight "fuel filter"
 * + equipment hints query ranks the right Spare Parts List chunk first.
 */
export function extractComponentTerms(question: string): string[] {
  const map: Array<[RegExp, string]> = [
    [/топлив|fuel/i, 'fuel'],
    [/масл|\boil\b/i, 'oil'],
    [/воздуш|\bair\b/i, 'air'],
    [/фильтр|filter/i, 'filter'],
    [/импеллер|impeller/i, 'impeller'],
    [/рем[ея]н|belt/i, 'belt'],
    [/анод|anode/i, 'anode'],
    [/прокладк|gasket|seal/i, 'gasket'],
    [/насос|помп|pump/i, 'pump'],
    [/форсунк|injector/i, 'injector'],
    [/свеч|plug/i, 'plug'],
    [/мембран|membrane/i, 'membrane'],
  ];
  return map.filter(([re]) => re.test(question)).map(([, term]) => term);
}

/**
 * Run the parts-focused retrieval. Returns null when there is nothing to
 * search for or the retrieval fails/comes back empty — the caller then
 * just keeps the original evidence.
 */
/**
 * Equipment nouns (RU/EN) — the supplemental parts query needs the
 * EQUIPMENT anchor, not just the component: keyword search finds the
 * right manual via its title words ("...PS Genset SB Genset...").
 * Verified 2026-06-12: "fuel filter" alone or with brand alone misses the
 * Mase Spare Parts List chunk; component + equipment + brand ranks it #1.
 */
const EQUIPMENT_TERM_MAP: Array<[RegExp, string]> = [
  [/генсет|генератор|genset|generator/i, 'genset'],
  [/двигател|engine/i, 'engine'],
  [/опресн|watermaker/i, 'watermaker'],
  [/кондицион|chiller|hvac/i, 'chiller'],
  [/стирал|washing/i, 'washing machine'],
  [/кран|crane|davit/i, 'crane'],
  [/тендер|tender/i, 'tender'],
  [/стабилизатор|stabilizer/i, 'stabilizer'],
  [/якор|windlass|anchor/i, 'windlass'],
];

export function extractEquipmentTerms(question: string): string[] {
  return EQUIPMENT_TERM_MAP.filter(([re]) => re.test(question)).map(
    ([, term]) => term,
  );
}

export async function retrieveSparePartsEvidence(input: {
  documentsService: DocumentsService;
  shipId: string;
  equipmentTerms: string[];
  /** Brands resolved from the asset register (e.g. ["MASE", "Volvo Penta"]). */
  brandTerms?: string[];
  /**
   * RAGFlow document id of the manual the PROCEDURE evidence came from.
   * The spare parts catalog lives in the same document — id scoping is
   * fully deterministic (title matching broke on mojibake filenames).
   */
  sourceRagflowDocumentId?: string | null;
  subject: string;
}): Promise<DocumentRetrievalResponseDto | null> {
  // Inside a known source document the equipment/brand anchors are
  // redundant — the doc IS the right manual — and extra words only pull
  // procedure chunks above the catalog. Scoped: component nouns only
  // (verified: scoped "spare parts list part number code fuel filter"
  // ranks the catalog chunk #1 deterministically). Unscoped fallback keeps
  // the full anchor set.
  const componentTerms = input.sourceRagflowDocumentId
    ? extractComponentTerms(input.subject)
    : [
        ...extractComponentTerms(input.subject),
        ...extractEquipmentTerms(input.subject),
        ...(input.brandTerms ?? []),
      ];
  // Keep the query TIGHT. The router can emit 5-6 overlapping equipment
  // hints ("fuel filter", "fuel system", "filter housing", ...); joining
  // them all dilutes the keyword search and the actual Spare Parts List
  // chunk loses to other equipment's catalogs (observed 2026-06-12:
  // 6 hints -> air-dryer/condenser junk; 2 terms -> Mase chunk rank 1).
  // Use component nouns first, top up with hints only until ~4 unique
  // words, skipping hints that add no new words.
  const seen = new Set<string>();
  const picked: string[] = [];
  const candidates = input.sourceRagflowDocumentId
    ? componentTerms
    : [...componentTerms, ...input.equipmentTerms];
  for (const term of candidates) {
    const words = term.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.every((w) => seen.has(w))) continue;
    picked.push(term);
    words.forEach((w) => seen.add(w));
    if (seen.size >= 6) break;
  }
  const terms = picked.join(' ').trim();
  if (!terms) return null;

  logger.log(`Spare-parts supplemental query: "${terms}"`);
  try {
    const retrieval = await input.documentsService.search({
      shipId: input.shipId,
      question: `spare parts list part number code ${terms}`,
      assessmentQuestion: `${terms} part number`,
      candidateDocClasses: [DocumentDocClass.MANUAL],
      ...(input.sourceRagflowDocumentId
        ? { scopeRagflowDocumentIds: [input.sourceRagflowDocumentId] }
        : {}),
    });
    if (retrieval.results.length) {
      logger.log(
        `Spare-parts supplemental: ${retrieval.results.length} results; top: ${String(
          retrieval.results[0]?.snippet ?? '',
        ).slice(0, 70)}`,
      );
      return retrieval;
    }
    return null;
  } catch (error) {
    logger.warn(
      `Spare-parts supplemental retrieval failed: ${
        formatError(error)
      }`,
    );
    return null;
  }
}

/**
 * Append up to `limit` previously-unseen supplemental chunks to the
 * retrieval, re-ranked after the existing results.
 */
export function mergeSupplementalResults(
  retrieval: DocumentRetrievalResponseDto,
  supplemental: DocumentRetrievalResponseDto | null,
  limit = 4,
): DocumentRetrievalResponseDto {
  if (!supplemental) return retrieval;
  const seen = new Set(retrieval.results.map((r) => r.chunkId));
  let nextRank =
    retrieval.results.reduce((max, r) => Math.max(max, r.rank), 0) + 1;
  const extra = supplemental.results
    .filter((r) => !seen.has(r.chunkId))
    .slice(0, limit)
    .map((r) => ({
      ...r,
      rank: nextRank++,
      // Distinct evidence block: formatEvidenceItem prints `section`, so
      // the answer model sees these as the parts catalog, not more
      // procedure text — measurably raises part-number citation rate.
      section: 'SPARE PARTS CATALOG',
    }));
  if (!extra.length) return retrieval;
  return { ...retrieval, results: [...retrieval.results, ...extra] };
}
