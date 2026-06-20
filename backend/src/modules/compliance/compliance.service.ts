import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ShipEntity } from '../ships/entities/ship.entity';
import {
  deriveFlagRegistry,
  deriveGtBucket,
  FLAG_REGISTRY_COLUMN,
  GT_BUCKET_COLUMN,
  resolveApplicability,
} from './compliance-profile.util';
import { ComplianceDocMasterEntity } from './entities/compliance-doc-master.entity';
import { ComplianceDocTypeEntity } from './entities/compliance-doc-type.entity';
import { ComplianceDocEntity } from './entities/compliance-doc.entity';
import { DocAssetLinkEntity } from './entities/doc-asset-link.entity';
import { PmsService } from '../pms/pms.service';
import {
  ARCHETYPE_FIELDS,
  BASE_FIELDS,
  complianceTaskSpec,
  identityChecks,
  linkRoleForArchetype,
  requiredFields,
  storedBlock,
  validityField,
} from './compliance-archetypes';

export type ComplianceStatus = 'valid' | 'expiring' | 'expired' | 'missing';

const EXPIRING_DAYS = 90;

export interface UpsertComplianceDocInput {
  docTypeId: string;
  certNo?: string | null;
  issuer?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  assetId?: string | null;
  documentId?: string | null;
  notes?: string | null;
  // doc-control schema v9
  fields?: Record<string, unknown> | null;
  verifyState?: string;
  extractedConfidence?: number | null;
  // primary link target (which one applies is driven by link_cardinality)
  crewMemberId?: string | null;
}

@Injectable()
export class ComplianceService {
  constructor(
    @InjectRepository(ComplianceDocTypeEntity)
    private readonly typeRepository: Repository<ComplianceDocTypeEntity>,
    @InjectRepository(ComplianceDocEntity)
    private readonly docRepository: Repository<ComplianceDocEntity>,
    @InjectRepository(ComplianceDocMasterEntity)
    private readonly masterRepository: Repository<ComplianceDocMasterEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipRepository: Repository<ShipEntity>,
    @InjectRepository(DocAssetLinkEntity)
    private readonly linkRepository: Repository<DocAssetLinkEntity>,
    private readonly pmsService: PmsService,
  ) {}

  /**
   * Keep the PMS task driven by a compliance record in sync (D4). The
   * document's validity date + drives_pms behaviour decide the task; linked
   * assets carry over. No date / non-task behaviour → the task is removed.
   */
  private async syncPmsForDoc(
    shipId: string,
    doc: ComplianceDocEntity,
    type: ComplianceDocTypeEntity | null,
  ): Promise<void> {
    const spec = complianceTaskSpec(type?.drivesPms ?? null);
    if (!spec || !doc.expiryDate) {
      await this.pmsService.removeForCompliance(doc.id);
      return;
    }
    const links = await this.linkRepository.find({ where: { docId: doc.id } });
    const assetIds = links
      .map((l) => l.assetId)
      .filter((id): id is string => !!id);
    await this.pmsService.syncFromCompliance(shipId, {
      docId: doc.id,
      title: `${spec.verb}: ${type?.name ?? 'document'}`,
      dueDate: doc.expiryDate,
      category: spec.category,
      assetIds,
    });
  }

  /**
   * Reconcile the record's identity fields (serial/model/maker) against the
   * linked asset(s) in the register. The register wins — we only flag the
   * discrepancies. Persisted to identity_flags for display.
   */
  private async computeIdentityFlags(
    doc: ComplianceDocEntity,
    type: ComplianceDocTypeEntity | null,
  ): Promise<Array<Record<string, unknown>> | null> {
    const checks = identityChecks(type?.archetype ?? null);
    if (!checks.length || !doc.fields) return null;
    const links = await this.linkRepository.find({
      where: { docId: doc.id },
      relations: { asset: true },
    });
    const assets = links.map((l) => l.asset).filter((a) => !!a);
    if (!assets.length) return null;

    const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
    const flags: Array<Record<string, unknown>> = [];
    for (const asset of assets) {
      for (const c of checks) {
        const docVal = String(doc.fields[c.field] ?? '').trim();
        const regVal = String(asset![c.column] ?? '').trim();
        if (docVal && regVal && norm(docVal) !== norm(regVal)) {
          flags.push({
            field: c.field,
            documentValue: docVal,
            registerValue: regVal,
            assetName: asset!.displayName,
          });
        }
      }
    }
    return flags.length ? flags : null;
  }

