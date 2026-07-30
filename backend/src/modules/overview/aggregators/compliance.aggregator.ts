import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OverviewCard } from '../overview.types';

/**
 * Compliance tile — deliberately a placeholder.
 *
 * The compliance-document model is about to be reworked, so expiry / missing /
 * per-archetype numbers derived from today's semantics would be discarded with
 * it — and until then would sit on the Overview page looking authoritative.
 * So this card carries only the two counts that survive any reshuffle of the
 * model: records held, and rulebook types configured for the vessel.
 *
 * When the new model lands, this is where the status roll-up goes: extend the
 * single statement below with the agreed valid / expiring / expired / missing
 * buckets (per archetype, REPORT excluded from "expired" — it is structurally
 * always past its date), add them as stats, and drop the "not shown yet" note.
 * The card shape does not need to change.
 */
@Injectable()
export class ComplianceAggregator {
  private readonly logger = new Logger(ComplianceAggregator.name);

  /** `::int` so pg hands back numbers instead of bigint strings. */
  private static readonly COUNTS_SQL = `
    SELECT
      (SELECT COUNT(*)::int FROM compliance_docs
        WHERE ship_id = $1) AS documents_held,
      (SELECT COUNT(*)::int FROM compliance_doc_types
        WHERE ship_id = $1) AS doc_types_configured
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

    let documentsHeld: number;
    let docTypesConfigured: number;
    try {
      const rows = await this.dataSource.query<
        Array<{ documents_held: number; doc_types_configured: number }>
      >(ComplianceAggregator.COUNTS_SQL, [shipId]);
      documentsHeld = Number(rows[0]?.documents_held ?? 0);
      docTypesConfigured = Number(rows[0]?.doc_types_configured ?? 0);
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
          affects: ['documents held', 'document types configured'],
        },
      };
    }

    const hasAnyData = documentsHeld > 0 || docTypesConfigured > 0;

    card.headline = hasAnyData ? documentsHeld : null;
    card.stats = [
      {
        label: 'document types configured',
        value: docTypesConfigured,
        tone: docTypesConfigured > 0 ? 'neutral' : 'warn',
        hint: "Every type in this vessel's rulebook copy, applicable or not — not a count of documents required.",
      },
    ];
    card.notes = [
      'The compliance document model is being reworked, so status, expiry and coverage numbers are intentionally not shown yet.',
      'Documents held counts every record on file, renewals and superseded issues included — it is not a count of valid certificates.',
    ];
    if (!hasAnyData) {
      card.notes.push(
        'No compliance rulebook has been instantiated for this vessel yet, so there is nothing to count.',
      );
    }

    return card;
  }
}
