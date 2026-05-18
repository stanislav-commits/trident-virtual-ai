import {
  DocumentRetrievalResponseDto,
  DocumentRetrievalResultDto,
} from '../../../../documents/dto/document-retrieval-response.dto';
import { DocumentIntentPlan } from '../intent/document-intent-plan.types';

export interface ProcedureEvidenceSupport {
  directResults: DocumentRetrievalResultDto[];
  relatedResults: DocumentRetrievalResultDto[];
  hasProcedureStepEvidence: boolean;
}

export function shouldRequireProcedureStepEvidence(
  intentPlan: DocumentIntentPlan | null | undefined,
): boolean {
  return Boolean(
    intentPlan &&
      intentPlan.confidence >= 0.2 &&
      (intentPlan.asksForSteps ||
        intentPlan.answerMode === 'procedure' ||
        intentPlan.evidenceNeed === 'procedure_steps'),
  );
}

export function hasProcedureStepEvidence(
  retrieval: DocumentRetrievalResponseDto,
): boolean {
  return retrieval.results.some((result) =>
    hasProcedureStepEvidenceSignal(result.snippet),
  );
}

export function assessProcedureEvidenceSupport(
  retrieval: DocumentRetrievalResponseDto,
  intentPlan: DocumentIntentPlan | null | undefined,
): ProcedureEvidenceSupport {
  const requestedTokens = buildRequestedSubjectTokens(intentPlan);
  const directResults: DocumentRetrievalResultDto[] = [];
  const relatedResults: DocumentRetrievalResultDto[] = [];
  let hasAnyProcedureStepEvidence = false;

  for (const result of retrieval.results) {
    if (!resultHasProcedureStepEvidence(result)) {
      continue;
    }

    hasAnyProcedureStepEvidence = true;

    if (procedureEvidenceMatchesRequestedSubject(result, requestedTokens)) {
      directResults.push(result);
    } else if (procedureEvidenceIsRelated(result, requestedTokens)) {
      relatedResults.push(result);
    }
  }

  return {
    directResults,
    relatedResults,
    hasProcedureStepEvidence: hasAnyProcedureStepEvidence,
  };
}

export function getDirectProcedureEvidenceRanks(
  retrieval: DocumentRetrievalResponseDto,
  intentPlan: DocumentIntentPlan | null | undefined,
): number[] {
  return assessProcedureEvidenceSupport(retrieval, intentPlan).directResults.map(
    (result) => result.rank,
  );
}

