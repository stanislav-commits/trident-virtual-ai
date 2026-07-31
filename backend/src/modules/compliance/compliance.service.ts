import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { In, IsNull, Not, Repository } from 'typeorm';
import { ShipEntity } from '../ships/entities/ship.entity';
import {
  applicabilityVerdict,
  deriveFlagRegistry,
  deriveGtBucket,
  FLAG_REGISTRY_COLUMN,
  GT_BUCKET_COLUMN,
  hideFromRegister,
  resolveApplicability,
} from './compliance-profile.util';
import { ComplianceDocMasterEntity } from './entities/compliance-doc-master.entity';
import { ComplianceDocTypeEntity } from './entities/compliance-doc-type.entity';
import {
  CERT_NO_MAX_LENGTH,
  ComplianceDocEntity,
  ISSUER_MAX_LENGTH,
} from './entities/compliance-doc.entity';
import { DocAssetLinkEntity } from './entities/doc-asset-link.entity';
import {
  COMPLIANCE_ATTACHMENT_KINDS,
  ComplianceDocFileEntity,
} from './entities/compliance-doc-file.entity';
import { PmsService } from '../pms/pms.service';
import { DocumentsService } from '../documents/documents.service';
import { DocumentsUploadStorageService } from '../documents/ingestion/documents-upload-storage.service';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { AdminEventBus } from '../admin-events/admin-event.bus';
import { AccessControlService } from '../access-control/access-control.service';
import {
  categoryForArchetype,
  ResourceCategory,
} from '../access-control/access-positions';
import {
  ARCHETYPE_FIELDS,
  BASE_FIELDS,
  complianceTaskSpec,
  identityChecks,
  linkRoleForArchetype,
  requiredFields,
  CERTIFICATE_FIELD_SPECS,
  NON_RECORD_FIELDS,
  validityField,
} from './compliance-archetypes';

export type { ComplianceStatus } from './compliance-status.util';
import {
  recordStatus,
  typeStatus,
  type ComplianceStatus,
} from './compliance-status.util';
import {
  milestoneSeverity,
  reminderFingerprint,
  reminderMilestone,
  type ReminderMilestone,
  type ReminderSeverity,
} from './compliance-reminders.util';

