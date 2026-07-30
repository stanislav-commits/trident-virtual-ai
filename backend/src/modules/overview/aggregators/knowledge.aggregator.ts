import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { formatError } from '../../../common/utils/error.utils';
import { OverviewCard } from '../overview.types';

/** Row shape of the single aggregate below; every count is cast to int4 because pg returns COUNT as a bigint string. */
interface KnowledgeCounts {
  /** False when the vessel has no RAGFlow dataset at all — then nothing can be reachable from chat. */
  ship_has_dataset: boolean;
  total: number;
  usable_in_chat: number;
  /** Parsed rows that chat still cannot see — feeds the caveat note, not a stat. */
  parsed_not_reachable: number;
  failed: number;
  in_flight: number;
  /** Non-plan rows the dispatcher has not picked up yet — feeds the caveat note. */
  awaiting_dispatch: number;
  extraction_errors: number;
  drawings: number;
  broken_upload: number;
}

/**
 * The ship's CURRENT dataset comes from a one-row derived table rather than a
 * join onto `documents`, so the dataset is still known when the vessel has no
 * documents at all (LEFT JOIN keeps the single aggregate row; COUNT(d.id)
 * therefore reports 0 instead of 1).
 *
 * `usable_in_chat` compares against that current dataset on purpose: a document
 * parsed into a dataset the vessel has since been repointed away from reads as
 * 'parsed' everywhere else in the admin panel while being invisible to chat.
 * The equality also yields NULL — so counts nothing — when the vessel has no
 * dataset, which is the correct answer for that case.
 */
const KNOWLEDGE_COUNTS_SQL = `
  SELECT
    (s.dataset_id IS NOT NULL) AS ship_has_dataset,
    COUNT(d.id)::int AS total,
    COUNT(d.id) FILTER (
      WHERE d.parse_status = 'parsed'
        AND d.ragflow_document_id IS NOT NULL
        AND d.ragflow_dataset_id = s.dataset_id
    )::int AS usable_in_chat,
    COUNT(d.id) FILTER (
      WHERE d.parse_status = 'parsed'
        AND (
          d.ragflow_document_id IS NULL
          OR d.ragflow_dataset_id IS DISTINCT FROM s.dataset_id
        )
    )::int AS parsed_not_reachable,
    COUNT(d.id) FILTER (WHERE d.parse_status = 'failed')::int AS failed,
    COUNT(d.id) FILTER (
      WHERE d.parse_status IN ('pending_config', 'pending_parse', 'parsing')
    )::int AS in_flight,
    -- Plans are excluded because the ingestion dispatcher excludes them: a plan
    -- resting at 'uploaded' is its final state, not a queue entry.
    COUNT(d.id) FILTER (
      WHERE d.doc_class <> 'plan'
        AND d.parse_status IN ('uploaded', 'reparse_required')
    )::int AS awaiting_dispatch,
    COUNT(d.id) FILTER (WHERE d.extraction_error IS NOT NULL)::int AS extraction_errors,
    COUNT(d.id) FILTER (WHERE d.doc_class = 'plan')::int AS drawings,
    -- documents.file_size_bytes is NOT NULL in the schema, so the null leg can
    -- never fire today; it stays because a zero-byte or key-less row is the only
    -- evidence a drawing's file never arrived, and that check must not silently
    -- narrow if the column is ever relaxed.
    COUNT(d.id) FILTER (
      WHERE d.storage_key IS NULL
        OR d.file_size_bytes IS NULL
        OR d.file_size_bytes = 0
    )::int AS broken_upload
  FROM (SELECT ragflow_dataset_id AS dataset_id FROM ships WHERE id = $1) s
  LEFT JOIN documents d ON d.ship_id = $1
  GROUP BY s.dataset_id
`;

