import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import pdfParse from 'pdf-parse';
import { LlmService } from '../../integrations/llm/llm.service';
import { AssetEntity } from '../assets/entities/asset.entity';
import { ComplianceDocTypeEntity } from './entities/compliance-doc-type.entity';
import { ComplianceService } from './compliance.service';
import { archetypeBlock } from './compliance-archetypes';

interface IngestItem {
  filename: string;
  text?: string;
  buffer?: Buffer;
}

/** One file's AI proposal — shown in the review window, NOT yet saved. */
export interface IngestProposal {
  filename: string;
  status: 'matched' | 'unmatched' | 'error';
  typeId?: string | null;
  sfiCode?: string | null;
  typeName?: string | null;
  archetype?: string | null;
  certNo?: string | null;
  issuer?: string | null;
  issueDate?: string | null;
  fields?: Record<string, unknown>;
  assetId?: string | null;
  assetName?: string | null;
  confidence?: number;
  message?: string;
}

/** A reviewed/edited proposal coming back to be committed. */
export interface CommitProposal {
  typeId: string;
  certNo?: string | null;
  issuer?: string | null;
  issueDate?: string | null;
  fields?: Record<string, unknown> | null;
  assetId?: string | null;
  crewMemberId?: string | null;
}

export interface CommitResult {
  filename?: string;
  status: 'created' | 'error';
  recordId?: string;
  message?: string;
}

const MAX_TEXT = 8000;

