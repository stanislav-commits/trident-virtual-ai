import { ChatTurnPlanAsk } from '../planning/chat-turn-plan.types';
import { ChatTurnAskResult } from '../responders/interfaces/chat-turn-responder.types';

interface DocumentWebQueryContext {
  manufacturer: string | null;
  model: string | null;
  equipment: string | null;
  purpose: string | null;
  freshness: boolean;
  supportingBrand: string | null;
  residualFocus: string[];
}

export function buildDocumentFallbackWebQuery(input: {
  ask: ChatTurnPlanAsk;
  documentResult?: ChatTurnAskResult | null;
}): string {
  const context = buildDocumentWebQueryContext(input);
  const manufacturerPart =
    context.manufacturer &&
    context.model
      ?.toLocaleLowerCase()
      .includes(context.manufacturer.toLocaleLowerCase())
      ? null
      : context.manufacturer;
  const queryParts = [
    manufacturerPart,
    context.model,
    ...context.residualFocus,
    context.equipment,
    context.purpose,
    context.freshness ? 'latest revision' : null,
    context.supportingBrand,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim());
  const contextualQuery = dedupePhrases(queryParts).join(' ').trim();

  return contextualQuery || normalizeSearchText(input.ask.question);
}

function buildDocumentWebQueryContext(input: {
  ask: ChatTurnPlanAsk;
  documentResult?: ChatTurnAskResult | null;
}): DocumentWebQueryContext {
  const askText = collectAskText(input.ask);
  const documentText = collectDocumentResultText(input.documentResult);
  const combinedText = [askText, documentText].filter(Boolean).join(' ');
  const askModel = extractModel(askText);
  const documentModel = extractModel(documentText);
  const askManufacturer = extractManufacturer(askText, askModel);
  const documentManufacturer = extractManufacturer(documentText, documentModel);
  const manufacturer = askManufacturer ?? documentManufacturer;
  const model = askModel ?? documentModel;
  const equipment = extractEquipment(combinedText, manufacturer, model);
  const purpose = extractDocumentPurpose(askText, combinedText);
  const freshness = hasFreshnessIntent(askText);

  return {
    manufacturer,
    model,
    equipment,
    purpose,
    freshness,
    supportingBrand: buildSupportingBrand(manufacturer),
    residualFocus: buildResidualFocus(input.ask.question, {
      manufacturer,
      model,
      equipment,
      purpose,
    }),
  };
}

