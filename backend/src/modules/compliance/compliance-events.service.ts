import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PmsTaskEntity } from '../pms/entities/pms-task.entity';
import { ComplianceDocEntity } from './entities/compliance-doc.entity';
import { ComplianceDocTypeEntity } from './entities/compliance-doc-type.entity';
import { ComplianceEventEntity } from './entities/compliance-event.entity';
import { ComplianceTypeRelationEntity } from './entities/compliance-type-relation.entity';
import { DocAssetLinkEntity } from './entities/doc-asset-link.entity';
import {
  COMPLIANCE_EVENT_CODES,
  PARENT_REPLACED_CODE,
  eventSpec,
} from './compliance-events.const';

export interface RecordEventInput {
  code: string;
  note?: string | null;
  /** Narrow an equipment event to records linked to this asset. */
  assetId?: string | null;
  source?: string;
  createdBy?: string | null;
}

/**
 * v60 Phase 4 — applies vessel/operational events to the register.
 *
 * An event's outcome reaches a record through two routes:
 *   1. trigger codes — the type lists the event's code, so its current
 *      records are affected directly (TO-REVIEW flag, or TO-INVALID for
 *      equipment events after which the paper cannot be relied on);
 *   2. dependency edges — when a parent certificate's current record is
 *      replaced, every child type's current records get a TO-REVIEW flag
 *      (ComplianceService calls onParentReplaced from supersedePrevious).
 *
 * Flags surface in the register and, via the daily alerts reconcile, in the
 * bell. An operator clears the flag once the record has been assessed.
 */
@Injectable()
export class ComplianceEventsService {
  private readonly logger = new Logger(ComplianceEventsService.name);

  constructor(
    @InjectRepository(ComplianceEventEntity)
    private readonly eventRepository: Repository<ComplianceEventEntity>,
    @InjectRepository(ComplianceTypeRelationEntity)
    private readonly relationRepository: Repository<ComplianceTypeRelationEntity>,
    @InjectRepository(ComplianceDocTypeEntity)
    private readonly typeRepository: Repository<ComplianceDocTypeEntity>,
    @InjectRepository(ComplianceDocEntity)
    private readonly docRepository: Repository<ComplianceDocEntity>,
    @InjectRepository(DocAssetLinkEntity)
    private readonly linkRepository: Repository<DocAssetLinkEntity>,
    @InjectRepository(PmsTaskEntity)
    private readonly pmsTaskRepository: Repository<PmsTaskEntity>,
  ) {}

  listCodes() {
    return COMPLIANCE_EVENT_CODES;
  }

  async listEvents(shipId: string, limit = 50): Promise<ComplianceEventEntity[]> {
    return this.eventRepository.find({
      where: { shipId },
      order: { occurredAt: 'DESC' },
      take: Math.min(200, Math.max(1, limit)),
    });
  }

  /** Record an event and apply its outcome to the register. */
  async record(
    shipId: string,
    input: RecordEventInput,
  ): Promise<{ event: ComplianceEventEntity; affected: number }> {
    const spec = eventSpec(input.code);
    if (!spec) {
      throw new BadRequestException(`Unknown compliance event code: ${input.code}`);
    }

    const event = await this.eventRepository.save(
      this.eventRepository.create({
        shipId,
        code: spec.code,
        source: input.source ?? 'manual',
        note: input.note ?? null,
        payload: input.assetId ? { assetId: input.assetId } : null,
        createdBy: input.createdBy ?? null,
      }),
    );

    const types = await this.typeRepository
      .createQueryBuilder('t')
      .where('t.ship_id = :shipId', { shipId })
      .andWhere(':code = ANY(t.trigger_codes)', { code: spec.code })
      .getMany();

    let affected = 0;
    if (types.length) {
      let docs = await this.docRepository.find({
        where: {
          shipId,
          docTypeId: In(types.map((t) => t.id)),
          recordState: 'current',
        },
      });
      // An equipment event about ONE unit must not condemn the whole class:
      // when an asset is named, only records linked to it are touched.
      if (input.assetId) {
        const links = docs.length
          ? await this.linkRepository.find({
              where: {
                docId: In(docs.map((d) => d.id)),
                assetId: input.assetId,
              },
            })
          : [];
        const linkedDocIds = new Set(links.map((l) => l.docId));
        docs = docs.filter(
          (d) => linkedDocIds.has(d.id) || d.assetId === input.assetId,
        );
      }

      const typeById = new Map(types.map((t) => [t.id, t]));
      for (const doc of docs) {
        const typeName = typeById.get(doc.docTypeId)?.name ?? 'document';
        if (spec.outcome === 'invalid') {
          await this.invalidate(shipId, doc, event, spec.label);
        } else {
          await this.flagReview(
            doc,
            event.id,
            spec.code,
            `${spec.label} — review ${typeName}`,
          );
        }
        affected += 1;
      }
    }

    event.affectedCount = affected;
    await this.eventRepository.save(event);
    this.logger.log(
      `Compliance event ${spec.code} on ship ${shipId}: ${affected} record(s) affected`,
    );
    return { event, affected };
  }

  /**
   * DEP-CHILD propagation: the parent type's record in force was replaced —
   * children referencing it must be looked at. Called by ComplianceService
   * from supersedePrevious; quiet no-op when the type has no children.
   */
  async onParentReplaced(
    shipId: string,
    parentType: ComplianceDocTypeEntity,
  ): Promise<number> {
    const edges = await this.relationRepository.find({
      where: { shipId, parentTypeId: parentType.id },
    });
    if (!edges.length) return 0;

    const event = await this.eventRepository.save(
      this.eventRepository.create({
        shipId,
        code: PARENT_REPLACED_CODE,
        source: 'document',
        note: `${parentType.name} was replaced by a new issue`,
      }),
    );

    const docs = await this.docRepository.find({
      where: {
        shipId,
        docTypeId: In(edges.map((e) => e.childTypeId)),
        recordState: 'current',
      },
    });
    for (const doc of docs) {
      await this.flagReview(
        doc,
        event.id,
        PARENT_REPLACED_CODE,
        `${parentType.name} was replaced — check this record still matches it`,
      );
    }
    event.affectedCount = docs.length;
    await this.eventRepository.save(event);
    return docs.length;
  }

  /** Operator assessed the record — the flag has served its purpose. */
  async clearReviewFlag(shipId: string, docId: string): Promise<void> {
    await this.docRepository.update({ id: docId, shipId }, { reviewFlag: null });
  }

  private async flagReview(
    doc: ComplianceDocEntity,
    eventId: string,
    code: string,
    reason: string,
  ): Promise<void> {
    doc.reviewFlag = {
      code,
      eventId,
      reason,
      flaggedAt: new Date().toISOString(),
    };
    await this.docRepository.save(doc);
  }

  private async invalidate(
    shipId: string,
    doc: ComplianceDocEntity,
    event: ComplianceEventEntity,
    label: string,
  ): Promise<void> {
    doc.recordState = 'invalid';
    doc.reviewFlag = {
      code: event.code,
      eventId: event.id,
      reason: `${label} — the record no longer satisfies compliance; arrange a retest or replacement`,
      flaggedAt: new Date().toISOString(),
    };
    await this.docRepository.save(doc);
    // The record no longer drives maintenance — an invalid test report must
    // not keep a renewal task alive on a unit that was replaced. Same delete
    // as PmsService.removeForCompliance; the repo is injected directly so
    // this module stays leaf-shaped (see ComplianceEventsModule).
    await this.pmsTaskRepository.delete({ sourceDocId: doc.id });
  }
}
