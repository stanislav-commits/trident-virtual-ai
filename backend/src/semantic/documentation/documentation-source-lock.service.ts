import { Injectable, Logger } from '@nestjs/common';
import type {
  ChatCitation,
  ChatHistoryMessage,
  ChatNormalizedQuery,
} from '../../chat-shared/chat.types';
import { SEMANTIC_PROFILE_SCHEMA_VERSION } from '../contracts/semantic.constants';
import type {
  DocumentationFollowUpState,
  DocumentationSemanticCandidate,
  DocumentationSemanticQuery,
} from '../contracts/semantic.types';
import { parseDocumentationFollowUpState } from '../contracts/semantic.validators';

export interface DocumentationSourceLockDecision {
  active: boolean;
  lockedManualId: string | null;
  lockedManualTitle: string | null;
  lockedDocumentId: string | null;
  reason:
    | 'explicit_source'
    | 'follow_up_source_lock'
    | 'page_or_section_follow_up'
    | null;
}

@Injectable()
export class DocumentationSourceLockService {
  private readonly logger = new Logger(DocumentationSourceLockService.name);

  getFollowUpStateFromHistory(
    messageHistory?: ChatHistoryMessage[],
  ): DocumentationFollowUpState | null {
    if (!messageHistory?.length) {
      return null;
    }

    let skippedLatestUser = false;
    let skippedContextlessClarification = false;
    for (let index = messageHistory.length - 1; index >= 0; index -= 1) {
      const message = messageHistory[index];

      if (message.role === 'user') {
        if (!skippedLatestUser) {
          skippedLatestUser = true;
          continue;
        }
        if (skippedContextlessClarification) {
          skippedContextlessClarification = false;
          continue;
        }
        return null;
      }

      if (message.role !== 'assistant') {
        continue;
      }

      const context =
        message.ragflowContext && typeof message.ragflowContext === 'object'
          ? (message.ragflowContext as Record<string, unknown>)
          : null;
      const parsed = parseDocumentationFollowUpState(
        context?.documentationFollowUpState,
      );
      if (parsed) {
        return parsed;
      }

      const inferred = this.inferFollowUpStateFromReferences(message);
      if (inferred) {
        return inferred;
      }

      if (this.isDocumentationClarificationMessage(message)) {
        skippedContextlessClarification = true;
        continue;
      }

      return null;
    }

    return null;
  }

  resolveSourceLock(params: {
    userQuery: string;
    normalizedQuery?: ChatNormalizedQuery;
    semanticQuery: DocumentationSemanticQuery;
    followUpState?: DocumentationFollowUpState | null;
    candidates: DocumentationSemanticCandidate[];
  }): DocumentationSourceLockDecision {
    const explicitSourceCandidate = params.semanticQuery.explicitSource
      ? this.selectExplicitSourceCandidate(params.candidates)
      : null;
    if (explicitSourceCandidate) {
      return this.logDecision({
        active: true,
        lockedManualId: explicitSourceCandidate.manualId,
        lockedManualTitle: explicitSourceCandidate.filename,
        lockedDocumentId: explicitSourceCandidate.documentId,
        reason: 'explicit_source',
      });
    }

    if (
      params.followUpState?.lockedManualId &&
      (this.isContextualSourceFollowUp(params.userQuery) ||
        this.isGenericSourceDetailFollowUp(params.userQuery) ||
        params.normalizedQuery?.followUpMode === 'follow_up' ||
        params.normalizedQuery?.followUpMode === 'clarification_reply' ||
        params.semanticQuery.pageHint !== null ||
        params.semanticQuery.sectionHint !== null)
    ) {
      return this.logDecision({
        active: true,
        lockedManualId: params.followUpState.lockedManualId,
        lockedManualTitle: params.followUpState.lockedManualTitle,
        lockedDocumentId: params.followUpState.lockedDocumentId,
        reason:
          params.semanticQuery.pageHint !== null ||
          params.semanticQuery.sectionHint !== null
            ? 'page_or_section_follow_up'
            : 'follow_up_source_lock',
      });
    }

    return {
      active: false,
      lockedManualId: null,
      lockedManualTitle: null,
      lockedDocumentId: null,
      reason: null,
    };
  }

  buildNextFollowUpState(params: {
    semanticQuery: DocumentationSemanticQuery;
    retrievalQuery?: string | null;
    citations: ChatCitation[];
    candidates: DocumentationSemanticCandidate[];
    sourceLockDecision: DocumentationSourceLockDecision;
  }): DocumentationFollowUpState | null {
    const {
      semanticQuery,
      retrievalQuery,
      citations,
      candidates,
      sourceLockDecision,
    } = params;
    const dominantManual = this.resolveDominantManual(
      citations,
      candidates,
      sourceLockDecision,
    );

    if (!dominantManual) {
      return null;
    }

    return {
      schemaVersion: SEMANTIC_PROFILE_SCHEMA_VERSION,
      intent: semanticQuery.intent,
      conceptIds: semanticQuery.selectedConceptIds,
      retrievalQuery: retrievalQuery?.trim() || null,
      sourcePreferences: semanticQuery.sourcePreferences,
      sourceLock:
        sourceLockDecision.active ||
        this.uniqueManualIds(citations).length === 1,
      lockedManualId: dominantManual.manualId,
      lockedManualTitle: dominantManual.filename,
      lockedDocumentId: dominantManual.documentId,
      pageHint: semanticQuery.pageHint,
      sectionHint: semanticQuery.sectionHint,
      vendor: semanticQuery.vendor,
      model: semanticQuery.model,
      systems: semanticQuery.systems,
      equipment: semanticQuery.equipment,
    };
  }