  /**
   * Generate (or refresh) the per-ship rulebook from the vessel-agnostic
   * master matrix using the ship's compliance profile. Existing rows are
   * preserved (admin edits win); only NEW master rows are added — safe to
   * re-run after the master is updated with a new SFI Master version.
   */
  async instantiateForShip(
    shipId: string,
    profile?: {
      gtBucket?: string;
      grossTonnage?: number;
      lengthM?: number;
      operationType?: string;
      flagRegistry?: string | null;
    },
  ): Promise<{ created: number; skipped: number }> {
    const ship = await this.shipRepository.findOne({ where: { id: shipId } });
    if (!ship) throw new NotFoundException('Ship not found');

    if (profile) {
      ship.gtBucket = profile.gtBucket ?? ship.gtBucket;
      ship.grossTonnage = profile.grossTonnage ?? ship.grossTonnage;
      ship.lengthM =
        profile.lengthM != null ? String(profile.lengthM) : ship.lengthM;
      ship.operationType = profile.operationType ?? ship.operationType;
      ship.flagRegistry =
        profile.flagRegistry !== undefined
          ? profile.flagRegistry
          : ship.flagRegistry;
      await this.shipRepository.save(ship);
    }

    // EXACT tonnage wins: users enter real GT + length on the vessel
    // profile; the matrix bucket is derived (the <24m bucket is by LENGTH,
    // the rest by GT). gt_bucket remains a manual fallback/override for
    // ships without exact figures.
    const derivedBucket = deriveGtBucket(
      ship.grossTonnage,
      ship.lengthM != null ? Number(ship.lengthM) : null,
    );
    const effectiveBucket = derivedBucket ?? ship.gtBucket;
    const effectiveFlagRegistry =
      ship.flagRegistry ?? deriveFlagRegistry(ship.flag);

    if (!effectiveBucket || !ship.operationType) {
      throw new BadRequestException(
        'Ship compliance profile incomplete: gross tonnage (or gtBucket) and operationType are required',
      );
    }

    const gtKey = GT_BUCKET_COLUMN[effectiveBucket];
    if (!gtKey) {
      throw new BadRequestException(`Unknown gtBucket ${effectiveBucket}`);
    }
    const opKey: keyof ComplianceDocMasterEntity =
      ship.operationType === 'private' ? 'appPrivate' : 'appCommercial';
    const flagKey = effectiveFlagRegistry
      ? FLAG_REGISTRY_COLUMN[effectiveFlagRegistry]
      : null;

    const [master, existing] = await Promise.all([
      this.masterRepository.find(),
      this.typeRepository.find({ where: { shipId } }),
    ]);
    const existingCodes = new Set(existing.map((type) => type.sfiCode));

    let created = 0;
    const toInsert = master
      .filter((row) => !existingCodes.has(row.sfiCode))
      .map((row) =>
        this.typeRepository.create({
          shipId,
          sfiCode: row.sfiCode,
          sectionCode: row.sectionCode,
          sectionName: row.sectionName,
          name: row.name,
          scope: row.scope,
          linkedSfi: row.linkedSfi,
          applicability: resolveApplicability(row, { gtKey, opKey, flagKey }),
          renewalCycle: row.renewalCycle,
          surveyWindow: row.surveyWindow,
          updateTrigger: row.updateTrigger,
          notes: row.notes,
          // doc-control schema v9 tags carried forward
          archetype: row.archetype,
          linkCardinality: row.linkCardinality,
          regBasis: row.regBasis,
          basisNote: row.basisNote,
          drivesPms: row.drivesPms,
        }),
      );
    if (toInsert.length) {
      await this.typeRepository.save(toInsert, { chunk: 100 });
      created = toInsert.length;
    }
    return { created, skipped: master.length - created };
  }

