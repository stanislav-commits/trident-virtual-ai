import { ChatSemanticDocumentsRoute } from '../routing/chat-semantic-router.types';
import { ChatTurnPlanAsk } from '../planning/chat-turn-plan.types';
import { ChatTurnAskResult } from '../responders/interfaces/chat-turn-responder.types';

interface DocumentWebQueryMetadata {
  equipmentOrSystem: string | null;
  equipmentName: string | null;
  equipmentAliases: string | null;
  manufacturer: string | null;
  model: string | null;
  systemArea: string | null;
  documentPurpose: string | null;
  documentRole: string | null;
  contentFocus: string | null;
}

interface DocumentWebQuerySource {
  sourceTitle: string | null;
  metadata: DocumentWebQueryMetadata;
}

const GENERIC_DOCUMENT_TITLE_TOKENS = new Set([
  'doc',
  'document',
  'documents',
  'file',
  'manual',
  'manuals',
  'pdf',
  'revision',
  'rev',
  'version',
]);

export function buildDocumentFallbackWebQuery(input: {
  ask: ChatTurnPlanAsk;
  documentResult?: ChatTurnAskResult | null;
}): string {
  const originalQuestion = normalizeSearchText(input.ask.question);
  const documentsRoute = input.ask.semanticRoute.documents;
  const semanticIdentity = collectSemanticIdentity(documentsRoute);
  const semanticPurpose = collectSemanticPurpose(documentsRoute);
  const documentSource = selectDocumentSource(input.documentResult);
  const useDocumentSource =
    documentSource !== null &&
    isSpecificDocumentSource(documentSource) &&
    !conflictsWithSemanticIdentity(documentSource, documentsRoute);
  const documentIdentity = useDocumentSource
    ? collectDocumentIdentity(documentSource)
    : [];
  const documentPurpose = useDocumentSource
    ? collectDocumentPurpose(documentSource.metadata)
    : [];
  const documentTitle =
    useDocumentSource && shouldIncludeDocumentTitle(documentSource, documentIdentity)
      ? documentSource.sourceTitle
      : null;
  const semanticTitle = normalizeSpecificTitle(documentsRoute.documentTitleHint);
  const hasAttributableContext =
    documentIdentity.length > 0 ||
    Boolean(documentTitle) ||
    semanticIdentity.length > 0 ||
    Boolean(semanticTitle);

  if (!hasAttributableContext) {
    return originalQuestion;
  }

  const preserveOriginalQuestion =
    !useDocumentSource || semanticIdentity.length === 0;
  const queryParts = [
    ...documentIdentity,
    documentTitle,
    ...semanticIdentity,
    semanticTitle,
    ...documentPurpose,
    ...semanticPurpose,
    preserveOriginalQuestion ? originalQuestion : null,
    hasFreshnessIntent(input.ask) ? 'latest revision' : null,
  ].filter((value): value is string => Boolean(value?.trim()));

  return dedupePhrases(queryParts.map(normalizeSearchText)).join(' ').trim() ||
    originalQuestion;
}

function collectSemanticIdentity(documentsRoute: ChatSemanticDocumentsRoute): string[] {
  return dedupePhrases(
    [
      ...documentsRoute.manufacturerHints,
      ...documentsRoute.modelHints,
      ...documentsRoute.equipmentOrSystemHints,
    ].map(normalizeSearchText),
  );
}

function collectSemanticPurpose(documentsRoute: ChatSemanticDocumentsRoute): string[] {
  return dedupePhrases(documentsRoute.contentFocusHints.map(normalizeSearchText));
}

function selectDocumentSource(
  result?: ChatTurnAskResult | null,
): DocumentWebQuerySource | null {
  const webQuerySources = collectWebQuerySources(result?.data);

  if (webQuerySources.length > 0) {
    return webQuerySources[0];
  }

  if (!Array.isArray(result?.contextReferences)) {
    return null;
  }

  for (const reference of result.contextReferences) {
    if (!reference || typeof reference !== 'object') {
      continue;
    }

    const entry = reference as Record<string, unknown>;
    const sourceTitle = readText(entry, 'sourceTitle');

    if (sourceTitle) {
      return {
        sourceTitle,
        metadata: emptyMetadata(),
      };
    }
  }

  return null;
}

function collectWebQuerySources(
  data?: Record<string, unknown> | null,
): DocumentWebQuerySource[] {
  if (!data?.retrieval || typeof data.retrieval !== 'object') {
    return [];
  }

  const retrieval = data.retrieval as Record<string, unknown>;
  const contexts = Array.isArray(retrieval.webQueryContext)
    ? retrieval.webQueryContext
    : [];

  return contexts.flatMap((context) => {
    if (!context || typeof context !== 'object') {
      return [];
    }

    const entry = context as Record<string, unknown>;
    const metadata =
      entry.metadataSummary && typeof entry.metadataSummary === 'object'
        ? (entry.metadataSummary as Record<string, unknown>)
        : null;

    return [
      {
        sourceTitle: readText(entry, 'sourceTitle'),
        metadata: {
          equipmentOrSystem: readText(metadata, 'equipmentOrSystem'),
          equipmentName: readText(metadata, 'equipmentName'),
          equipmentAliases: readText(metadata, 'equipmentAliases'),
          manufacturer: readText(metadata, 'manufacturer'),
          model: readText(metadata, 'model'),
          systemArea: readText(metadata, 'systemArea'),
          documentPurpose: readText(metadata, 'documentPurpose'),
          documentRole: readText(metadata, 'documentRole'),
          contentFocus: readText(metadata, 'contentFocus'),
        },
      },
    ];
  });
}