function collectAskText(ask: ChatTurnPlanAsk): string {
  const documentsRoute = ask.semanticRoute.documents;

  return [
    ask.question,
    documentsRoute.documentTitleHint,
    documentsRoute.retrievalQuery,
    ...documentsRoute.manufacturerHints,
    ...documentsRoute.modelHints,
    ...documentsRoute.equipmentOrSystemHints,
    ...documentsRoute.contentFocusHints,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(normalizeSearchText)
    .join(' ');
}

function collectDocumentResultText(
  result?: ChatTurnAskResult | null,
): string {
  if (!result) {
    return '';
  }

  const contextReferences = Array.isArray(result.contextReferences)
    ? result.contextReferences
    : [];
  const referenceText = contextReferences
    .flatMap((reference) => {
      if (!reference || typeof reference !== 'object') {
        return [];
      }

      const entry = reference as Record<string, unknown>;

      return [
        typeof entry.sourceTitle === 'string' ? entry.sourceTitle : null,
        typeof entry.snippet === 'string' ? entry.snippet : null,
      ];
    })
    .filter((value): value is string => Boolean(value?.trim()));
  const webQueryContextText = collectWebQueryContextText(result.data);

  return [
    result.question,
    result.summary,
    ...referenceText,
    ...webQueryContextText,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(normalizeSearchText)
    .join(' ');
}

function collectWebQueryContextText(
  data?: Record<string, unknown> | null,
): string[] {
  if (!data?.retrieval || typeof data.retrieval !== 'object') {
    return [];
  }

  const retrieval = data.retrieval as Record<string, unknown>;
  const contexts = Array.isArray(retrieval.webQueryContext)
    ? retrieval.webQueryContext
    : [];

  return contexts
    .flatMap((context) => {
      if (!context || typeof context !== 'object') {
        return [];
      }

      const entry = context as Record<string, unknown>;
      const metadata =
        entry.metadataSummary && typeof entry.metadataSummary === 'object'
          ? (entry.metadataSummary as Record<string, unknown>)
          : null;

      return [
        typeof entry.sourceTitle === 'string' ? entry.sourceTitle : null,
        typeof entry.snippet === 'string' ? entry.snippet : null,
        metadata && typeof metadata.equipmentOrSystem === 'string'
          ? metadata.equipmentOrSystem
          : null,
        metadata && typeof metadata.manufacturer === 'string'
          ? metadata.manufacturer
          : null,
        metadata && typeof metadata.model === 'string' ? metadata.model : null,
        metadata && typeof metadata.contentFocus === 'string'
          ? metadata.contentFocus
          : null,
      ];
    })
    .filter((value): value is string => Boolean(value?.trim()));
}

function extractManufacturer(text: string, model: string | null): string | null {
  const normalized = text.toLocaleLowerCase();

  if (model?.toLocaleLowerCase().startsWith('vs ')) {
    return 'MASE';
  }

  if (model === 'Volvo Penta D13') {
    return 'Volvo Penta';
  }

  if (/\bvolvo\s+penta\b/u.test(normalized)) {
    return 'Volvo Penta';
  }

  if (/\bmase\b/u.test(normalized)) {
    return 'MASE';
  }

  return null;
}

function extractModel(text: string): string | null {
  const maseVsModel = text.match(/\bvs\s*[-_ ]?\s*(\d{2,4})\s*(sv|vls)?\b/iu);

  if (
    maseVsModel?.[1] &&
    (/\bmase\b/iu.test(text) || /\b(?:generator|genset|gen\s*set)\b/iu.test(text))
  ) {
    return ['VS', maseVsModel[1], maseVsModel[2]?.toUpperCase()]
      .filter(Boolean)
      .join(' ');
  }

  const volvoPentaD13 = text.match(/\bvolvo\s+penta\s+d13\b/iu)?.[0];

  if (volvoPentaD13) {
    return 'Volvo Penta D13';
  }

  if (/\bvolvo\b/iu.test(text) && /\bd13\b/iu.test(text)) {
    return 'Volvo Penta D13';
  }

  if (maseVsModel?.[1]) {
    return ['VS', maseVsModel[1], maseVsModel[2]?.toUpperCase()]
      .filter(Boolean)
      .join(' ');
  }

  return null;
}

function extractEquipment(
  text: string,
  manufacturer: string | null,
  model: string | null,
): string | null {
  const normalized = text.toLocaleLowerCase();

  if (
    manufacturer === 'Volvo Penta' &&
    model?.toLocaleLowerCase().includes('d13')
  ) {
    return null;
  }

  if (/\b(?:generator|genset|gen\s*set)\b/u.test(normalized)) {
    return 'generator';
  }

  return null;
}

function extractDocumentPurpose(askText: string, combinedText: string): string {
  const normalizedAsk = askText.toLocaleLowerCase();
  const normalizedCombined = combinedText.toLocaleLowerCase();

  if (/\bservice\s+manual\b/u.test(normalizedAsk)) {
    return 'service manual';
  }

  if (/\b(?:use|maintenance|installation)\b/u.test(normalizedCombined)) {
    return 'use maintenance installation manual';
  }

  return 'manual';
}

function buildSupportingBrand(manufacturer: string | null): string | null {
  if (manufacturer === 'MASE') {
    return 'Mase Generators';
  }

  return null;
}

function buildResidualFocus(
  question: string,
  context: {
    manufacturer: string | null;
    model: string | null;
    equipment: string | null;
    purpose: string | null;
  },
): string[] {
  const normalized = normalizeSearchText(question);

  // Generic equipment/purpose terms do not replace the user's requested subject.
  if (context.manufacturer || context.model) {
    return [];
  }

  return [stripGenericOperationalAliases(normalized)].filter(Boolean);
}

function hasFreshnessIntent(text: string): boolean {
  return /\b(?:latest|newest|most\s+recent|up[-\s]?to[-\s]?date|current\s+(?:external|online|web|public)?\s*(?:version|info|information|manual)?|online\s+version|latest\s+revision)\b/iu.test(
    text,
  );
}

function stripGenericOperationalAliases(text: string): string {
  return text
    .replace(
      /\b(?:port|starboard|ps|sb)\s+(?:side\s+)?(?:generator|genset|gen\s*set)\b/giu,
      'generator',
    )
    .replace(/\b(?:ps|sb)\s+(?:genset|gen\s*set)\b/giu, 'generator')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupePhrases(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const normalizedKey = value.toLocaleLowerCase();

    if (!normalizedKey || seen.has(normalizedKey)) {
      continue;
    }

    seen.add(normalizedKey);
    deduped.push(value);
  }

  return deduped;
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/(?:â|â€“|[_\u2013\u2014])/g, ' ')
    .replace(/\.[a-z0-9]{2,5}\b/giu, ' ')
    .replace(/[^\p{L}\p{N}/+-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
