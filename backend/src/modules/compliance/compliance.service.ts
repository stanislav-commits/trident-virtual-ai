import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
  ) {}

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

  async createDoc(shipId: string, input: UpsertComplianceDocInput) {
    const type = await this.typeRepository.findOne({
      where: { id: input.docTypeId, shipId },
    });
    if (!type) {
      throw new NotFoundException('Compliance doc type not found on this ship');
    }
    const saved = await this.docRepository.save(
      this.docRepository.create({
        shipId,
        docTypeId: input.docTypeId,
        certNo: input.certNo ?? null,
        issuer: input.issuer ?? null,
        issueDate: input.issueDate ?? null,
        expiryDate: input.expiryDate ?? null,
        assetId: input.assetId ?? null,
        documentId: input.documentId ?? null,
        notes: input.notes ?? null,
      }),
    );
    return { ...saved, status: this.recordStatus(saved) };
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
    Object.assign(doc, {
      certNo: input.certNo !== undefined ? input.certNo : doc.certNo,
      issuer: input.issuer !== undefined ? input.issuer : doc.issuer,
      issueDate: input.issueDate !== undefined ? input.issueDate : doc.issueDate,
      expiryDate:
        input.expiryDate !== undefined ? input.expiryDate : doc.expiryDate,
      assetId: input.assetId !== undefined ? input.assetId : doc.assetId,
      documentId:
        input.documentId !== undefined ? input.documentId : doc.documentId,
      notes: input.notes !== undefined ? input.notes : doc.notes,
    });
    const saved = await this.docRepository.save(doc);
    return { ...saved, status: this.recordStatus(saved) };
  }

  async deleteDoc(shipId: string, docId: string): Promise<void> {
    const doc = await this.docRepository.findOne({
      where: { id: docId, shipId },
    });
    if (!doc) throw new NotFoundException('Compliance doc not found');
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