function emptyMetadata(): DocumentWebQueryMetadata {
  return {
    equipmentOrSystem: null,
    equipmentName: null,
    equipmentAliases: null,
    manufacturer: null,
    model: null,
    systemArea: null,
    documentPurpose: null,
    documentRole: null,
    contentFocus: null,
  };
}

function collectDocumentIdentity(source: DocumentWebQuerySource): string[] {
  const metadata = source.metadata;
  const equipment =
    metadata.equipmentName ??
    metadata.equipmentOrSystem ??
    metadata.equipmentAliases ??
    metadata.systemArea;

  return dedupePhrases(
    [metadata.manufacturer, metadata.model, equipment]
      .filter((value): value is string => Boolean(value?.trim()))
      .map(normalizeSearchText),
  );
}

function collectDocumentPurpose(metadata: DocumentWebQueryMetadata): string[] {
  const purpose =
    metadata.documentPurpose ?? metadata.documentRole ?? metadata.contentFocus;

  return purpose ? [normalizeSearchText(purpose)] : [];
}

function isSpecificDocumentSource(source: DocumentWebQuerySource): boolean {
  const metadata = source.metadata;

  if (
    metadata.manufacturer ||
    metadata.model ||
    metadata.equipmentName ||
    metadata.equipmentOrSystem ||
    metadata.equipmentAliases ||
    metadata.systemArea
  ) {
    return true;
  }

  return Boolean(normalizeSpecificTitle(source.sourceTitle));
}

function shouldIncludeDocumentTitle(
  source: DocumentWebQuerySource,
  identity: string[],
): boolean {
  const title = normalizeSpecificTitle(source.sourceTitle);

  if (!title) {
    return false;
  }

  const identityTokens = tokenizeSignificantText(identity.join(' '));

  return [...tokenizeSignificantText(title)].some(
    (token) => !identityTokens.has(token),
  );
}

function conflictsWithSemanticIdentity(
  source: DocumentWebQuerySource,
  documentsRoute: ChatSemanticDocumentsRoute,
): boolean {
  const metadata = source.metadata;

  if (
    metadata.manufacturer &&
    documentsRoute.manufacturerHints.length > 0 &&
    !hasTextOverlap(metadata.manufacturer, documentsRoute.manufacturerHints)
  ) {
    return true;
  }

  if (
    metadata.model &&
    documentsRoute.modelHints.length > 0 &&
    !hasTextOverlap(metadata.model, documentsRoute.modelHints)
  ) {
    return true;
  }

  const equipment = [
    metadata.equipmentName,
    metadata.equipmentOrSystem,
    metadata.equipmentAliases,
    metadata.systemArea,
  ].filter((value): value is string => Boolean(value?.trim()));

  if (documentsRoute.equipmentOrSystemHints.length === 0) {
    return false;
  }

  if (equipment.length > 0) {
    return !hasTextOverlap(equipment.join(' '), documentsRoute.equipmentOrSystemHints);
  }

  return Boolean(
    source.sourceTitle &&
      !hasTextOverlap(source.sourceTitle, documentsRoute.equipmentOrSystemHints),
  );
}

function hasTextOverlap(value: string, hints: string[]): boolean {
  const valueTokens = tokenizeSignificantText(value);

  return hints.some((hint) =>
    [...tokenizeSignificantText(hint)].some((token) => valueTokens.has(token)),
  );
}

function normalizeSpecificTitle(value: string | null | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }

  const normalized = normalizeSearchText(value);
  const significantTokens = [...tokenizeSignificantText(normalized)].filter(
    (token) => !GENERIC_DOCUMENT_TITLE_TOKENS.has(token),
  );

  return significantTokens.length > 0 ? normalized : null;
}

function tokenizeSignificantText(value: string): Set<string> {
  return new Set(
    normalizeSearchText(value)
      .toLocaleLowerCase()
      .split(/\s+/u)
      .filter((token) => token.length >= 2 && !GENERIC_DOCUMENT_TITLE_TOKENS.has(token)),
  );
}

function hasFreshnessIntent(ask: ChatTurnPlanAsk): boolean {
  return (
    ask.semanticRoute.web?.freshnessRequired === true ||
    /\b(?:latest|newest|most\s+recent|up[-\s]?to[-\s]?date|current\s+(?:external|online|web|public)?\s*(?:version|info|information|manual)?|online\s+version|latest\s+revision)\b/iu.test(
      ask.question,
    )
  );
}

function readText(
  value: Record<string, unknown> | null,
  key: string,
): string | null {
  const entry = value?.[key];

  return typeof entry === 'string' && entry.trim() ? entry.trim() : null;
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
    .replace(/[_\u2013\u2014]/gu, ' ')
    .replace(/\.[a-z0-9]{2,5}\b/giu, ' ')
    .replace(/[^\p{L}\p{N}/+-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