/** Claude-supported image media type for a filename, or null (→ pdf path). */
function imageMediaType(filename: string): string | null {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

@Injectable()
export class ComplianceExtractionService {
  private readonly logger = new Logger(ComplianceExtractionService.name);

  constructor(
    private readonly llmService: LlmService,
    private readonly complianceService: ComplianceService,
    @InjectRepository(ComplianceDocTypeEntity)
    private readonly typeRepository: Repository<ComplianceDocTypeEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
  ) {}

  /**
   * Read a batch of compliance documents and PROPOSE a type + fields + link
   * for each — nothing is saved. The operator reviews/edits these in the
   * upload window, then commit() persists the confirmed ones.
   */
  async preview(
    shipId: string,
    items: IngestItem[],
  ): Promise<{ proposals: IngestProposal[] }> {
    if (!this.llmService.isConfigured()) {
      throw new ServiceUnavailableException(
        'AI extraction is unavailable (LLM not configured).',
      );
    }
    if (!items.length) throw new BadRequestException('No documents provided.');

    const types = await this.typeRepository.find({ where: { shipId } });
    const assets = await this.assetRepository.find({
      where: { shipId },
      select: ['id', 'displayName', 'brand', 'model', 'serialNo'],
    });

    const proposals: IngestProposal[] = [];
    for (const item of items) {
      proposals.push(await this.proposeOne(item, types, assets));
    }
    return { proposals };
  }

  private async proposeOne(
    item: IngestItem,
    types: ComplianceDocTypeEntity[],
    assets: AssetEntity[],
  ): Promise<IngestProposal> {
    try {
      const text = (item.text?.trim() || (await this.extractText(item))).slice(
        0,
        MAX_TEXT,
      );
      if (!text.trim()) {
        return { filename: item.filename, status: 'error', message: 'No readable text.' };
      }

      const match = await this.classify(types, text);
      const type = match
        ? types.find((t) => t.sfiCode === match.sfiCode)
        : undefined;
      if (!match || !type) {
        return {
          filename: item.filename,
          status: 'unmatched',
          message: 'Could not match a compliance type.',
        };
      }

      const fields = await this.extractFields(type.archetype, text);
      const link = this.resolveAssetLink(type, fields, assets);

      return {
        filename: item.filename,
        status: 'matched',
        typeId: type.id,
        sfiCode: type.sfiCode,
        typeName: type.name,
        archetype: type.archetype,
        certNo: this.str(fields.doc_number),
        issuer: this.str(fields.issuing_party),
        issueDate: this.date(fields.issue_date),
        fields,
        assetId: link?.id ?? null,
        assetName: link?.displayName ?? null,
        confidence: match.confidence,
      };
    } catch (error) {
      this.logger.warn(
        `propose failed for ${item.filename}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return {
        filename: item.filename,
        status: 'error',
        message: error instanceof Error ? error.message : 'Extraction failed.',
      };
    }
  }

  /** Persist the operator-confirmed proposals as real (confirmed) records. */
  async commit(
    shipId: string,
    proposals: CommitProposal[],
  ): Promise<{ results: CommitResult[]; created: number }> {
    if (!proposals?.length) throw new BadRequestException('Nothing to commit.');
    const results: CommitResult[] = [];
    for (const p of proposals) {
      try {
        const record = await this.complianceService.createDoc(shipId, {
          docTypeId: p.typeId,
          certNo: p.certNo ?? null,
          issuer: p.issuer ?? null,
          issueDate: p.issueDate ?? null,
          assetId: p.assetId ?? null,
          crewMemberId: p.crewMemberId ?? null,
          fields: p.fields ?? null,
          verifyState: 'confirmed',
        });
        results.push({ status: 'created', recordId: record.id });
      } catch (error) {
        results.push({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to save.',
        });
      }
    }
    return {
      results,
      created: results.filter((r) => r.status === 'created').length,
    };
  }

  // ── text + LLM ──

  private async extractText(item: IngestItem): Promise<string> {
    if (!item.buffer) throw new BadRequestException('Empty file.');
    // Photos / scans have no embedded text → read them with Claude vision.
    const mediaType = imageMediaType(item.filename);
    if (mediaType) {
      const text = await this.llmService.extractTextFromImage(
        item.buffer,
        mediaType,
      );
      return text ?? '';
    }
    const parsed = await pdfParse(item.buffer);
    return parsed.text ?? '';
  }

  /** Match the document to one of the ship's compliance types. */
  private async classify(
    types: ComplianceDocTypeEntity[],
    text: string,
  ): Promise<{ sfiCode: string; confidence: number } | null> {
    const list = types
      .map((t) => `${t.sfiCode} | ${t.name} | ${t.archetype ?? ''}`)
      .join('\n');
    const result = await this.llmService.createJsonChatCompletion<{
      sfiCode: string | null;
      confidence: number;
    }>({
      systemPrompt: CLASSIFY_PROMPT,
      userPrompt: `Compliance document types (code | name | archetype):\n${list}\n\nDocument text:\n"""\n${text}\n"""`,
      temperature: 0.1,
      maxTokens: 200,
    });
    if (!result?.sfiCode) return null;
    return { sfiCode: result.sfiCode, confidence: result.confidence ?? 0.5 };
  }

  /** Extract the archetype's field values from the document text. */
  private async extractFields(
    archetype: string | null,
    text: string,
  ): Promise<Record<string, unknown>> {
    const block = archetypeBlock(archetype).filter((f) => f.datatype !== 'fk');
    const spec = [
      'doc_number (the certificate / document number)',
      'issuing_party (who issued it)',
      'issue_date (date of issue, ISO)',
      ...block.map(
        (f) => `${f.field} (${f.datatype}; ${f.hint})${f.required ? ' [required]' : ''}`,
      ),
    ].join('\n');
    const result = await this.llmService.createJsonChatCompletion<{
      fields: Record<string, unknown>;
    }>({
      systemPrompt: EXTRACT_PROMPT,
      userPrompt: `Fields to capture:\n${spec}\n\nDocument text:\n"""\n${text}\n"""`,
      temperature: 0.1,
      maxTokens: 1500,
    });
    return result?.fields && typeof result.fields === 'object'
      ? result.fields
      : {};
  }

  /** Resolve an asset link from extracted serial / maker+model (asset docs). */
  private resolveAssetLink(
    type: ComplianceDocTypeEntity,
    fields: Record<string, unknown>,
    assets: AssetEntity[],
  ): AssetEntity | null {
    const card = type.linkCardinality;
    if (card !== 'single_asset' && card !== 'per_unit' && card !== 'sub_group') {
      return null;
    }
    const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
    const serial = norm(fields.equipment_serial ?? fields.serial);
    if (serial) {
      const bySerial = assets.find((a) => norm(a.serialNo) === serial);
      if (bySerial) return bySerial;
    }
    const maker = norm(fields.maker);
    const model = norm(fields.model);
    if (maker && model) {
      const byMakerModel = assets.find(
        (a) => norm(a.brand) === maker && norm(a.model) === model,
      );
      if (byMakerModel) return byMakerModel;
    }
    return null;
  }

  private str(v: unknown): string | null {
    const s = String(v ?? '').trim();
    return s || null;
  }
  private date(v: unknown): string | null {
    const s = String(v ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  }
}

const CLASSIFY_PROMPT = `You identify which compliance document type a vessel certificate is. You are given the ship's list of types (code | name | archetype) and the document's text. Pick the single best matching type. Return ONLY JSON: { "sfiCode": string|null, "confidence": number }. confidence 0..1. If nothing fits, sfiCode null.`;

const EXTRACT_PROMPT = `You extract structured fields from a vessel compliance document's text. Return ONLY JSON: { "fields": { <field>: <value> } }. Use the exact field keys given. Dates as ISO YYYY-MM-DD. Numbers as numbers. Only include fields you can actually find in the text; omit the rest. Do not invent values.`;