  private inferFollowUpStateFromReferences(
    message: ChatHistoryMessage,
  ): DocumentationFollowUpState | null {
    const context =
      message.ragflowContext && typeof message.ragflowContext === 'object'
        ? (message.ragflowContext as Record<string, unknown>)
        : null;
    if (context?.usedDocumentation !== true) {
      return null;
    }

    const manualIds = this.uniqueManualIds(message.contextReferences ?? []);
    if (manualIds.length !== 1) {
      return null;
    }

    const reference = (message.contextReferences ?? []).find(
      (entry) => entry.shipManualId === manualIds[0],
    );
    return {
      schemaVersion: SEMANTIC_PROFILE_SCHEMA_VERSION,
      intent: 'general_information',
      conceptIds: [],
      retrievalQuery:
        typeof context?.resolvedSubjectQuery === 'string' &&
        context.resolvedSubjectQuery.trim()
          ? context.resolvedSubjectQuery.trim()
          : null,
      sourcePreferences: [],
      sourceLock: true,
      lockedManualId: manualIds[0],
      lockedManualTitle: reference?.sourceTitle ?? null,
      lockedDocumentId: null,
      pageHint: reference?.pageNumber ?? null,
      sectionHint: null,
      vendor: null,
      model: null,
      systems: [],
      equipment: [],
    };
  }

  private selectExplicitSourceCandidate(
    candidates: DocumentationSemanticCandidate[],
  ): DocumentationSemanticCandidate | null {
    return (
      candidates.find((candidate) =>
        candidate.reasons.includes('explicit_source'),
      ) ??
      candidates.find((candidate) => candidate.score >= 50) ??
      null
    );
  }

  private resolveDominantManual(
    citations: ChatCitation[],
    candidates: DocumentationSemanticCandidate[],
    sourceLockDecision: DocumentationSourceLockDecision,
  ): DocumentationSemanticCandidate | null {
    if (sourceLockDecision.lockedManualId) {
      const lockedCandidate = candidates.find(
        (candidate) => candidate.manualId === sourceLockDecision.lockedManualId,
      );
      if (lockedCandidate) {
        return lockedCandidate;
      }
      return {
        manualId: sourceLockDecision.lockedManualId,
        documentId: sourceLockDecision.lockedDocumentId ?? '',
        filename: sourceLockDecision.lockedManualTitle ?? 'Document',
        category: null,
        score: Number.MAX_SAFE_INTEGER,
        reasons: [sourceLockDecision.reason ?? 'follow_up_source_lock'],
      };
    }

    const manualIds = this.uniqueManualIds(citations);
    if (manualIds.length !== 1) {
      return null;
    }

    const manualId = manualIds[0];
    const candidate = candidates.find((entry) => entry.manualId === manualId);
    if (candidate) {
      return candidate;
    }

    const citation = citations.find((entry) => entry.shipManualId === manualId);
    return {
      manualId,
      documentId: '',
      filename: citation?.sourceTitle ?? 'Document',
      category: citation?.sourceCategory ?? null,
      score: 1,
      reasons: ['single_source_answer'],
    };
  }

  private isDocumentationClarificationMessage(
    message: ChatHistoryMessage,
  ): boolean {
    const context =
      message.ragflowContext && typeof message.ragflowContext === 'object'
        ? (message.ragflowContext as Record<string, unknown>)
        : null;
    return (
      context?.awaitingClarification === true &&
      context.clarificationDomain === 'documentation'
    );
  }

  private uniqueManualIds(citations: ChatCitation[]): string[] {
    return [
      ...new Set(
        citations
          .map((citation) => citation.shipManualId)
          .filter((manualId): manualId is string => Boolean(manualId)),
      ),
    ];
  }

  private isContextualSourceFollowUp(query: string): boolean {
    return (
      /\b(this|that|same|current|previous)\s+(manual|guide|document|procedure|one)\b/i.test(
        query,
      ) ||
      /\b(page|p\.?|section|chapter)\b.*\b(this|that|same|current|previous)\b/i.test(
        query,
      ) ||
      /\b(this|that|same|current|previous)\b.*\b(page|p\.?|section|chapter)\b/i.test(
        query,
      ) ||
      /\b(in|from)\s+(this|that|same)\b/i.test(query) ||
      /\b(page|p\.?|section|chapter)\s*#?\s*\d{1,4}\b/i.test(query)
    );
  }

  private isGenericSourceDetailFollowUp(query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed) {
      return false;
    }

    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    if (wordCount > 10) {
      return false;
    }

    return (
      /\b(parts?|spares?|items?|components?|quantit(?:y|ies)|qty|pages?|sources?|steps?|procedures?|records?|checks?|checklists?|warnings?|requirements?|limits?|limitations?|tools?|materials?|tables?|diagrams?|figures?|drawings?|charts?|summar(?:y|ies|ize)|process(?:es)?|sequence|overview)\b/i.test(
        trimmed,
      ) ||
      /\b(?:who|what|which)\s+should\s+(?:be\s+)?(?:notified|involved|checked|recorded|completed)\b/i.test(
        trimmed,
      ) ||
      /\bwhat\s+(?:should|do)\s+i\s+check\s+first\b/i.test(
        trimmed,
      )
    );
  }

  private logDecision(
    decision: DocumentationSourceLockDecision,
  ): DocumentationSourceLockDecision {
    this.logger.debug(
      `Documentation source lock active reason=${decision.reason} manual=${decision.lockedManualId ?? 'none'} title="${decision.lockedManualTitle ?? ''}"`,
    );
    return decision;
  }
}