export function buildMissingProcedureStepEvidenceSummary(
  retrieval: DocumentRetrievalResponseDto,
  options: { includeCitations?: boolean } = {},
): string {
  const citedResults = retrieval.results.slice(0, 2);
  const citationText =
    options.includeCitations === false
      ? ''
      : citedResults.map((result) => `[${result.rank}]`).join('');

  return [
    'I found uploaded document evidence related to this request, but it does not provide enough step-by-step procedure evidence to safely give instructions.',
    citationText
      ? `The available evidence can only support that related document content exists ${citationText}.`
      : null,
    'I cannot invent a procedure from a schedule item, PMS task, or general reference.',
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

export function buildRelatedProcedureEvidenceSummary(
  support: ProcedureEvidenceSupport,
  options: { includeCitations?: boolean } = {},
): string {
  const relatedResults = support.relatedResults.slice(0, 2);
  const citationText =
    options.includeCitations === false
      ? ''
      : relatedResults.map((result) => `[${result.rank}]`).join('');

  return [
    'I found related procedural evidence in the uploaded documents, but it does not match the requested equipment/component/operation closely enough to present it as direct instructions.',
    citationText
      ? `The closest cited evidence is related, not a direct procedure for the requested subject ${citationText}.`
      : null,
    'I will not turn similar evidence into step-by-step instructions for a different component or operation.',
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

export function resultHasProcedureStepEvidence(
  result: DocumentRetrievalResultDto,
): boolean {
  return hasProcedureStepEvidenceSignal(result.snippet);
}

function hasProcedureStepEvidenceSignal(snippet: string): boolean {
  const normalized = snippet.toLocaleLowerCase();

  if (/(^|\n)\s*(step\s+\d+|\d+[.)])\s+/iu.test(snippet)) {
    return true;
  }

  if (
    /\b(?:procedure|instructions?|before|after|verify|caution|warning)\b/u.test(
      normalized,
    )
  ) {
    return true;
  }

  const actionMatches =
    normalized.match(
      /\b(?:remove|install|replace|renew|loosen|tighten|disconnect|reconnect|unscrew|screw|open|close|drain|fill|bleed|pump|start|stop|check)\b/gu,
    ) ?? [];

  return new Set(actionMatches).size >= 2;
}

interface RequestedProcedureTokens {
  component: string[];
  equipment: string[];
  operation: string[];
  any: string[];
}

const GENERIC_REQUEST_TOKENS = new Set([
  'about',
  'change',
  'check',
  'checking',
  'document',
  'documents',
  'equipment',
  'instruction',
  'instructions',
  'maintenance',
  'manual',
  'operation',
  'procedure',
  'replace',
  'service',
  'step',
  'steps',
  'system',
]);

function buildRequestedSubjectTokens(
  intentPlan: DocumentIntentPlan | null | undefined,
): RequestedProcedureTokens {
  const component = tokenizeSubject(intentPlan?.componentMentioned);
  const equipment = tokenizeSubject(intentPlan?.equipmentMentioned);
  const operation = tokenizeSubject(intentPlan?.operationMentioned);
  const any = Array.from(new Set([...component, ...equipment, ...operation]));

  return {
    component,
    equipment,
    operation,
    any,
  };
}

function procedureEvidenceMatchesRequestedSubject(
  result: DocumentRetrievalResultDto,
  requestedTokens: RequestedProcedureTokens,
): boolean {
  if (!requestedTokens.any.length) {
    return true;
  }

  const evidenceTokens = tokenizeSubject(buildEvidenceSubjectText(result));

  if (requestedTokens.component.length) {
    const componentSupported = hasAdequateTokenSupport(
      requestedTokens.component,
      evidenceTokens,
    );

    if (
      requestedTokens.component.length === 1 &&
      requestedTokens.equipment.length
    ) {
      return (
        componentSupported &&
        hasAdequateTokenSupport(requestedTokens.equipment, evidenceTokens)
      );
    }

    return componentSupported;
  }

  if (requestedTokens.equipment.length) {
    return hasAdequateTokenSupport(requestedTokens.equipment, evidenceTokens);
  }

  return hasAdequateTokenSupport(requestedTokens.operation, evidenceTokens);
}

function procedureEvidenceIsRelated(
  result: DocumentRetrievalResultDto,
  requestedTokens: RequestedProcedureTokens,
): boolean {
  if (!requestedTokens.any.length) {
    return false;
  }

  const evidenceTokens = tokenizeSubject(buildEvidenceSubjectText(result));

  return requestedTokens.any.some((token) => evidenceTokens.includes(token));
}

function hasAdequateTokenSupport(
  requestedTokens: string[],
  evidenceTokens: string[],
): boolean {
  if (!requestedTokens.length) {
    return true;
  }

  const supported = requestedTokens.filter((token) =>
    evidenceTokens.includes(token),
  );

  if (requestedTokens.length === 1) {
    return supported.length === 1;
  }

  if (requestedTokens.length >= 3) {
    return supported.length === requestedTokens.length;
  }

  return supported.length / requestedTokens.length >= 0.67;
}

function buildEvidenceSubjectText(result: DocumentRetrievalResultDto): string {
  return [
    result.filename,
    result.section,
    result.snippet,
    result.metadataSummary.equipmentOrSystem,
    result.metadataSummary.manufacturer,
    result.metadataSummary.model,
    result.metadataSummary.contentFocus,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

function tokenizeSubject(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/gu)
        .map((token) => normalizeSubjectToken(token.trim()))
        .filter(
          (token) => token.length >= 3 && !GENERIC_REQUEST_TOKENS.has(token),
        ),
    ),
  );
}

function normalizeSubjectToken(value: string): string {
  if (
    value === 'changing' ||
    value === 'renew' ||
    value === 'renewing' ||
    value === 'replacing' ||
    value === 'replacement'
  ) {
    return 'replace';
  }

  if (value === 'servicing') {
    return 'service';
  }

  return value.length > 3 && value.endsWith('s') ? value.slice(0, -1) : value;
}
