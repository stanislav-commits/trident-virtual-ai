import { DocumentEntity } from './entities/document.entity';
import { DocumentTimeScope } from './enums/document-time-scope.enum';
import {
  DocumentParsingProfileDefinition,
  getParsingProfileForDocClass,
} from './parsing/document-parsing-profiles';

export interface DocumentMetadataInput {
  docClass: string;
  language?: string;
  equipmentOrSystem?: string;
  manufacturer?: string;
  model?: string;
  revision?: string;
  timeScope?: DocumentTimeScope;
  sourcePriority?: number;
  contentFocus?: string;
}

export interface DocumentMetadataOverrides {
  language?: string | null;
  equipmentOrSystem?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  revision?: string | null;
  timeScope?: DocumentTimeScope;
  sourcePriority?: number;
  contentFocus?: string | null;
}

export function applyParsingProfile(
  document: DocumentEntity,
  profile: DocumentParsingProfileDefinition,
): void {
  document.parseProfile = profile.parseProfile;
  document.chunkMethod = profile.chunkMethod;
  document.pdfParser = profile.pdfParser;
  document.autoKeywords = profile.autoKeywords;
  document.autoQuestions = profile.autoQuestions;
  document.chunkSize = profile.chunkSize;
  document.delimiter = profile.delimiter;
  document.overlapPercent = profile.overlapPercent;
  document.pageIndexEnabled = profile.pageIndexEnabled;
  document.childChunksEnabled = profile.childChunksEnabled;
  document.imageTableContextWindow = profile.imageTableContextWindow;
}

export function applyMetadataOverrides(
  document: DocumentEntity,
  input: DocumentMetadataOverrides,
): void {
  if (input.language !== undefined) document.language = input.language ?? null;
  if (input.equipmentOrSystem !== undefined) {
    document.equipmentOrSystem = input.equipmentOrSystem ?? null;
  }
  if (input.manufacturer !== undefined) {
    document.manufacturer = input.manufacturer ?? null;
  }
  if (input.model !== undefined) document.model = input.model ?? null;
  if (input.revision !== undefined) document.revision = input.revision ?? null;
  if (input.timeScope !== undefined) document.timeScope = input.timeScope;
  if (input.sourcePriority !== undefined) {
    document.sourcePriority = input.sourcePriority;
  }
  if (input.contentFocus !== undefined) {
    document.contentFocus = input.contentFocus ?? null;
  }
}

export function buildDocumentMetadata(
  shipId: string,
  input: DocumentMetadataInput,
): Record<string, unknown> {
  return dropEmptyMetadata({
    ship_id: shipId,
    doc_class: input.docClass,
    language: input.language,
    equipment_or_system: input.equipmentOrSystem,
    manufacturer: input.manufacturer,
    model: input.model,
    revision: input.revision,
    time_scope: input.timeScope ?? DocumentTimeScope.CURRENT,
    source_priority: input.sourcePriority ?? 100,
    content_focus: input.contentFocus,
  });
}

export function buildDocumentMetadataFromEntity(
  document: DocumentEntity,
): Record<string, unknown> {
  return buildDocumentMetadata(document.shipId, {
    docClass: document.docClass,
    language: document.language ?? undefined,
    equipmentOrSystem: document.equipmentOrSystem ?? undefined,
    manufacturer: document.manufacturer ?? undefined,
    model: document.model ?? undefined,
    revision: document.revision ?? undefined,
    timeScope: document.timeScope,
    sourcePriority: document.sourcePriority,
    contentFocus: document.contentFocus ?? undefined,
  });
}

export function refreshDocumentProfile(document: DocumentEntity): void {
  applyParsingProfile(document, getParsingProfileForDocClass(document.docClass));
}

function dropEmptyMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );
}