  /**
   * The whole compliance picture for a ship, grouped by SFI section:
   * every doc type (rulebook) with its records and a derived status.
   * Gap analysis falls out for free — required types with no records
   * surface as 'missing'.
   */
  async overview(shipId: string) {
    const [types, docs] = await Promise.all([
      this.typeRepository.find({
        where: { shipId },
        order: { sfiCode: 'ASC' },
      }),
      this.docRepository.find({
        where: { shipId },
        relations: { asset: true, document: true },
        order: { expiryDate: 'DESC' },
      }),
    ]);

    // Batch-load all asset/crew links for this ship's records.
    const docIds = docs.map((d) => d.id);
    const allLinks = docIds.length
      ? await this.linkRepository.find({
          where: { docId: In(docIds) },
          relations: { asset: true, crewMember: true },
          order: { createdAt: 'ASC' },
        })
      : [];
    const linksByDoc = new Map<string, typeof allLinks>();
    for (const l of allLinks) {
      const list = linksByDoc.get(l.docId) ?? [];
      list.push(l);
      linksByDoc.set(l.docId, list);
    }

    const docsByType = new Map<string, ComplianceDocEntity[]>();
    for (const doc of docs) {
      const list = docsByType.get(doc.docTypeId) ?? [];
      list.push(doc);
      docsByType.set(doc.docTypeId, list);
    }

    const sections = new Map<
      string,
      {
        sectionCode: string;
        sectionName: string;
        types: Array<Record<string, unknown>>;
        counts: Record<ComplianceStatus | 'not_required', number>;
      }
    >();

    for (const type of types) {
      let section = sections.get(type.sectionCode);
      if (!section) {
        section = {
          sectionCode: type.sectionCode,
          sectionName: type.sectionName,
          types: [],
          counts: { valid: 0, expiring: 0, expired: 0, missing: 0, not_required: 0 },
        };
        sections.set(type.sectionCode, section);
      }

      const records = docsByType.get(type.id) ?? [];
      const status = this.typeStatus(type, records);
      if (status === null) {
        section.counts.not_required += 1;
      } else {
        section.counts[status] += 1;
      }

      section.types.push({
        id: type.id,
        sfiCode: type.sfiCode,
        name: type.name,
        scope: type.scope,
        linkedSfi: type.linkedSfi,
        applicability: type.applicability,
        renewalCycle: type.renewalCycle,
        surveyWindow: type.surveyWindow,
        updateTrigger: type.updateTrigger,
        notes: type.notes,
        archetype: type.archetype,
        linkCardinality: type.linkCardinality,
        regBasis: type.regBasis,
        basisNote: type.basisNote,
        drivesPms: type.drivesPms,
        status,
        records: records.map((doc) => ({
          id: doc.id,
          certNo: doc.certNo,
          issuer: doc.issuer,
          issueDate: doc.issueDate,
          expiryDate: doc.expiryDate,
          status: this.recordStatus(doc),
          assetId: doc.assetId,
          assetName: doc.asset?.displayName ?? null,
          documentId: doc.documentId,
          documentFileName: doc.document?.originalFileName ?? null,
          notes: doc.notes,
          fields: doc.fields ?? null,
          verifyState: doc.verifyState,
          extractedConfidence:
            doc.extractedConfidence != null
              ? Number(doc.extractedConfidence)
              : null,
          identityFlags: doc.identityFlags ?? null,
          links: (linksByDoc.get(doc.id) ?? []).map((l) => ({
            id: l.id,
            assetId: l.assetId,
            assetName: l.asset?.displayName ?? null,
            crewMemberId: l.crewMemberId,
            crewName: l.crewMember?.name ?? null,
            linkRole: l.linkRole,
            verifyState: l.verifyState,
          })),
        })),
      });
    }

    const numeric = (code: string) =>
      code.split('.').map((part) => parseInt(part, 10) || 0);
    const byCode = (a: string, b: string) => {
      const [na, nb] = [numeric(a), numeric(b)];
      for (let i = 0; i < Math.max(na.length, nb.length); i++) {
        const diff = (na[i] ?? 0) - (nb[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    };
    const ordered = [...sections.values()].sort((a, b) =>
      byCode(a.sectionCode, b.sectionCode),
    );
    for (const section of ordered) {
      section.types.sort((a, b) =>
        byCode(String(a.sfiCode), String(b.sfiCode)),
      );
    }
    return { shipId, sections: ordered };
  }

  /** Records linked to one asset — feeds the asset drawer Certs tab. */
  async listForAsset(shipId: string, assetId: string) {
    const docs = await this.docRepository.find({
      where: { shipId, assetId },
      relations: { docType: true, document: true },
      order: { expiryDate: 'DESC' },
    });
    return docs.map((doc) => ({
      id: doc.id,
      sfiCode: doc.docType?.sfiCode ?? null,
      typeName: doc.docType?.name ?? null,
      certNo: doc.certNo,
      issuer: doc.issuer,
      issueDate: doc.issueDate,
      expiryDate: doc.expiryDate,
      status: this.recordStatus(doc),
      documentId: doc.documentId,
      documentFileName: doc.document?.originalFileName ?? null,
    }));
  }

  async createDoc(
    shipId: string,
    input: UpsertComplianceDocInput,
    opts?: { draft?: boolean },
  ) {
    const type = await this.typeRepository.findOne({
      where: { id: input.docTypeId, shipId },
    });
    if (!type) {
      throw new NotFoundException('Compliance doc type not found on this ship');
    }
    const fields = this.sanitizeFields(type.archetype, input.fields);
    // Auto-extracted drafts skip required/hard-match — the operator fills
    // any gaps and links assets when they confirm the record.
    if (!opts?.draft) this.validateRequired(type.archetype, fields);

    // What a document links to is driven by its cardinality (schema v9):
    //   person → a crew member; vessel → nothing; else → an asset (hard-match).
    const cardinality = type.linkCardinality;
    const assetCardinality =
      cardinality === 'single_asset' ||
      cardinality === 'per_unit' ||
      cardinality === 'sub_group';
    if (!opts?.draft) {
      if (cardinality === 'person' && !input.crewMemberId) {
        throw new BadRequestException(
          'This document requires a linked crew member.',
        );
      } else if (assetCardinality && !input.assetId) {
        throw new BadRequestException('This document requires a linked asset.');
      }
    }

    // The [AUTH] validity field is the canonical expiry for status.
    const expiryDate =
      this.authExpiry(type.archetype, fields) ?? input.expiryDate ?? null;
    const saved = await this.docRepository.save(
      this.docRepository.create({
        shipId,
        docTypeId: input.docTypeId,
        certNo: input.certNo ?? null,
        issuer: input.issuer ?? null,
        issueDate: input.issueDate ?? null,
        expiryDate,
        // asset_id is the deprecated single-asset mirror; only for asset docs.
        assetId:
          cardinality === 'person' || cardinality === 'vessel'
            ? null
            : (input.assetId ?? null),
        documentId: input.documentId ?? null,
        notes: input.notes ?? null,
        fields,
        verifyState: input.verifyState === 'auto' ? 'auto' : 'confirmed',
        extractedConfidence:
          input.extractedConfidence != null
            ? String(input.extractedConfidence)
            : null,
      }),
    );
    // Mirror the primary link into the M:N link model.
    if (cardinality === 'person' && input.crewMemberId) {
      await this.addLink(shipId, saved.id, { crewMemberId: input.crewMemberId });
    } else if (cardinality !== 'vessel' && input.assetId) {
      await this.addLink(shipId, saved.id, { assetId: input.assetId });
    }
    // Document wins, PMS follows — drive the linked maintenance task.
    await this.syncPmsForDoc(shipId, saved, type);
    // Register wins — flag any identity mismatch vs the linked asset.
    saved.identityFlags = await this.computeIdentityFlags(saved, type);
    await this.docRepository.save(saved);
    return { ...saved, status: this.recordStatus(saved) };
  }

  // ── Link_Model (doc ↔ assets / crew) ──

  /** Add an asset (or crew) link to a compliance document. */
  async addLink(
    shipId: string,
    docId: string,
    input: { assetId?: string | null; crewMemberId?: string | null },
  ) {
    const doc = await this.docRepository.findOne({
      where: { id: docId, shipId },
      relations: { docType: true },
    });
    if (!doc) throw new NotFoundException('Compliance doc not found');
    if (!!input.assetId === !!input.crewMemberId) {
      throw new BadRequestException(
        'Provide exactly one of assetId or crewMemberId.',
      );
    }
    // Idempotent on (doc, asset).
    if (input.assetId) {
      const existing = await this.linkRepository.findOne({
        where: { docId, assetId: input.assetId },
      });
      if (existing) return existing;
    }
    return this.linkRepository.save(
      this.linkRepository.create({
        docId,
        assetId: input.assetId ?? null,
        crewMemberId: input.crewMemberId ?? null,
        resolutionSfi: doc.docType?.linkedSfi ?? null,
        linkRole: linkRoleForArchetype(doc.docType?.archetype ?? null),
        matchMethod: 'manual_confirm',
        verifyState: 'confirmed',
      }),
    );
  }

  async removeLink(shipId: string, docId: string, linkId: string): Promise<void> {
    const doc = await this.docRepository.findOne({
      where: { id: docId, shipId },
    });
    if (!doc) throw new NotFoundException('Compliance doc not found');
    await this.linkRepository.delete({ id: linkId, docId });
    // Keep the deprecated single column in step if it pointed here.
    const remaining = await this.linkRepository.find({ where: { docId } });
    if (!remaining.some((l) => l.assetId === doc.assetId)) {
      doc.assetId = remaining.find((l) => l.assetId)?.assetId ?? null;
      await this.docRepository.save(doc);
    }
  }

  /** All links for a document, with resolved asset / crew names. */
  async listLinks(shipId: string, docId: string) {
    const doc = await this.docRepository.findOne({
      where: { id: docId, shipId },
    });
    if (!doc) throw new NotFoundException('Compliance doc not found');
    const links = await this.linkRepository.find({
      where: { docId },
      relations: { asset: true, crewMember: true },
      order: { createdAt: 'ASC' },
    });
    return links.map((l) => ({
      id: l.id,
      assetId: l.assetId,
      assetName: l.asset?.displayName ?? null,
      crewMemberId: l.crewMemberId,
      crewName: l.crewMember?.name ?? null,
      linkRole: l.linkRole,
      matchMethod: l.matchMethod,
      verifyState: l.verifyState,
      resolutionSfi: l.resolutionSfi,
    }));
  }

  async updateDoc(
    shipId: string,
    docId: string,
    input: Partial<UpsertComplianceDocInput>,
  ) {
    const doc = await this.docRepository.findOne({
      where: { id: docId, shipId },
    });
    if (!doc) throw new NotFoundException('Compliance doc not found');
    if (input.docTypeId && input.docTypeId !== doc.docTypeId) {
      throw new BadRequestException('docTypeId cannot be changed');
    }
    const type = await this.typeRepository.findOne({
      where: { id: doc.docTypeId },
    });
    const archetype = type?.archetype ?? null;

    // Merge archetype fields if provided, then re-validate + re-derive expiry.
    const nextFields =
      input.fields !== undefined
        ? this.sanitizeFields(archetype, input.fields)
        : (doc.fields ?? null);
    if (input.fields !== undefined) {
      this.validateRequired(archetype, nextFields);
    }
    const authExpiry = this.authExpiry(archetype, nextFields);

    Object.assign(doc, {
      certNo: input.certNo !== undefined ? input.certNo : doc.certNo,
      issuer: input.issuer !== undefined ? input.issuer : doc.issuer,
      issueDate: input.issueDate !== undefined ? input.issueDate : doc.issueDate,
      expiryDate:
        authExpiry ??
        (input.expiryDate !== undefined ? input.expiryDate : doc.expiryDate),
      assetId: input.assetId !== undefined ? input.assetId : doc.assetId,
      documentId:
        input.documentId !== undefined ? input.documentId : doc.documentId,
      notes: input.notes !== undefined ? input.notes : doc.notes,
      fields: nextFields,
      verifyState:
        input.verifyState !== undefined
          ? input.verifyState === 'auto'
            ? 'auto'
            : 'confirmed'
          : doc.verifyState,
      extractedConfidence:
        input.extractedConfidence !== undefined
          ? input.extractedConfidence != null
            ? String(input.extractedConfidence)
            : null
          : doc.extractedConfidence,
    });
    const saved = await this.docRepository.save(doc);
    // Re-sync the driven PMS task (expiry may have moved).
    await this.syncPmsForDoc(shipId, saved, type ?? null);
    saved.identityFlags = await this.computeIdentityFlags(saved, type ?? null);
    await this.docRepository.save(saved);
    return { ...saved, status: this.recordStatus(saved) };
  }

  /** Archetype field schema (BASE + per-archetype blocks) for UI forms. */
  archetypeSchema() {
    return { base: BASE_FIELDS, archetypes: ARCHETYPE_FIELDS };
  }

  // ── archetype field helpers (doc-control schema v9) ──

  /** Keep only fields defined for the archetype; drop unknowns/empties. */
  private sanitizeFields(
    archetype: string | null,
    input?: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!input || typeof input !== 'object') return null;
    const allowed = new Set(storedBlock(archetype).map((f) => f.field));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (allowed.has(k) && v !== null && v !== undefined && v !== '') {
        out[k] = v;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  /** Throw if a required archetype field is missing. */
  private validateRequired(
    archetype: string | null,
    fields: Record<string, unknown> | null,
  ): void {
    const missing = requiredFields(archetype).filter(
      (f) => fields?.[f] == null || fields[f] === '',
    );
    if (missing.length) {
      throw new BadRequestException(
        `Missing required ${archetype ?? 'document'} field(s): ${missing.join(', ')}`,
      );
    }
  }

  /** Value of the archetype's validity date field (→ canonical expiry_date). */
  private authExpiry(
    archetype: string | null,
    fields: Record<string, unknown> | null,
  ): string | null {
    const vf = validityField(archetype);
    const v = vf && fields ? fields[vf] : null;
    return typeof v === 'string' && v ? v : null;
  }

  async deleteDoc(shipId: string, docId: string): Promise<void> {
    const doc = await this.docRepository.findOne({
      where: { id: docId, shipId },
    });
    if (!doc) throw new NotFoundException('Compliance doc not found');
    // Drop the PMS task this cert drove (the deadline is gone with it).
    await this.pmsService.removeForCompliance(doc.id);
    await this.docRepository.delete(doc.id);
  }

  /** Update applicability / logic fields on a rulebook row. */
  async updateType(
    shipId: string,
    typeId: string,
    input: Partial<
      Pick<
        ComplianceDocTypeEntity,
        'applicability' | 'renewalCycle' | 'surveyWindow' | 'updateTrigger' | 'notes'
      >
    >,
  ) {
    const type = await this.typeRepository.findOne({
      where: { id: typeId, shipId },
    });
    if (!type) throw new NotFoundException('Compliance doc type not found');
    Object.assign(type, input);
    return this.typeRepository.save(type);
  }

  private recordStatus(doc: ComplianceDocEntity): ComplianceStatus {
    if (!doc.expiryDate) return 'valid'; // permanent / no-expiry docs
    const expiry = new Date(doc.expiryDate);
    const now = new Date();
    if (expiry.getTime() < now.getTime()) return 'expired';
    const days = (expiry.getTime() - now.getTime()) / 86_400_000;
    return days <= EXPIRING_DAYS ? 'expiring' : 'valid';
  }

  /**
   * Type-level verdict: null for not-required types (N / R / blank);
   * 'missing' when required but no records; otherwise the WORST record
   * status (one expired liferaft cert makes the whole LSA line expired —
   * Shaun's many-units semantics).
   */
  private typeStatus(
    type: ComplianceDocTypeEntity,
    records: ComplianceDocEntity[],
  ): ComplianceStatus | null {
    if (type.applicability !== 'Y' && type.applicability !== 'C') return null;
    if (!records.length) return 'missing';
    const order: ComplianceStatus[] = ['expired', 'expiring', 'valid'];
    for (const status of order) {
      if (records.some((doc) => this.recordStatus(doc) === status)) {
        return status;
      }
    }
    return 'valid';
  }
}