export interface UpsertComplianceDocInput {
  docTypeId: string;
  certNo?: string | null;
  issuer?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  assetId?: string | null;
  /** Multiple asset links (M:N). Falls back to `assetId` when absent. */
  assetIds?: string[] | null;
  documentId?: string | null;
  notes?: string | null;
  // doc-control schema v9
  fields?: Record<string, unknown> | null;
  verifyState?: string;
  extractedConfidence?: number | null;
  /** Full AI-transcribed document text (for chat full-text answers). */
  extractedText?: string | null;
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
    @InjectRepository(ComplianceDocFileEntity)
    private readonly docFileRepository: Repository<ComplianceDocFileEntity>,
    private readonly pmsService: PmsService,
    private readonly uploadStorage: DocumentsUploadStorageService,
    private readonly documentsService: DocumentsService,
    private readonly adminEvents: AdminEventBus,
    private readonly accessControlService: AccessControlService,
  ) {}

  private emitChange(
    shipId: string,
    action: 'created' | 'updated' | 'deleted',
    entityId?: string,
  ): void {
    this.adminEvents.emit({ domain: 'compliance', action, shipId, entityId });
  }

  /**
   * Load the stored full text for specific compliance records (chat full-text
   * answers). Keyed by record id; only records that actually have text appear.
   */
  async getExtractedTexts(
    shipId: string,
    docIds: string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!docIds.length) return out;
    const rows = await this.docRepository.find({
      where: { shipId, id: In(docIds) },
      select: ['id', 'extractedText'],
    });
    for (const r of rows) {
      if (r.extractedText && r.extractedText.trim()) {
        out.set(r.id, r.extractedText);
      }
    }
    return out;
  }

  /** Records that have a file but no stored text yet (backfill candidates). */
  async docsNeedingText(shipId: string): Promise<ComplianceDocEntity[]> {
    return this.docRepository.find({
      where: [
        { shipId, extractedText: IsNull(), documentId: Not(IsNull()) },
        { shipId, extractedText: IsNull(), fileStorageKey: Not(IsNull()) },
      ],
    });
  }

  /** Store the transcribed full text on a record (backfill / re-extract). */
  async setDocText(shipId: string, docId: string, text: string): Promise<void> {
    await this.docRepository.update(
      { id: docId, shipId },
      { extractedText: text },
    );
  }

  /** Attach a directly-stored original file to a compliance record. */
  async setDocFile(
    shipId: string,
    docId: string,
    file: { storageKey: string; fileName: string; fileMime: string },
  ): Promise<void> {
    await this.docRepository.update(
      { id: docId, shipId },
      {
        fileStorageKey: file.storageKey,
        fileName: file.fileName,
        fileMime: file.fileMime,
      },
    );
  }

  /**
   * Fetch a compliance record's original file for preview/download. Prefers the
   * documents-pipeline file (documentId) and falls back to the directly-stored
   * file (AI batch-ingest path). Throws NotFound if the record has no file.
   */
  async getDocFile(
    shipId: string,
    docId: string,
    user: AuthenticatedUser,
  ): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
    const doc = await this.docRepository.findOne({
      where: { id: docId, shipId },
      relations: { docType: true },
    });
    if (!doc) throw new NotFoundException('Compliance record not found.');
    await this.assertCanReadType(user, shipId, doc.docType?.archetype);

    if (doc.documentId) {
      return this.documentsService.getFile(doc.documentId, user);
    }
    if (doc.fileStorageKey && (await this.uploadStorage.hasUpload(doc.fileStorageKey))) {
      return {
        buffer: await this.uploadStorage.readUpload(doc.fileStorageKey),
        contentType: doc.fileMime || 'application/octet-stream',
        fileName: doc.fileName || 'document',
      };
    }
    throw new NotFoundException('This record has no attached file.');
  }

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
    // Only the issue in force drives maintenance. Without this, backfilling an
    // expired certificate for the archive would raise a task for a deadline
    // that a newer issue has already replaced.
    if (!spec || !doc.expiryDate || doc.recordState !== 'current') {
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
          // version policy
          oneCurrentVersion: row.oneCurrentVersion,
          retainHistory: row.retainHistory,
          autoArchivePrevious: row.autoArchivePrevious,
          mandatoryUpload: row.mandatoryUpload,
        }),
      );
    if (toInsert.length) {
      await this.typeRepository.save(toInsert, { chunk: 100 });
      created = toInsert.length;
    }
    return { created, skipped: master.length - created };
  }

  /**
   * The reminder each certificate currently owes (v60 Phase 3). One entry per
   * CURRENT record whose reminder profile calls for a timed reminder at its
   * days-to-expiry — the RP-01 ladder (90/60/30/14/7/1 days, then overdue).
   * Superseded and archived issues never remind: the record in force does.
   */
  async expiringCertificates(shipId: string): Promise<
    Array<{
      docId: string;
      title: string;
      expiryDate: string | null;
      expired: boolean;
      assetId: string | null;
      message: string | null;
      milestone: ReminderMilestone;
      severity: ReminderSeverity;
      fingerprint: string;
    }>
  > {
    const docs = (
      await this.docRepository.find({
        where: { shipId },
        relations: { docType: true },
      })
    ).filter((d) => !d.recordState || d.recordState === 'current');
    // The alert carries one asset for context; take it from the link model and
    // fall back to the deprecated mirror column for records predating it.
    const docIds = docs.map((d) => d.id);
    const links = docIds.length
      ? await this.linkRepository.find({
          where: { docId: In(docIds), assetId: Not(IsNull()) },
          order: { createdAt: 'ASC' },
        })
      : [];
    const firstAssetByDoc = new Map<string, string>();
    for (const link of links) {
      if (link.assetId && !firstAssetByDoc.has(link.docId)) {
        firstAssetByDoc.set(link.docId, link.assetId);
      }
    }
    const now = Date.now();
    const out: Array<{
      docId: string;
      title: string;
      expiryDate: string | null;
      expired: boolean;
      assetId: string | null;
      message: string | null;
      milestone: ReminderMilestone;
      severity: ReminderSeverity;
      fingerprint: string;
    }> = [];
    for (const d of docs) {
      if (!d.expiryDate) continue;
      const days = Math.ceil(
        (new Date(d.expiryDate).getTime() - now) / 86_400_000,
      );
      const milestone = reminderMilestone(
        d.docType?.reminderProfile ?? null,
        days,
      );
      if (!milestone) continue; // RP-00, or comfortably far from expiry
      const expired = milestone === 'overdue';
      const name = d.docType?.name ?? 'Certificate';
      const cert = d.certNo ? ` (${d.certNo})` : '';
      const title = expired
        ? `${name} expired ${d.expiryDate}${cert}`
        : `${name} expires in ${days}d — ${d.expiryDate}${cert}`;
      out.push({
        docId: d.id,
        title,
        expiryDate: d.expiryDate,
        expired,
        assetId: firstAssetByDoc.get(d.id) ?? d.assetId ?? null,
        message: d.issuer ? `Issuer: ${d.issuer}` : null,
        milestone,
        severity: milestoneSeverity(milestone),
        fingerprint: reminderFingerprint(d.id, milestone, d.expiryDate),
      });
    }
    return out;
  }

  /**
   * The whole compliance picture for a ship, grouped by SFI section:
   * every doc type (rulebook) with its records and a derived status.
   * Gap analysis falls out for free — required types with no records
   * surface as 'missing'.
   */
  async overview(shipId: string, user?: AuthenticatedUser | null) {
    const allowed = await this.readableCategories(user, shipId);
    const ship = await this.shipRepository.findOne({ where: { id: shipId } });
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

    // Supporting-document count per record — the list itself is
    // fetched on demand when a record is opened.
    const attachmentsByDoc = new Map<
      string,
      Array<{ id: string; kind: string | null; label: string | null; fileName: string | null }>
    >();
    if (docIds.length) {
      const files = await this.docFileRepository.find({
        where: { docId: In(docIds) },
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      });
      for (const f of files) {
        const list = attachmentsByDoc.get(f.docId) ?? [];
        list.push({ id: f.id, kind: f.kind, label: f.label, fileName: f.fileName });
        attachmentsByDoc.set(f.docId, list);
      }
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
        counts: Record<ComplianceStatus, number>;
      }
    >();

    for (const type of types) {
      // RBAC: drop whole categories this user's position may not read.
      if (allowed) {
        const category = categoryForArchetype(type.archetype);
        if (category !== null && !allowed.has(category)) continue;
      }

      const records = docsByType.get(type.id) ?? [];

      // Not required for this vessel and nothing uploaded → keep it out of the
      // register entirely. A row that holds records is always shown.
      if (hideFromRegister(type.applicability, records.length)) continue;

      let section = sections.get(type.sectionCode);
      if (!section) {
        section = {
          sectionCode: type.sectionCode,
          sectionName: type.sectionName,
          types: [],
          counts: {
            valid: 0,
            expiring: 0,
            expired: 0,
            missing: 0,
            conditional: 0,
          },
        };
        sections.set(type.sectionCode, section);
      }

      const status = typeStatus(records, type.applicability, linksByDoc);
      section.counts[status] += 1;

      section.types.push({
        id: type.id,
        sfiCode: type.sfiCode,
        name: type.name,
        scope: type.scope,
        linkedSfi: type.linkedSfi,
        applicability: type.applicability,
        applicabilityVerdict: applicabilityVerdict(type.applicability),
        renewalCycle: type.renewalCycle,
        surveyWindow: type.surveyWindow,
        updateTrigger: type.updateTrigger,
        notes: type.notes,
        archetype: type.archetype,
        linkCardinality: type.linkCardinality,
        regBasis: type.regBasis,
        basisNote: type.basisNote,
        drivesPms: type.drivesPms,
        // Document type + validity axes. archetype is still what drives field blocks, PMS specs and
        // the access gate — documentType is displayed and will take over when
        // the field profiles land.
        documentType: type.documentType,
        fieldProfile: type.fieldProfile,
        specialData: type.specialData,
        validityDriver: type.validityDriver,
        reminderProfile: type.reminderProfile,
        libraryRef: type.libraryRef,
        oneCurrentVersion: type.oneCurrentVersion,
        retainHistory: type.retainHistory,
        status,
        records: records.map((doc) => ({
          id: doc.id,
          certNo: doc.certNo,
          issuer: doc.issuer,
          issueDate: doc.issueDate,
          expiryDate: doc.expiryDate,
          status: recordStatus(doc),
          assetId: doc.assetId,
          assetName: doc.asset?.displayName ?? null,
          documentId: doc.documentId,
          documentFileName: doc.document?.originalFileName ?? null,
          hasFile: Boolean(doc.documentId || doc.fileStorageKey),
          notes: doc.notes,
          fields: doc.fields ?? null,
          verifyState: doc.verifyState,
          extractedConfidence:
            doc.extractedConfidence != null
              ? Number(doc.extractedConfidence)
              : null,
          identityFlags: doc.identityFlags ?? null,
          // Tags, not just a count: one record can hold the yacht's and the
          // tender's certificate side by side, and "2 files" does
          // not tell the register — or the chat — which is which.
          attachments: attachmentsByDoc.get(doc.id) ?? [],
          attachmentCount: (attachmentsByDoc.get(doc.id) ?? []).length,
          recordState: doc.recordState,
          revision: doc.revision,
          supersededByDocId: doc.supersededByDocId,
          archivedAt: doc.archivedAt ? doc.archivedAt.toISOString() : null,
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
    // Vessel identity, sent once. The field matrix ticks these on 80-odd
    // documents; they auto-populate from Vessel Master Data rather than
    // being typed onto each certificate.
    const vessel = {
      vessel_gt: ship?.grossTonnage ?? null,
      vessel_nt: ship?.netTonnage ?? null,
      vessel_imo: ship?.imoNumber ?? null,
      official_number: ship?.officialNumber ?? null,
      vessel_call_sign: ship?.callSign ?? null,
      vessel_flag: ship?.flag ?? null,
      port_of_registry: ship?.portOfRegistry ?? null,
      registered_owner: ship?.registeredOwner ?? null,
      principal_dimensions:
        ship?.lengthM && ship?.beamM
          ? `${ship.lengthM} × ${ship.beamM}${ship.depthM ? ` × ${ship.depthM}` : ''} m`
          : null,
    };

    return { shipId, vessel, sections: ordered };
  }

  /**
   * Records linked to one asset — feeds the asset drawer Certs tab.
   *
   * Resolved through doc_asset_links, not the deprecated single
   * `compliance_docs.asset_id`: one service certificate covers many units (a
   * liferaft service report covers every raft on the report), and reading the
   * mirror column showed such a certificate under one asset only.
   */
  async listForAsset(
    shipId: string,
    assetId: string,
    user?: AuthenticatedUser | null,
  ) {
    const links = await this.linkRepository.find({
      where: { assetId },
      select: { docId: true },
    });
    const docIds = [...new Set(links.map((l) => l.docId))];
    if (!docIds.length) return [];

    const allowed = await this.readableCategories(user, shipId);
    const found = await this.docRepository.find({
      where: { shipId, id: In(docIds) },
      relations: { docType: true, document: true },
      order: { expiryDate: 'DESC' },
    });
    const docs = allowed
      ? found.filter((doc) => {
          const category = categoryForArchetype(doc.docType?.archetype);
          return category === null || allowed.has(category);
        })
      : found;
    return docs.map((doc) => ({
      id: doc.id,
      sfiCode: doc.docType?.sfiCode ?? null,
      typeName: doc.docType?.name ?? null,
      certNo: doc.certNo,
      issuer: doc.issuer,
      issueDate: doc.issueDate,
      expiryDate: doc.expiryDate,
      status: recordStatus(doc),
      documentId: doc.documentId,
      documentFileName: doc.document?.originalFileName ?? null,
      // Same rule as the overview: pipeline-stored OR directly-stored file.
      hasFile: Boolean(doc.documentId || doc.fileStorageKey),
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
    // Auto-extracted / freshly-uploaded drafts skip required + hard-match — the
    // operator fills any gaps and links assets when they confirm the record.
    // A bare "Upload PDF" attaches the file first (verifyState 'auto') and the
    // dates/links are completed inline afterwards, so it must not hard-require
    // fields it can't possibly have yet.
    const draft = opts?.draft || input.verifyState === 'auto';
    if (!draft) this.validateRequired(type.archetype, fields);

    // What a document links to is driven by its cardinality (schema v9):
    //   person → a crew member; vessel → nothing; else → asset(s).
    const cardinality = type.linkCardinality;
    // Asset linking is OPTIONAL: operators upload the document first and link
    // the asset(s) afterwards. (Crew certs still need their person.)
    if (!draft && cardinality === 'person' && !input.crewMemberId) {
      throw new BadRequestException(
        'This document requires a linked crew member.',
      );
    }

    // Resolve the asset link set — a document can link to MANY assets (M:N).
    // Accepts assetIds[]; falls back to the legacy single assetId.
    const assetIds =
      cardinality === 'person' || cardinality === 'vessel'
        ? []
        : (input.assetIds?.length
            ? input.assetIds
            : input.assetId
              ? [input.assetId]
              : []
          ).filter((id): id is string => Boolean(id));

    // The [AUTH] validity field is the canonical expiry for status.
    const expiryDate =
      this.authExpiry(type.archetype, fields) ?? input.expiryDate ?? null;
    const saved = await this.docRepository.save(
      this.docRepository.create({
        shipId,
        docTypeId: input.docTypeId,
        certNo: this.capped(input.certNo, CERT_NO_MAX_LENGTH),
        issuer: this.capped(input.issuer, ISSUER_MAX_LENGTH),
        issueDate: input.issueDate ?? null,
        expiryDate,
        // asset_id is the deprecated single-asset mirror of the M:N links.
        assetId: assetIds[0] ?? null,
        documentId: input.documentId ?? null,
        notes: input.notes ?? null,
        fields,
        extractedText: input.extractedText ?? null,
        verifyState: input.verifyState === 'auto' ? 'auto' : 'confirmed',
        extractedConfidence:
          input.extractedConfidence != null
            ? String(input.extractedConfidence)
            : null,
      }),
    );
    // Mirror the links into the M:N link model — one row per linked asset.
    if (cardinality === 'person' && input.crewMemberId) {
      await this.addLink(shipId, saved.id, { crewMemberId: input.crewMemberId });
    } else {
      for (const assetId of assetIds) {
        await this.addLink(shipId, saved.id, { assetId });
      }
    }
    // A new issue replaces the previous one for the same target when the
    // catalogue keeps a single current version and auto-archives the previous. Runs after the links exist,
    // since "same target" is defined by them.
    await this.supersedePrevious(shipId, saved, type);
    // Document wins, PMS follows — drive the linked maintenance task.
    await this.syncPmsForDoc(shipId, saved, type);
    // Register wins — flag any identity mismatch vs the linked asset.
    saved.identityFlags = await this.computeIdentityFlags(saved, type);
    await this.docRepository.save(saved);
    this.emitChange(shipId, 'created', saved.id);
    return { ...saved, status: recordStatus(saved) };
  }

  /** The set of assets/crew a record covers — '' when it covers the vessel. */
  private async targetKey(doc: ComplianceDocEntity): Promise<string> {
    const links = await this.linkRepository.find({ where: { docId: doc.id } });
    if (!links.length) return doc.assetId ?? 'VESSEL';
    return links
      .map((l) => l.assetId ?? l.crewMemberId ?? '')
      .filter(Boolean)
      .sort()
      .join(',');
  }

  /**
   * Two service certificates on an equipment row, neither linked to a unit and
   * carrying different certificate numbers, are two units — not two issues of
   * one certificate. Superseding them buries the first unit's certificate: it
   * leaves the register and the chat register, and the row still reads as
   * covered. Loading the vessel's own certificates did exactly that: the test
   * reports for the jetski, aft-garage and rescue cranes arrived unlinked and
   * two of the three cranes vanished from the register.
   *
   * Only applies where the link is missing (`VESSEL` target on a per-unit row).
   * Once the records are linked, targetKey already keeps the units apart, and a
   * genuine renewal of the same unit shares its certificate number or arrives
   * without one — neither case is caught here.
   */
  private likelyDifferentUnits(
    incoming: ComplianceDocEntity,
    other: ComplianceDocEntity,
    type: ComplianceDocTypeEntity,
    target: string,
  ): boolean {
    if (target !== 'VESSEL') return false;
    if ((type.linkCardinality ?? 'vessel') === 'vessel') return false;
    const a = (incoming.certNo ?? '').trim().toLowerCase();
    const b = (other.certNo ?? '').trim().toLowerCase();
    return Boolean(a) && Boolean(b) && a !== b;
  }

  /**
   * Mark the previous issue superseded when a newer one arrives.
   *
   * Only within the same target: on an equipment type, a certificate for the
   * port crane must not supersede the one for the starboard crane. Only when
   * the catalogue says the type keeps a single current version, and only when
   * the incoming record is genuinely newer — an older certificate uploaded late
   * (backfilling history) supersedes nothing and is filed as history itself.
   */
  private async supersedePrevious(
    shipId: string,
    incoming: ComplianceDocEntity,
    type: ComplianceDocTypeEntity,
  ): Promise<void> {
    if (!type.oneCurrentVersion || !type.autoArchivePrevious) return;

    const siblings = await this.docRepository.find({
      where: { shipId, docTypeId: type.id, recordState: 'current' },
    });
    const others = siblings.filter((d) => d.id !== incoming.id);
    if (!others.length) return;

    const incomingTarget = await this.targetKey(incoming);
    const when = (d: ComplianceDocEntity) =>
      d.expiryDate ?? d.issueDate ?? d.createdAt.toISOString().slice(0, 10);
    const incomingWhen = when(incoming);

    const replaced: ComplianceDocEntity[] = [];
    for (const other of others) {
      if ((await this.targetKey(other)) !== incomingTarget) continue;
      if (this.likelyDifferentUnits(incoming, other, type, incomingTarget)) {
        continue;
      }
      if (when(other) > incomingWhen) {
        // The incoming record is the older one — it is history, not the issue
        // in force. File it as superseded by the sibling instead.
        incoming.recordState = 'superseded';
        incoming.supersededByDocId = other.id;
        incoming.archivedAt = new Date();
        await this.docRepository.save(incoming);
        return;
      }
      other.recordState = 'superseded';
      other.supersededByDocId = incoming.id;
      other.archivedAt = new Date();
      replaced.push(other);
    }
    if (!replaced.length) return;

    await this.docRepository.save(replaced);
    incoming.supersedesDocId = replaced[0].id;
    incoming.revision =
      Math.max(...replaced.map((d) => d.revision ?? 1)) + 1;
    await this.docRepository.save(incoming);
    // The superseded records no longer drive maintenance.
    for (const doc of replaced) {
      await this.pmsService.removeForCompliance(doc.id);
    }
  }

  // ── Supporting documents ──

  /**
   * Attachments on a record: reports, checklists, photos, statements, or a
   * second certificate belonging to the same obligation. `kind` says what the
   * attachment is (Flag Certificate vs Insurer Evidence on 1.11.8); `label` is
   * the free tag (jurisdiction on the P&I supplements,
   * vessel name on the MLC repatriation certificates).
   */
  async listDocFiles(shipId: string, docId: string) {
    await this.requireDoc(shipId, docId);
    const files = await this.docFileRepository.find({
      where: { docId },
      relations: { document: true },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return files.map((f) => ({
      id: f.id,
      fileName: f.fileName ?? f.document?.originalFileName ?? 'document',
      fileMime: f.fileMime,
      kind: f.kind,
      label: f.label,
      sortOrder: f.sortOrder,
      documentId: f.documentId,
      createdAt: f.createdAt.toISOString(),
    }));
  }

  async addDocFile(
    shipId: string,
    docId: string,
    input: {
      documentId?: string | null;
      /** Raw bytes to store against this attachment (the upload path). */
      buffer?: Buffer | null;
      fileName?: string | null;
      fileMime?: string | null;
      kind?: string | null;
      label?: string | null;
    },
  ) {
    await this.requireDoc(shipId, docId);
    const hasBytes = Boolean(input.buffer?.length);
    if (!!input.documentId === hasBytes) {
      throw new BadRequestException(
        'Provide exactly one of documentId or an uploaded file.',
      );
    }
    const kind = this.normalizeAttachmentKind(input.kind);
    const last = await this.docFileRepository.find({
      where: { docId },
      order: { sortOrder: 'DESC' },
      take: 1,
    });

    // The storage key must be unique PER ATTACHMENT. Keying it off the record
    // alone made every attachment overwrite the previous one's bytes, so the
    // Flag certificate and the insurer evidence on the same record both served
    // whichever was uploaded last. The row id is generated up front for that.
    const id = randomUUID();
    const storageKey = hasBytes
      ? await this.uploadStorage.saveUpload(
          `compliance-attachment-${id}`,
          input.buffer as Buffer,
        )
      : null;

    const saved = await this.docFileRepository.save(
      this.docFileRepository.create({
        id,
        docId,
        documentId: input.documentId ?? null,
        fileStorageKey: storageKey,
        fileName: input.fileName ?? null,
        fileMime: input.fileMime ?? null,
        kind,
        label: input.label?.trim() || null,
        sortOrder: (last[0]?.sortOrder ?? -1) + 1,
      }),
    );
    this.emitChange(shipId, 'updated', docId);
    return saved;
  }

  /** Retag an attachment — its kind, its label, or its position. */
  async updateDocFile(
    shipId: string,
    docId: string,
    fileId: string,
    input: { kind?: string | null; label?: string | null; sortOrder?: number },
  ) {
    await this.requireDoc(shipId, docId);
    const file = await this.docFileRepository.findOne({
      where: { id: fileId, docId },
    });
    if (!file) throw new NotFoundException('Attachment not found');
    if (input.kind !== undefined) {
      file.kind = this.normalizeAttachmentKind(input.kind);
    }
    if (input.label !== undefined) file.label = input.label?.trim() || null;
    if (input.sortOrder !== undefined) file.sortOrder = input.sortOrder;
    const saved = await this.docFileRepository.save(file);
    this.emitChange(shipId, 'updated', docId);
    return saved;
  }

  async removeDocFile(shipId: string, docId: string, fileId: string) {
    await this.requireDoc(shipId, docId);
    const file = await this.docFileRepository.findOne({
      where: { id: fileId, docId },
    });
    if (!file) return;
    // Only the directly-stored bytes are ours to drop; a documents-pipeline
    // file is owned by the Documents module and may be linked elsewhere.
    if (file.fileStorageKey) {
      await this.uploadStorage.deleteUpload(file.fileStorageKey);
    }
    await this.docFileRepository.delete(file.id);
    this.emitChange(shipId, 'updated', docId);
  }

  /** Stream one attachment, gated by the parent record's category. */
  async getDocFileAttachment(
    shipId: string,
    docId: string,
    fileId: string,
    user: AuthenticatedUser,
  ): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
    const doc = await this.requireDoc(shipId, docId, { withType: true });
    await this.assertCanReadType(user, shipId, doc.docType?.archetype);
    const file = await this.docFileRepository.findOne({
      where: { id: fileId, docId },
    });
    if (!file) throw new NotFoundException('Attachment not found');
    if (file.documentId) {
      return this.documentsService.getFile(file.documentId, user);
    }
    if (
      file.fileStorageKey &&
      (await this.uploadStorage.hasUpload(file.fileStorageKey))
    ) {
      return {
        buffer: await this.uploadStorage.readUpload(file.fileStorageKey),
        contentType: file.fileMime || 'application/octet-stream',
        fileName: file.fileName || 'document',
      };
    }
    throw new NotFoundException('This attachment has no stored file.');
  }

  private normalizeAttachmentKind(kind: string | null | undefined): string | null {
    if (!kind) return null;
    const value = kind.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return (COMPLIANCE_ATTACHMENT_KINDS as readonly string[]).includes(value)
      ? value
      : 'other';
  }

  private async requireDoc(
    shipId: string,
    docId: string,
    opts?: { withType?: boolean },
  ): Promise<ComplianceDocEntity> {
    const doc = await this.docRepository.findOne({
      where: { id: docId, shipId },
      relations: opts?.withType ? { docType: true } : undefined,
    });
    if (!doc) throw new NotFoundException('Compliance doc not found');
    return doc;
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
    const link = await this.linkRepository.save(
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
    this.emitChange(shipId, 'updated', docId);
    return link;
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
    this.emitChange(shipId, 'updated', docId);
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
      certNo:
        input.certNo !== undefined
          ? this.capped(input.certNo, CERT_NO_MAX_LENGTH)
          : doc.certNo,
      issuer:
        input.issuer !== undefined
          ? this.capped(input.issuer, ISSUER_MAX_LENGTH)
          : doc.issuer,
      issueDate: input.issueDate !== undefined ? input.issueDate : doc.issueDate,
      expiryDate:
        authExpiry ??
        (input.expiryDate !== undefined ? input.expiryDate : doc.expiryDate),
      assetId: input.assetId !== undefined ? input.assetId : doc.assetId,
      documentId:
        input.documentId !== undefined ? input.documentId : doc.documentId,
      notes: input.notes !== undefined ? input.notes : doc.notes,
      fields: nextFields,
      extractedText:
        input.extractedText !== undefined
          ? input.extractedText
          : doc.extractedText,
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
    this.emitChange(shipId, 'updated', docId);
    return { ...saved, status: recordStatus(saved) };
  }

  /** Archetype field schema (BASE + per-archetype blocks) for UI forms. */
  archetypeSchema() {
    return {
      base: BASE_FIELDS,
      archetypes: ARCHETYPE_FIELDS,
      // Field-matrix slots, so the record form can be driven by a
      // document's field_profile rather than only by its archetype block.
      certificateFields: CERTIFICATE_FIELD_SPECS,
      nonRecordFields: [...NON_RECORD_FIELDS],
    };
  }

  // ── archetype field helpers (doc-control schema v9) ──

  /** Keep only fields defined for the archetype; drop unknowns/empties. */
  private sanitizeFields(
    _archetype: string | null,
    input?: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!input || typeof input !== 'object') return null;
    // Keep every non-empty captured value. We deliberately do NOT restrict to
    // the archetype's field keys: AI extraction often uses its own key names
    // (e.g. vessel_gt / vessel_imo instead of the compound vessel_gt/imo/...),
    // and dropping them here silently loses data the operator just reviewed.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (v !== null && v !== undefined && v !== '') out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  }

  /** Throw if a required archetype field is missing. */
  private validateRequired(
    archetype: string | null,
    _fields: Record<string, unknown> | null,
  ): void {
    // Soft check only — intentionally does NOT throw. Real-world documents
    // legitimately lack "required" fields (a Builder's Certificate / Registry
    // has no expiry), and the admin reviews every record in the upload window
    // before saving, so a missing field must not hard-block the save. The
    // required markers stay as UI guidance; verify_state / status reflect
    // completeness instead.
    void requiredFields(archetype);
  }

  /**
   * Cap a text field to what its column holds. Issuers on real certificates run
   * past the column width — "Versilia Marine Service s.a.s. di Adolfo Gori & C.,
   * Viareggio, Italy (liferaft station approved by Decreto N. 1058 …)" — and an
   * over-long value fails the insert, losing the whole record instead of the
   * tail of a name. Applies to typed input too: neither endpoint validates
   * length, so the same string entered by hand would 500 the same way.
   */
  private capped(v: string | null | undefined, max: number): string | null {
    const s = (v ?? '').trim();
    if (!s) return null;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
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

  /**
   * Withdraw a record. Where the catalogue says to retain history this
   * archives instead of deleting — a
   * hard delete took the stored file and the extracted text with it, and there
   * was no way back. `{ purge: true }` is the explicit escape hatch.
   */
  async deleteDoc(
    shipId: string,
    docId: string,
    opts?: { purge?: boolean },
  ): Promise<void> {
    const doc = await this.docRepository.findOne({
      where: { id: docId, shipId },
      relations: { docType: true },
    });
    if (!doc) throw new NotFoundException('Compliance doc not found');
    // Drop the PMS task this cert drove (the deadline is gone with it).
    await this.pmsService.removeForCompliance(doc.id);

    if (doc.docType?.retainHistory && !opts?.purge) {
      doc.recordState = 'archived';
      doc.archivedAt = new Date();
      await this.docRepository.save(doc);
      this.emitChange(shipId, 'updated', docId);
      return;
    }
    await this.docRepository.delete(doc.id);
    this.emitChange(shipId, 'deleted', docId);
  }

  /**
   * Put an archived or superseded record back in force. Used to undo an
   * archive, and to correct an automatic supersede that picked the wrong issue.
   */
  async restoreDoc(shipId: string, docId: string) {
    const doc = await this.docRepository.findOne({
      where: { id: docId, shipId },
      relations: { docType: true },
    });
    if (!doc) throw new NotFoundException('Compliance doc not found');
    doc.recordState = 'current';
    doc.supersededByDocId = null;
    doc.archivedAt = null;
    const saved = await this.docRepository.save(doc);
    await this.syncPmsForDoc(shipId, saved, doc.docType ?? null);
    this.emitChange(shipId, 'updated', docId);
    return { ...saved, status: recordStatus(saved) };
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
    const saved = await this.typeRepository.save(type);
    this.emitChange(shipId, 'updated', typeId);
    return saved;
  }

  /**
   * The compliance categories this user may read on this ship, or `null` for
   * "no RBAC restriction" — admins and accounts not linked to a crew member.
   * Mirrors AccessControlService.allowedCategories, so enforcement stays opt-in
   * per user via crew linkage and never locks an admin out.
   */
  private async readableCategories(
    user: AuthenticatedUser | null | undefined,
    shipId: string,
  ): Promise<Set<ResourceCategory> | null> {
    if (!user?.id) return null;
    return this.accessControlService.allowedCategories(user.id, shipId);
  }

  /** Throw unless the user may read documents of this type's category. */
  private async assertCanReadType(
    user: AuthenticatedUser | null | undefined,
    shipId: string,
    archetype: string | null | undefined,
  ): Promise<void> {
    const allowed = await this.readableCategories(user, shipId);
    if (!allowed) return;
    const category = categoryForArchetype(archetype);
    if (category === null || allowed.has(category)) return;
    throw new ForbiddenException(
      'Your position does not have access to this category of compliance document.',
    );
  }

  /**
   * Type-level verdict: 'missing' when there are no records; otherwise the
   * WORST record status (one expired liferaft cert makes the whole LSA line
   * expired — Shaun's many-units semantics). Every rulebook type is treated
   * as required — the vessel-profile "not required" gate was retired so the
   * full list always shows a real status.
   */
  /**
   * Type-level verdict over the CURRENT records, grouped by what each one
   * covers: worst across targets, best within a target.
   *
   * Both halves matter, and the production data shows why. 1.14.1 (crane
   * servicing) holds 7 records across 4 different assets — one expired unit
   * must still redden the line, which is the many-units semantics the register
   * has always had. 1.1.1 (Certificate of Registry) holds 4 records against the
   * vessel itself — a renewal plus its superseded copies, where the newest is
   * the truth and the old ones must not keep the line red forever.
   *
   * Grouping by link target separates the two without guessing: several
   * records on one target are versions of the same obligation, records on
   * different targets are coverage of different things.
   */

}
