import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { hideFromRegister } from '../../compliance/compliance-profile.util';
import {
  EXPIRING_DAYS,
  typeStatus,
  type ComplianceStatus,
  type StatusLink,
  type StatusRecord,
} from '../../compliance/compliance-status.util';
import { OverviewCard } from '../overview.types';

/**
 * Compliance tile — the register's health in four numbers.
 *
 * Counted over rulebook TYPES, not records, because that is the question the
 * card answers: how many lines of this vessel's certificate register are in
 * order. A type with four liferaft certificates is one line, and it reads as
 * expired the moment any one raft is.
 *
 * The status rules come from compliance-status.util, the same code the register
 * page uses. Re-deriving them in SQL here would be faster to write and would
 * start disagreeing with the register on the first rule change — two screens
 * showing the client different compliance numbers is worse than a slower query.
 *
 * Unlike the register, this counts every category: Overview is admin-only, and
 * an admin reads the whole rulebook. If the page is ever opened to crew
 * positions, the category filter (readableCategories) has to come with it, or
 * the totals will describe documents the reader may not see.
 */
@Injectable()
export class ComplianceAggregator {
  private readonly logger = new Logger(ComplianceAggregator.name);

  /** Rulebook rows for this vessel — applicability decides what an empty one means. */
  private static readonly TYPES_SQL = `
    SELECT id, applicability
      FROM compliance_doc_types
     WHERE ship_id = $1
  `;

  /** Every record on file. record_state filters to the live ones in typeStatus. */
  private static readonly DOCS_SQL = `
    SELECT id, doc_type_id, expiry_date, record_state, asset_id
      FROM compliance_docs
     WHERE ship_id = $1
  `;

  /** What each record covers, for the per-target grouping. */
  private static readonly LINKS_SQL = `
    SELECT l.doc_id, l.asset_id, l.crew_member_id
      FROM doc_asset_links l
      JOIN compliance_docs d ON d.id = l.doc_id
     WHERE d.ship_id = $1
  `;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async collect(shipId: string): Promise<OverviewCard> {
    const card: OverviewCard = {
      key: 'compliance',
      title: 'Compliance documents',
      headline: null,
      headlineLabel: 'documents held',
      stats: [],
      notes: [],
      section: 'compliance',
    };

    let types: Array<{ id: string; applicability: string | null }>;
    let docs: Array<{
      id: string;
      doc_type_id: string;
      expiry_date: string | null;
      record_state: string | null;
      asset_id: string | null;
    }>;
    let links: Array<{
      doc_id: string;
      asset_id: string | null;
      crew_member_id: string | null;
    }>;
    try {
      [types, docs, links] = await Promise.all([
        this.dataSource.query(ComplianceAggregator.TYPES_SQL, [shipId]),
        this.dataSource.query(ComplianceAggregator.DOCS_SQL, [shipId]),
        this.dataSource.query(ComplianceAggregator.LINKS_SQL, [shipId]),
      ]);
    } catch (error) {
      this.logger.error(
        `Compliance overview counts failed for ship ${shipId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        ...card,
        notes: ['Compliance counts could not be read from the database.'],
        degraded: {
          reason: 'Compliance count query failed.',
          affects: ['documents held', 'valid', 'expiring', 'expired', 'missing'],
        },
      };
    }

    const docsByType = new Map<string, StatusRecord[]>();
    for (const d of docs) {
      const list = docsByType.get(d.doc_type_id) ?? [];
      list.push({
        id: d.id,
        expiryDate: d.expiry_date,
        recordState: d.record_state,
        assetId: d.asset_id,
      });
      docsByType.set(d.doc_type_id, list);
    }

    const linksByDoc = new Map<string, StatusLink[]>();
    for (const l of links) {
      const list = linksByDoc.get(l.doc_id) ?? [];
      list.push({ assetId: l.asset_id, crewMemberId: l.crew_member_id });
      linksByDoc.set(l.doc_id, list);
    }

    const counts: Record<ComplianceStatus, number> = {
      valid: 0,
      expiring: 0,
      expired: 0,
      missing: 0,
      conditional: 0,
    };
    for (const type of types) {
      const records = docsByType.get(type.id) ?? [];
      // A row the vessel does not need and has no records for is not part of
      // the register at all — counting it as a gap would invent work.
      if (hideFromRegister(type.applicability, records.length)) continue;
      counts[typeStatus(records, type.applicability, linksByDoc)] += 1;
    }

    const inRegister =
      counts.valid +
      counts.expiring +
      counts.expired +
      counts.missing +
      counts.conditional;
    const hasAnyData = docs.length > 0 || types.length > 0;

    card.headline = hasAnyData ? docs.length : null;
    card.stats = [
      {
        label: 'valid',
        value: counts.valid,
        tone: counts.valid > 0 ? 'good' : 'neutral',
        hint: 'Register lines whose current documents are all in date.',
      },
      {
        label: 'expiring soon',
        value: counts.expiring,
        tone: counts.expiring > 0 ? 'warn' : 'neutral',
        hint: `In date, but expiring within ${EXPIRING_DAYS} days.`,
      },
      {
        label: 'expired',
        value: counts.expired,
        tone: counts.expired > 0 ? 'bad' : 'neutral',
        hint: 'At least one document on the line is past its expiry date.',
      },
      {
        label: 'missing',
        value: counts.missing,
        tone: counts.missing > 0 ? 'bad' : 'neutral',
        hint: 'Required by the applicability matrix, with no current record on file.',
      },
    ];

    card.notes = [
      `Counted over the ${inRegister} lines of this vessel's certificate register, not over documents: a line covering several units reads as its worst unit.`,
      'Documents held counts every record on file, renewals and superseded issues included — it is not a count of valid certificates.',
    ];
    if (counts.conditional > 0) {
      card.notes.push(
        `${counts.conditional} more ${counts.conditional === 1 ? 'line is' : 'lines are'} unclassified: the applicability matrix has not established whether this vessel needs them, so an empty row is not counted as a gap.`,
      );
    }
    if (!hasAnyData) {
      card.notes.push(
        'No compliance rulebook has been instantiated for this vessel yet, so there is nothing to count.',
      );
    }

    return card;
  }
}
