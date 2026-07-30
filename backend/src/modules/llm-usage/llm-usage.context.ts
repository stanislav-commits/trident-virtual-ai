import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who a model call is for, carried out-of-band.
 *
 * `LlmService` is the one place every model call passes through, and it sees a
 * prompt and a model — no vessel, no user, no reason. Threading those through
 * the twenty-odd call sites would mean touching every responder and still
 * missing the background jobs, so the attribution rides alongside the call
 * instead, set once at the boundary where it IS known: the HTTP request, or the
 * top of a scheduled job.
 *
 * A missing context is not an error. It records as 'unattributed', which is
 * visible on the report and keeps the total reconcilable with the provider's
 * invoice — the alternative, dropping the row, silently understates the bill.
 */
export type LlmUsagePurpose =
  | 'chat_answer'
  | 'chat_classify'
  | 'chat_decompose'
  | 'chat_title'
  | 'chat_summary'
  | 'chat_vision'
  | 'chat_transcribe'
  | 'chat_write_confirm'
  | 'doc_ingest'
  | 'doc_extract'
  | 'metric_describe'
  | 'metric_analyze'
  | 'alert_analysis'
  | 'daily_brief'
  | 'compliance_extract'
  | 'grafana_assist'
  | 'unattributed';

export interface LlmUsageContext {
  shipId: string | null;
  userId: string | null;
  purpose: LlmUsagePurpose;
}

const storage = new AsyncLocalStorage<LlmUsageContext>();

/** Runs `fn` with attribution attached to every model call it makes. */
export function withLlmUsageContext<T>(
  context: Partial<LlmUsageContext>,
  fn: () => T,
): T {
  const parent = storage.getStore();
  return storage.run(
    {
      shipId: context.shipId ?? parent?.shipId ?? null,
      userId: context.userId ?? parent?.userId ?? null,
      purpose: context.purpose ?? parent?.purpose ?? 'unattributed',
    },
    fn,
  );
}

export function currentLlmUsageContext(): LlmUsageContext {
  return (
    storage.getStore() ?? { shipId: null, userId: null, purpose: 'unattributed' }
  );
}
