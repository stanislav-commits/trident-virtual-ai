import { Injectable, Logger } from '@nestjs/common';
import {
  DocumentsFileLookupService,
  FileLookupCandidate,
} from '../../documents/retrieval/documents-file-lookup.service';
import { ChatLlmService } from '../chat-llm.service';
import { ChatTurnResponderKind } from '../planning/chat-turn-responder-kind.enum';
import {
  ChatTurnResponderInput,
  ChatTurnResponderOutput,
} from './interfaces/chat-turn-responder.types';
import { CHAT_ANSWER_HYGIENE_RULE } from '../../../common/chat-answer-hygiene.const';
import { cleanFormName } from '../../documents/doc-code.util';

/**
 * Returns the ORIGINAL file the user is asking for ("show me the GA plan",
 * "open the watermaker manual", "give me the original fire control drawing").
 * It does a catalog lookup over document metadata (NOT content) and hands back
 * `document` source references carrying the documentId — the chat UI already
 * opens the original file from those. This is the path that makes Vessel Plans
 * (not content-parsed) reachable, and satisfies "return the original on request"
 * for any document type.
 *
 * Route-gated: dispatched when `ask.semanticRoute.route === FILES`.
 */
@Injectable()
export class ChatFilesResponderService {
  private readonly logger = new Logger(ChatFilesResponderService.name);

  private readonly maxCandidates = 5;

  constructor(
    private readonly fileLookup: DocumentsFileLookupService,
    private readonly chatLlmService: ChatLlmService,
  ) {}

  async respond(
    input: ChatTurnResponderInput,
  ): Promise<ChatTurnResponderOutput> {
    const shipId = input.session.shipId;
    const question = input.ask.question;

    const candidates = await this.loadCandidates(shipId, question);

    const summary = await this.composeAnswer({
      question,
      responseLanguage: input.plan.responseLanguage,
      candidates,
    });

    return {
      askId: input.ask.id,
      intent: input.ask.intent,
      responder: ChatTurnResponderKind.FILES,
      question,
      capabilityEnabled: true,
      capabilityLabel: 'file lookup',
      summary,
      data: { candidateCount: candidates.length },
      contextReferences: this.buildContextReferences(candidates),
    };
  }

  private async loadCandidates(
    shipId: string | null,
    question: string,
  ): Promise<FileLookupCandidate[]> {
    if (!shipId) {
      return [];
    }

    try {
      return await this.fileLookup.findFiles(shipId, question, this.maxCandidates);
    } catch (error) {
      this.logger.error(
        `File lookup failed for ship ${shipId}: ${String(error)}`,
      );
      return [];
    }
  }

  private async composeAnswer(input: {
    question: string;
    responseLanguage: string | null;
    candidates: FileLookupCandidate[];
  }): Promise<string> {
    if (!input.candidates.length) {
      // No LLM call needed for the empty case; keep it cheap but localized.
      return input.responseLanguage?.toLowerCase().startsWith('ru')
        ? 'Не нашёл подходящего файла в документах судна. Уточните название или оборудование.'
        : "I couldn't find a matching file in the ship's documents. Try naming the document or equipment.";
    }

    // Feed the model a hygiene-safe label per candidate — NEVER the raw
    // filename. A FORM/checklist may be named by its controlled code + a
    // clean name (the one identifier the user is meant to see); everything
    // else is referred to by its type + what it's about, and opened via the
    // attached source.
    const list = input.candidates
      .map((candidate, index) => {
        const about = candidate.descriptor ? ` about ${candidate.descriptor}` : '';
        if (candidate.docClass === 'form') {
          const name = cleanFormName(candidate.fileName);
          const codePart = candidate.docCode ? `form ${candidate.docCode}` : 'form';
          return `[${index + 1}] ${codePart}${name ? ` — ${name}` : ''}${about}`;
        }
        return `[${index + 1}] a ${candidate.docClass}${about}`;
      })
      .join('\n');

    const systemPrompt = [
      'You help the user find the right ship document to open.',
      'You are given the ranked candidate documents (best first) that matched the request, described in plain terms.',
      'Point the user to the single best match. It is attached as a source they can open; do NOT output a link or claim to attach it yourself.',
      'If it is a FORM or checklist, name it by its plain name and code (e.g. "the Bunkering Checklist, form ENG 008 01"). For any other document (manual, procedure, plan, circular), refer to it by what it IS ("the generator manual", "the bunkering procedure") — never state a filename.',
      'If a few candidates are plausible, point at the top one and briefly mention the others so the user can pick — do NOT invent documents beyond the list.',
      'Do NOT mention internal storage details, "original vs extract", copyright, or availability caveats.',
      'Be brief — one or two sentences.',
      input.responseLanguage
        ? `Write the answer in this language: ${input.responseLanguage}.`
        : 'Write the answer in the same language as the question.',
      CHAT_ANSWER_HYGIENE_RULE,
    ].join('\n');

    const userPrompt = [
      `Request: ${input.question}`,
      '',
      'Candidate files (ranked best first):',
      list,
    ].join('\n');

    const reply = await this.chatLlmService.completeText({
      systemPrompt,
      userPrompt,
      temperature: 0,
      maxTokens: 300,
      useMainModel: true,
    });

    const top = input.candidates[0];
    const fallbackName =
      top.docClass === 'form'
        ? [top.docCode, cleanFormName(top.fileName)].filter(Boolean).join(' — ') ||
          'the checklist'
        : `the ${top.docClass}`;
    return reply?.trim() || `I found ${fallbackName} — attached above to open.`;
  }

  /**
   * Emit `document` references (the shape the chat UI already opens via
   * fetchDocumentFile) so the user can open the original file directly.
   */
  private buildContextReferences(
    candidates: FileLookupCandidate[],
  ): unknown[] {
    return candidates.map((candidate, index) => ({
      id: `document-${index + 1}`,
      sourceType: 'document',
      documentId: candidate.documentId,
      sourceTitle: candidate.fileName,
      snippet: candidate.descriptor ?? candidate.docClass,
    }));
  }
}