@Injectable()
export class KnowledgeAggregator {
  private readonly logger = new Logger(KnowledgeAggregator.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async collect(shipId: string): Promise<OverviewCard> {
    let row: KnowledgeCounts;
    try {
      const rows: KnowledgeCounts[] = await this.dataSource.query(
        KNOWLEDGE_COUNTS_SQL,
        [shipId],
      );
      if (!rows.length) throw new Error('no ships row for this id');
      row = rows[0];
    } catch (error) {
      this.logger.error(
        `knowledge overview aggregate failed for ship ${shipId}: ${formatError(error)}`,
      );
      return {
        ...KnowledgeAggregator.shell(),
        notes: ['Knowledge base counts could not be read from the database.'],
        degraded: {
          reason: 'The knowledge base aggregate could not be read.',
          affects: [
            'documents',
            'usable in chat',
            'failed to parse',
            'in flight',
            'extraction errors',
            'drawings',
            'broken upload',
          ],
        },
      };
    }

    if (row.total === 0) {
      return {
        ...KnowledgeAggregator.shell(),
        notes: ['No documents have been uploaded for this vessel yet.'],
      };
    }

    const notes = [
      'Drawings are never parsed, so a missing storage key or an empty file is the only upload failure the platform can detect for them — page_count is not populated for any document and cannot be used as a health signal.',
      "A non-empty parse_error does not mean the document failed: the automatic-fallback path writes a retry note into it while parsing continues, so only parse_status 'failed' is counted as failed.",
      'Counts documents held against this vessel; fleet-wide publications belong to the platform record and are not included.',
    ];

    if (!row.ship_has_dataset) {
      notes.push(
        'This vessel has no RAGFlow dataset configured, so no document is reachable from chat whatever its parse status says.',
      );
    } else if (row.parsed_not_reachable > 0) {
      notes.push(
        `${row.parsed_not_reachable} document${row.parsed_not_reachable === 1 ? '' : 's'} ${row.parsed_not_reachable === 1 ? 'is' : 'are'} marked parsed but ${row.parsed_not_reachable === 1 ? 'sits' : 'sit'} in a dataset this vessel no longer uses, or lost the RAGFlow id — chat cannot see ${row.parsed_not_reachable === 1 ? 'it' : 'them'} and re-parsing is the fix.`,
      );
    }

    if (row.awaiting_dispatch > 0) {
      notes.push(
        `${row.awaiting_dispatch} non-drawing document${row.awaiting_dispatch === 1 ? '' : 's'} ${row.awaiting_dispatch === 1 ? 'is' : 'are'} still waiting for the ingestion dispatcher or flagged for re-parse, which the in-flight count does not include.`,
      );
    }

    return {
      ...KnowledgeAggregator.shell(),
      headline: row.total,
      stats: [
        {
          label: 'usable in chat',
          value: row.usable_in_chat,
          tone:
            row.usable_in_chat === 0 || row.parsed_not_reachable > 0
              ? 'warn'
              : 'good',
          hint: 'Parsed AND present in the RAGFlow dataset this vessel points at today. Excludes drawings, which are never parsed, and anything parsed into a dataset the vessel has since moved off.',
        },
        {
          label: 'failed to parse',
          value: row.failed,
          tone: row.failed > 0 ? 'bad' : 'good',
          hint: 'Documents the parser gave up on. Ones carrying an automatic-retry note are still in progress and are not counted here.',
        },
        {
          label: 'in flight',
          value: row.in_flight,
          tone: 'neutral',
          hint: "Queued for or currently being parsed. Does not include documents still at 'uploaded' awaiting dispatch, nor ones flagged for re-parse.",
        },
        {
          label: 'extraction errors',
          value: row.extraction_errors,
          tone: row.extraction_errors > 0 ? 'warn' : 'good',
          hint: 'Vision extraction failed. The original file is still ingested as a fallback, so such a document can be usable in chat regardless.',
        },
        {
          label: 'drawings',
          value: row.drawings,
          tone: 'neutral',
          hint: 'Documents of class plan — a file store, opened on demand. They are deliberately never parsed, so they are neither a parse backlog nor ever usable in chat.',
        },
        {
          label: 'broken upload',
          value: row.broken_upload,
          tone: row.broken_upload > 0 ? 'bad' : 'good',
          hint: 'No storage key, or a zero-byte file — the file itself never arrived. Counted across every class, drawings included.',
        },
      ],
      notes,
    };
  }

  private static shell(): OverviewCard {
    return {
      key: 'knowledge',
      title: 'Knowledge base',
      headline: null,
      headlineLabel: 'documents',
      stats: [],
      notes: [],
      section: 'documents',
    };
  }
}
