import { Injectable } from '@nestjs/common';
import {
  DocumentRetrievalEvidenceQuality,
  DocumentRetrievalResponseDto,
  DocumentRetrievalResultDto,
} from '../../documents/dto/document-retrieval-response.dto';
import { SearchDocumentsDto } from '../../documents/dto/search-documents.dto';
import { DocumentsService } from '../../documents/documents.service';
import { DocumentDocClass } from '../../documents/enums/document-doc-class.enum';
import { getDocumentQuestionClassPolicy } from '../../documents/retrieval/document-question-class-policy';
import { ChatLlmService } from '../chat-llm.service';
import { ChatSemanticDocumentsRoute } from '../routing/chat-semantic-router.types';
import { ChatTurnResponderKind } from '../planning/chat-turn-responder-kind.enum';
import {
  ChatTurnResponderInput,
  ChatTurnResponderOutput,
} from './interfaces/chat-turn-responder.types';

interface DocumentClassAttempt {
  reason: 'primary' | 'secondary_fallback' | 'router_candidates';
  candidateDocClasses?: DocumentDocClass[];
}

@Injectable()
export class ChatDocumentsResponderService {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly chatLlmService: ChatLlmService,
  ) {}

  async respond(
    input: ChatTurnResponderInput,
  ): Promise<ChatTurnResponderOutput> {
    const documentsRoute = input.ask.semanticRoute.documents;
    const shipId = input.session.shipId ?? documentsRoute.shipId;

    if (!shipId) {
      return this.buildStaticResponse(
        input,
        'missing_ship_context',
        'I need an active ship context before I can search uploaded ship documents.',
      );
    }

    let retrieval: DocumentRetrievalResponseDto | null = null;
    const attempts = this.buildDocumentClassAttempts(documentsRoute);
    let completedAttempt: DocumentClassAttempt | null = null;

    try {
      for (const attempt of attempts) {
        completedAttempt = attempt;
        retrieval = await this.documentsService.search(
          this.buildRetrievalRequest(input, documentsRoute, shipId, attempt),
        );

        if (retrieval.evidenceQuality !== 'none') {
          break;
        }
      }
    } catch (error) {
      return this.buildStaticResponse(
        input,
        'retrieval_failed',
        `I could not search the ship documents for this request: ${this.formatError(error)}`,
      );
    }

    if (!retrieval) {
      return this.buildStaticResponse(
        input,
        'retrieval_failed',
        'I could not search the ship documents for this request.',
      );
    }

    const summary = await this.buildGroundedSummary(input, retrieval);

    return {
      askId: input.ask.id,
      intent: input.ask.intent,
      responder: ChatTurnResponderKind.DOCUMENTS,
      question: input.ask.question,
      capabilityEnabled: true,
      capabilityLabel: 'document retrieval',
      summary,
      data: {
        status: this.toResponseStatus(retrieval.evidenceQuality),
        retrieval: {
          evidenceQuality: retrieval.evidenceQuality,
          answerability: retrieval.answerability,
          appliedFilters: retrieval.appliedFilters,
          diagnostics: retrieval.diagnostics,
          retrievalAttempt: completedAttempt?.reason ?? null,
          attemptedDocClasses: attempts.map((attempt) => ({
            reason: attempt.reason,
            candidateDocClasses: attempt.candidateDocClasses ?? null,
          })),
          resultCount: retrieval.results.length,
        },
      },
      contextReferences: this.toContextReferences(retrieval, summary),
    };
  }

  private buildRetrievalRequest(
    input: ChatTurnResponderInput,
    documentsRoute: ChatSemanticDocumentsRoute,
    shipId: string,
    attempt: DocumentClassAttempt,
  ): SearchDocumentsDto {
    return {
      question: input.ask.question,
      shipId,
      candidateDocClasses: attempt.candidateDocClasses,
      questionType: documentsRoute.questionType ?? undefined,
      equipmentOrSystemHints: documentsRoute.equipmentOrSystemHints.length
        ? documentsRoute.equipmentOrSystemHints
        : undefined,
      manufacturerHints: documentsRoute.manufacturerHints.length
        ? documentsRoute.manufacturerHints
        : undefined,
      modelHints: documentsRoute.modelHints.length
        ? documentsRoute.modelHints
        : undefined,
      contentFocusHints: documentsRoute.contentFocusHints.length
        ? documentsRoute.contentFocusHints
        : undefined,
      languageHint:
        documentsRoute.languageHint ?? input.plan.responseLanguage ?? undefined,
      allowMultiDocument:
        documentsRoute.multiDocumentLikely ||
        (attempt.candidateDocClasses?.length ?? 0) > 1 ||
        undefined,
      allowWeakEvidence: true,
    };
  }

  private async buildGroundedSummary(
    input: ChatTurnResponderInput,
    retrieval: DocumentRetrievalResponseDto,
  ): Promise<string> {
    if (retrieval.evidenceQuality === 'none') {
      return [
        'I could not find sufficient evidence in the uploaded ship documents to answer this confidently.',
        retrieval.answerability.reason,
        'I did not use web fallback for this document-only request.',
      ].join(' ');
    }

    const reply = await this.chatLlmService.completeText({
      systemPrompt: this.buildGroundedAnswerSystemPrompt(retrieval.evidenceQuality),
      userPrompt: this.buildGroundedAnswerUserPrompt(input, retrieval),
      temperature: 0.1,
      maxTokens: retrieval.evidenceQuality === 'strong' ? 650 : 420,
    });

    if (reply) {
      return reply;
    }

    return this.buildFallbackEvidenceSummary(retrieval);
  }

  private buildGroundedAnswerSystemPrompt(
    evidenceQuality: DocumentRetrievalEvidenceQuality,
  ): string {
    const weakInstruction =
      evidenceQuality === 'weak'
        ? 'The evidence is weak. Be cautious, state that the evidence is limited, and do not present uncertain details as confirmed facts.'
        : 'The evidence is strong enough to answer, but you must still stay strictly grounded.';

    return [
      'You answer Trident document questions using only retrieved ship-document evidence.',
      'Do not use public web knowledge, generic maritime knowledge, or assumptions.',
      'Do not invent page numbers, section names, values, procedures, or requirements.',
      'Use citation markers like [1] or [2] for facts that come from the evidence.',
      'If the evidence does not support part of the question, say that plainly.',
      weakInstruction,
    ].join(' ');
  }

  private buildGroundedAnswerUserPrompt(
    input: ChatTurnResponderInput,
    retrieval: DocumentRetrievalResponseDto,
  ): string {
    return [
      `User question: ${input.ask.question}`,
      `Preferred response language: ${input.plan.responseLanguage ?? 'infer from the user question'}`,
      `Evidence quality: ${retrieval.evidenceQuality}`,
      `Answerability note: ${retrieval.answerability.reason}`,
      '',
      'Retrieved evidence:',
      ...retrieval.results.map((result) => this.formatEvidenceItem(result)),
    ].join('\n');
  }

  private formatEvidenceItem(result: DocumentRetrievalResultDto): string {
    return [
      `[${result.rank}] ${result.filename}`,
      `docClass: ${result.docClass}`,
      result.page ? `page: ${result.page}` : 'page: unknown',
      result.section ? `section: ${result.section}` : null,
      `snippet: ${result.snippet}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildFallbackEvidenceSummary(
    retrieval: DocumentRetrievalResponseDto,
  ): string {
    const topResult = retrieval.results[0];

    if (!topResult) {
      return [
        'I could not find sufficient evidence in the uploaded ship documents to answer this confidently.',
        retrieval.answerability.reason,
      ].join(' ');
    }

    if (retrieval.evidenceQuality === 'weak') {
      return [
        'I found limited ship-document evidence, but it is not strong enough for a confident answer.',
        `The closest source is ${topResult.filename}${topResult.page ? `, page ${topResult.page}` : ''}.`,
        `[1]`,
      ].join(' ');
    }

    return [
      `The strongest retrieved evidence is in ${topResult.filename}${topResult.page ? `, page ${topResult.page}` : ''}.`,
      topResult.snippet,
      `[1]`,
    ].join(' ');
  }

  private toContextReferences(
    retrieval: DocumentRetrievalResponseDto,
    summary: string,
  ): Record<string, unknown>[] {
    if (!this.shouldExposeContextReferences(retrieval, summary)) {
      return [];
    }

    return retrieval.results.map((result) => ({
      id: `document-${result.rank}`,
      sourceType: 'document',
      documentId: result.documentId,
      shipId: retrieval.shipId,
      chunkId: result.chunkId,
      score: result.rerankScore,
      pageNumber: result.page ?? undefined,
      snippet: result.snippet,
      sourceTitle: result.filename,
    }));
  }

  private shouldExposeContextReferences(
    retrieval: DocumentRetrievalResponseDto,
    summary: string,
  ): boolean {
    if (
      retrieval.evidenceQuality === 'none' ||
      retrieval.answerability.status === 'none' ||
      !retrieval.results.length
    ) {
      return false;
    }

    return !this.isNoSupportingEvidenceSummary(summary);
  }

  private isNoSupportingEvidenceSummary(summary: string): boolean {
    const normalized = summary.toLowerCase().replace(/\s+/g, ' ').trim();

    if (!normalized) {
      return true;
    }

    return [
      /could not find sufficient (?:ship-)?document evidence/,
      /could not find sufficient evidence in the uploaded ship documents/,
      /no (?:relevant )?(?:parsed )?(?:ship-)?document evidence/,
      /no supporting (?:ship-)?document evidence/,
      /retrieved evidence (?:does|do) not (?:contain|provide|include|show|support)/,
      /available evidence (?:does|do) not (?:contain|provide|include|show|support)/,
      /uploaded (?:ship )?documents? (?:does|do) not (?:contain|provide|include|show|support)/,
    ].some((pattern) => pattern.test(normalized));
  }

  private buildStaticResponse(
    input: ChatTurnResponderInput,
    status: string,
    summary: string,
  ): ChatTurnResponderOutput {
    return {
      askId: input.ask.id,
      intent: input.ask.intent,
      responder: ChatTurnResponderKind.DOCUMENTS,
      question: input.ask.question,
      capabilityEnabled: true,
      capabilityLabel: 'document retrieval',
      summary,
      data: { status },
      contextReferences: [],
    };
  }

  private toResponseStatus(
    evidenceQuality: DocumentRetrievalEvidenceQuality,
  ): string {
    if (evidenceQuality === 'strong') return 'answered';
    if (evidenceQuality === 'weak') return 'weak_evidence';
    return 'no_evidence';
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private buildDocumentClassAttempts(
    documentsRoute: ChatSemanticDocumentsRoute,
  ): DocumentClassAttempt[] {
    const policy = getDocumentQuestionClassPolicy(
      documentsRoute.questionType,
    );

    if (!policy) {
      return [
        {
          reason: 'router_candidates',
          candidateDocClasses: this.toOptionalClasses(
            documentsRoute.candidateDocClasses,
          ),
        },
      ];
    }

    const primary = this.mergeClasses(policy.primary, []);
    const fallback = this.mergeClasses(policy.secondary, []);
    const attempts: DocumentClassAttempt[] = [];

    if (primary.length) {
      attempts.push({
        reason: 'primary',
        candidateDocClasses: primary,
      });
    }

    if (fallback.length) {
      attempts.push({
        reason: 'secondary_fallback',
        candidateDocClasses: fallback,
      });
    }

    return attempts.length
      ? attempts
      : [
          {
            reason: 'router_candidates',
            candidateDocClasses: this.toOptionalClasses(
              documentsRoute.candidateDocClasses,
            ),
          },
        ];
  }

  private mergeClasses(
    primaryClasses: DocumentDocClass[],
    additionalClasses: DocumentDocClass[],
  ): DocumentDocClass[] {
    return Array.from(new Set([...primaryClasses, ...additionalClasses]));
  }

  private toOptionalClasses(
    candidateDocClasses: DocumentDocClass[],
  ): DocumentDocClass[] | undefined {
    return candidateDocClasses.length
      ? this.mergeClasses(candidateDocClasses, [])
      : undefined;
  }
}
