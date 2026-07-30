import { Injectable, Logger } from '@nestjs/common';
import { ComplianceService } from '../../compliance/compliance.service';
import { CHAT_ANSWER_HYGIENE_RULE } from '../../../common/chat-answer-hygiene.const';
import { AccessControlService } from '../../access-control/access-control.service';
import { categoryForArchetype } from '../../access-control/access-positions';
import { ChatLlmService } from '../chat-llm.service';
import { ChatTurnResponderKind } from '../planning/chat-turn-responder-kind.enum';
import {
  ChatTurnResponderInput,
  ChatTurnResponderOutput,
} from './interfaces/chat-turn-responder.types';

interface ComplianceItem {
  section: string;
  typeName: string;
  status: string; // valid | expiring | expired | missing
  certNo: string | null;
  issuer: string | null;
  expiryDate: string | null;
  assetName: string | null;
  surveyWindow: string | null;
  renewalCycle: string | null;
  recordId: string | null;
  archetype: string | null;
  /** Y / C / R / TBD resolved for THIS vessel — decides what "missing" means. */
  applicabilityVerdict: string | null;
  /**
   * Supporting documents on the record, with their tags. v60 keeps several
   * papers under ONE row rather than splitting the row — the SeaWolf X and
   * SeaWolf Chase repatriation certificates live under 1.11.6 together, and the
   * Greece / Italy / Spain P&I supplements under 1.11.3 tagged by jurisdiction.
   * Without the tags the answer cannot say which paper covers what.
   */
  attachments: Array<{ kind: string | null; label: string | null; fileName: string | null }>;
}

/**
 * Answers certificate / compliance questions ("which certificates are
 * expiring", "is the Safety Construction Certificate valid", "what is the
 * survey window for X", "what compliance docs are missing") from the STRUCTURED
 * Compliance Docs module, not from documents. Mirrors the PMS bridge: the
 * Compliance register is the live source of truth, replacing retrieval of
 * stale `certificate`-class documents.
 *
 * Route-gated: dispatched when `ask.semanticRoute.route === COMPLIANCE`.
 */
@Injectable()
export class ChatComplianceResponderService {
  private readonly logger = new Logger(ChatComplianceResponderService.name);

  private readonly maxItemsInContext = 80;
  // How many directly-matched records get their full text loaded into context,
  // and the per-document character cap (certs are 1–2 pages ≈ a few KB).
  private readonly maxFullTextDocs = 5;
  private readonly maxTextChars = 6000;

  constructor(
    private readonly complianceService: ComplianceService,
    private readonly chatLlmService: ChatLlmService,
    private readonly accessControlService: AccessControlService,
  ) {}

  async respond(
    input: ChatTurnResponderInput,
  ): Promise<ChatTurnResponderOutput> {
    const shipId = input.session.shipId;
    const question = input.ask.question;

    const allItems = await this.loadItems(shipId);
    const items = await this.applyAccess(allItems, input.session.userId, shipId);
    // Gaps are listed in full, separately. A gap has no dates, numbers or
    // issuer — spending detail slots on it would push real records out of
    // context, and truncating it would make "what is missing?" answer with a
    // partial list while sounding complete. SeaWolf X alone has 156 gaps
    // against an 80-item detail budget.
    const gaps = items.filter((item) => item.status === 'missing');
    const records = items.filter((item) => item.status !== 'missing');
    const ranked = this.rankForQuestion(records, question);
    const included = ranked.slice(0, this.maxItemsInContext);

    // For records that directly match the question, pull their full stored text
    // so the AI can answer body-level questions ("what does clause X say"). Only
    // the top few matches — certificates are short, and this keeps context lean.
    const nq = question.toLowerCase();
    const matchedIds = included
      .filter((item) => item.recordId && this.matchesQuestion(item, nq))
      .slice(0, this.maxFullTextDocs)
      .map((item) => item.recordId as string);
    const texts =
      matchedIds.length && shipId
        ? await this.complianceService.getExtractedTexts(shipId, matchedIds)
        : new Map<string, string>();

    const summary = await this.composeAnswer({
      question,
      responseLanguage: input.plan.responseLanguage,
      items: included,
      gaps,
      totalCount: records.length,
      texts,
    });

    const expired = items.filter((item) => item.status === 'expired').length;
    const expiring = items.filter((item) => item.status === 'expiring').length;
    const missing = gaps.length;

    return {
      askId: input.ask.id,
      intent: input.ask.intent,
      responder: ChatTurnResponderKind.COMPLIANCE,
      question,
      capabilityEnabled: true,
      capabilityLabel: 'compliance & doc-control register',
      summary,
      data: {
        itemCount: items.length,
        includedCount: included.length,
        expired,
        expiring,
        missing,
      },
      contextReferences: this.buildContextReferences(included),
    };
  }

  /**
   * Drop compliance items the crew-linked user may not read (e.g. Personnel /
   * Insurance / Legal for ratings). Users NOT linked to a crew member — admins
   * and legacy accounts — get `null` (no restriction) and see everything.
   * Unknown archetypes fail open (not access-gated).
   */
  private async applyAccess(
    items: ComplianceItem[],
    userId: string | null | undefined,
    shipId: string | null,
  ): Promise<ComplianceItem[]> {
    if (!userId || !shipId) return items;
    const allowed = await this.accessControlService.allowedCategories(
      userId,
      shipId,
    );
    if (!allowed) return items; // no crew linkage → legacy full access
    return items.filter((item) => {
      const category = categoryForArchetype(item.archetype);
      return category === null || allowed.has(category);
    });
  }

  private async loadItems(shipId: string | null): Promise<ComplianceItem[]> {
    if (!shipId) {
      return [];
    }

    try {
      const overview = await this.complianceService.overview(shipId);
      return this.flatten(overview);
    } catch (error) {
      this.logger.error(
        `Failed to load compliance overview for ship ${shipId}: ${String(error)}`,
      );
      return [];
    }
  }

  /**
   * Flatten the section → type → record overview into a flat list of compliance
   * items. A required type with no record surfaces as a single `missing` item.
   */
  private flatten(
    overview: Awaited<ReturnType<ComplianceService['overview']>>,
  ): ComplianceItem[] {
    const items: ComplianceItem[] = [];

    for (const section of overview.sections) {
      const sectionName = String(section.sectionName ?? section.sectionCode ?? '');

      for (const type of section.types) {
        // Publications are owned by the Platform Publications (KB) module, not
        // the compliance register — skip the PUBLICATION archetype here so they
        // are not answered from two places (single source of truth = Publications).
        if (this.str(type.archetype) === 'PUBLICATION') {
          continue;
        }

        const typeName = this.str(type.name) ?? 'Unknown document';
        const archetype = this.str(type.archetype);
        const surveyWindow = this.str(type.surveyWindow);
        const renewalCycle = this.str(type.renewalCycle);
        const typeStatus = this.str(type.status);
        const applicabilityVerdict = this.str(type.applicabilityVerdict);
        const allRecords = Array.isArray(type.records)
          ? (type.records as Array<Record<string, unknown>>)
          : [];
        // Superseded and archived issues are history, not evidence in force —
        // reporting them would tell the crew a replaced certificate is on file.
        const records = allRecords.filter((record) => {
          const state = this.str(record.recordState);
          return !state || state === 'current';
        });

        if (!records.length) {
          // 'missing' is decided by the applicability matrix: it means this
          // vessel is REQUIRED to hold the document and none is on file.
          // 'conditional' means the matrix has not established that it is
          // needed here — never report that as a gap.
          if (typeStatus === 'missing') {
            items.push({
              section: sectionName,
              typeName,
              status: 'missing',
              certNo: null,
              issuer: null,
              expiryDate: null,
              assetName: null,
              surveyWindow,
              renewalCycle,
              recordId: null,
              archetype,
              applicabilityVerdict,
              attachments: [],
            });
          }
          continue;
        }

        for (const record of records) {
          items.push({
            section: sectionName,
            typeName,
            status: this.str(record.status) ?? 'valid',
            certNo: this.str(record.certNo),
            issuer: this.str(record.issuer),
            expiryDate: this.str(record.expiryDate),
            assetName: this.str(record.assetName),
            surveyWindow,
            renewalCycle,
            recordId: this.str(record.id),
            archetype,
            applicabilityVerdict,
            attachments: Array.isArray(record.attachments)
              ? (record.attachments as Array<Record<string, unknown>>).map((a) => ({
                  kind: this.str(a.kind),
                  label: this.str(a.label),
                  fileName: this.str(a.fileName),
                }))
              : [],
          });
        }
      }
    }

    return items;
  }

  /**
   * Surface relevant certificates first (matching the question's equipment /
   * document-type wording), then by urgency: expired → expiring → missing →
   * valid, with nearer expiry first within a status.
   */
  private rankForQuestion(
    items: ComplianceItem[],
    question: string,
  ): ComplianceItem[] {
    const normalizedQuestion = question.toLowerCase();

    const relevance = (item: ComplianceItem): number =>
      this.matchesQuestion(item, normalizedQuestion) ? 0 : 1;

    const statusRank: Record<string, number> = {
      expired: 0,
      expiring: 1,
      missing: 2,
      valid: 3,
    };

    return [...items].sort((left, right) => {
      const relevanceDelta = relevance(left) - relevance(right);
      if (relevanceDelta !== 0) return relevanceDelta;

      const statusDelta =
        (statusRank[left.status] ?? 4) - (statusRank[right.status] ?? 4);
      if (statusDelta !== 0) return statusDelta;

      return this.compareExpiry(left.expiryDate, right.expiryDate);
    });
  }

  /** Does the record's type / equipment / section wording appear in the question? */
  private matchesQuestion(item: ComplianceItem, normalizedQuestion: string): boolean {
    const haystack = [item.typeName, item.assetName, item.section]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase());
    return haystack.some(
      (value) =>
        value.length >= 4 &&
        (normalizedQuestion.includes(value) ||
          this.shareSignificantToken(normalizedQuestion, value)),
    );
  }

  private shareSignificantToken(question: string, value: string): boolean {
    const tokens = value.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4);
    return tokens.some((token) => question.includes(token));
  }

  private compareExpiry(left: string | null, right: string | null): number {
    const leftTime = left ? Date.parse(left) : Number.POSITIVE_INFINITY;
    const rightTime = right ? Date.parse(right) : Number.POSITIVE_INFINITY;
    const safeLeft = Number.isFinite(leftTime) ? leftTime : Number.POSITIVE_INFINITY;
    const safeRight = Number.isFinite(rightTime)
      ? rightTime
      : Number.POSITIVE_INFINITY;
    return safeLeft - safeRight;
  }

  private async composeAnswer(input: {
    question: string;
    responseLanguage: string | null;
    items: ComplianceItem[];
    gaps: ComplianceItem[];
    totalCount: number;
    texts: Map<string, string>;
  }): Promise<string> {
    const register = this.formatRegister(
      input.items,
      input.gaps,
      input.totalCount,
      input.texts,
    );

    const systemPrompt = [
      'You are the compliance & document-control assistant for the Trident yacht platform.',
      "Answer the user's compliance question using ONLY the compliance register below.",
      "These records come from the vessel's structured Compliance Docs (doc-control) module — the source of truth for the status of ALL statutory and controlled documents (certificates, equipment servicing records, type approvals, crew certificates, insurance, required plans, record books, survey reports, agreements, legal docs), not manuals or uploaded document copies.",
      'Some records include a "full text" block — the transcribed body of that document. Use it to answer detailed body-level questions, but never invent content that is not present.',
      'Status meaning: EXPIRED = past its expiry date; EXPIRING = expires within ~90 days; VALID = in date (or permanent).',
      'The register has two blocks. DOCUMENTS ON FILE lists the records the vessel holds; it may be truncated, and the line at its end says so. REQUIRED FOR THIS VESSEL BUT NOT ON FILE is the complete, authoritative list of gaps — it is never truncated.',
      'A document counts as missing ONLY if it appears in that second block. That block is already filtered by the vessel applicability matrix (its size, flag and commercial/private operation), so it excludes documents that do not apply to this vessel and documents that are only conditionally required until someone confirms they apply here.',
      'When asked what is missing, what is outstanding, or what the vessel still needs: answer from the REQUIRED ... NOT ON FILE block ONLY. Name the individual documents, grouped by section. Never answer with section names alone, never list a whole section as missing, and never count documents that are not in that block. If the block says none, say nothing is missing.',
      'If no record in the register is relevant to the question, say so plainly — do NOT invent documents, dates, issuers, or numbers.',
      'A record can hold several attached papers, listed after "attached:" with their tags. One row deliberately covers more than one document — the yacht\'s and the tender\'s certificate under the same row, or one supplement per jurisdiction. When the question is about a particular vessel, jurisdiction or paper, answer from the matching attachment and name its tag; never assume a record covers only the vessel itself.',
      'The register records only WHETHER a document is on file. It does not record why one is absent, what the consequences are, or how urgent it is. Never state a reason for an absence, an operational or legal impact, a penalty, or an urgency/priority rating — none of that is in the data. Report what is missing, plus the renewal cycle and survey window where the register gives them.',
      'Be concise and practical. Lead with expired/expiring/missing items when the user asks what needs attention. Quote expiry dates and document/certificate numbers when present.',
      input.responseLanguage
        ? `Write the answer in this language: ${input.responseLanguage}.`
        : 'Write the answer in the same language as the question.',
      CHAT_ANSWER_HYGIENE_RULE,
    ].join('\n');

    const userPrompt = [
      `Question: ${input.question}`,
      '',
      'Compliance register:',
      register,
    ].join('\n');

    const reply = await this.chatLlmService.completeText({
      systemPrompt,
      userPrompt,
      temperature: 0,
      maxTokens: 700,
      useMainModel: true,
    });

    return (
      reply?.trim() ||
      'I could not compose a compliance answer right now. Please try again.'
    );
  }

  private formatRegister(
    items: ComplianceItem[],
    gaps: ComplianceItem[],
    totalCount: number,
    texts: Map<string, string>,
  ): string {
    if (!items.length && !gaps.length) {
      return 'No compliance documents are registered for this vessel.';
    }

    const lines = items.map((item, index) => {
      const parts: string[] = [
        `[${index + 1}] "${item.typeName}"`,
        `status: ${item.status.toUpperCase()}`,
      ];

      if (item.section) parts.push(`section: ${item.section}`);
      if (item.expiryDate) parts.push(`expiry: ${item.expiryDate}`);
      if (item.certNo) parts.push(`cert no: ${item.certNo}`);
      if (item.issuer) parts.push(`issuer: ${item.issuer}`);
      if (item.assetName) parts.push(`equipment: ${item.assetName}`);
      if (item.surveyWindow) parts.push(`survey window: ${item.surveyWindow}`);
      if (item.renewalCycle) parts.push(`renewal: ${item.renewalCycle}`);
      if (item.attachments.length) {
        // What is actually filed under this record. One row legitimately holds
        // several papers — the yacht's and the tender's, or one per
        // jurisdiction — and the tag is the only thing that tells them apart.
        const tags = item.attachments.map((a) =>
          [a.label, a.kind ? a.kind.replace(/_/g, ' ') : null, a.fileName]
            .filter(Boolean)
            .join(' — '),
        );
        parts.push(`attached (${tags.length}): ${tags.join('; ')}`);
      }

      let line = parts.join(' | ');
      const text = item.recordId ? texts.get(item.recordId) : null;
      if (text) {
        line += `\n    full text:\n${text.slice(0, this.maxTextChars)}`;
      }
      return line;
    });

    if (totalCount > items.length) {
      lines.push(
        `(showing ${items.length} of ${totalCount} records on file — ask about a specific certificate or piece of equipment to narrow down)`,
      );
    }

    const out = items.length
      ? ['DOCUMENTS ON FILE:', ...lines]
      : ['DOCUMENTS ON FILE: none.'];

    if (gaps.length) {
      const bySection = new Map<string, string[]>();
      for (const gap of gaps) {
        const key = gap.section || 'Other';
        const list = bySection.get(key) ?? [];
        list.push(gap.typeName);
        bySection.set(key, list);
      }
      out.push(
        '',
        `REQUIRED FOR THIS VESSEL BUT NOT ON FILE (${gaps.length}) — this list is COMPLETE, it is the answer to "what is missing":`,
      );
      for (const [section, names] of bySection) {
        out.push(`  ${section}: ${names.join('; ')}`);
      }
    } else {
      out.push('', 'REQUIRED FOR THIS VESSEL BUT NOT ON FILE: none.');
    }

    return out.join('\n');
  }

  private buildContextReferences(items: ComplianceItem[]): unknown[] {
    return items
      .filter((item) => item.recordId)
      .map((item, index) => ({
        id: `compliance-doc-${item.recordId}`,
        sourceType: 'compliance_doc',
        rank: index + 1,
        sourceTitle: item.typeName,
        recordId: item.recordId,
        status: item.status,
        snippet: [
          item.status.toUpperCase(),
          item.expiryDate ? `expires ${item.expiryDate}` : null,
          item.certNo,
        ]
          .filter(Boolean)
          .join(' · '),
      }));
  }

  private str(value: unknown): string | null {
    if (typeof value === 'string') {
      return value.trim() || null;
    }
    if (typeof value === 'number') {
      return String(value);
    }
    return null;
  }
}
