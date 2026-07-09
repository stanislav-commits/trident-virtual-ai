import { Injectable, Logger } from '@nestjs/common';
import { MetricAnalyzerResponderService } from '../../metrics/metric-understanding/metric-analyzer-responder.service';
import { ChatContextQueryResolverService } from '../context/chat-context-query-resolver.service';
import { ChatProgressBus } from '../progress/chat-progress.bus';
import {
  ChatTurnResponderInput,
  ChatTurnResponderOutput,
} from './interfaces/chat-turn-responder.types';

@Injectable()
export class ChatMetricAnalyzerResponderService {
  private readonly logger = new Logger(ChatMetricAnalyzerResponderService.name);

  constructor(
    private readonly metricAnalyzerResponderService: MetricAnalyzerResponderService,
    private readonly chatContextQueryResolverService: ChatContextQueryResolverService,
    private readonly chatProgressBus: ChatProgressBus,
  ) {}

  async respond(input: ChatTurnResponderInput): Promise<ChatTurnResponderOutput> {
    if (!input.session.shipId) {
      return {
        askId: input.ask.id,
        intent: input.ask.intent,
        responder: input.ask.responder,
        question: input.ask.question,
        capabilityEnabled: input.ask.capabilityEnabled,
        capabilityLabel: input.ask.capabilityLabel,
        summary:
          'I need an active ship context in this chat before I can look up vessel metrics.',
        data: { status: 'missing_ship_context' },
        contextReferences: [],
      };
    }

    // Expand follow-up references ("list these voyages", "add locations to
    // this list", etc.) into a self-contained query that the stateless
    // metric analyzer can act on. Only do it for single-ask turns —
    // multi-ask plans already provide a focused per-ask question.
    let questionToAnalyze = input.ask.question;
    if (input.plan.asks.length === 1) {
      try {
        const resolved =
          await this.chatContextQueryResolverService.resolveStandaloneQuestion(
            input.context,
            input.plan.responseLanguage,
          );
        if (resolved && resolved.trim().length > 0) {
          questionToAnalyze = resolved;
        }
      } catch (err) {
        this.logger.warn(
          `Context resolution failed, falling back to raw ask: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    try {
      const result = await this.metricAnalyzerResponderService.answer(
        input.session.shipId,
        questionToAnalyze,
        {
          onProgress: (text) =>
            this.chatProgressBus.emit(input.session.id, {
              type: 'tool',
              text,
            }),
          onTextDelta: this.createBatchedDeltaForwarder(input.session.id),
        },
      );

      return {
        askId: input.ask.id,
        intent: input.ask.intent,
        responder: input.ask.responder,
        question: input.ask.question,
        capabilityEnabled: input.ask.capabilityEnabled,
        capabilityLabel: input.ask.capabilityLabel,
        summary: result.answer,
        data: {
          status: 'ok',
          toolCalls: result.toolCalls,
          otherToolCalls: result.otherToolCalls,
          totalTokens: result.totalTokens,
          estimatedCostUsd: result.estimatedCostUsd,
          durationMs: result.durationMs,
          iterations: result.iterations,
          hitTurnLimit: result.hitTurnLimit,
        },
        contextReferences: this.buildContextReferences(result.toolCalls),
      };
    } catch (error) {
      this.logger.error(
        `Metric analyzer responder failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        askId: input.ask.id,
        intent: input.ask.intent,
        responder: input.ask.responder,
        question: input.ask.question,
        capabilityEnabled: input.ask.capabilityEnabled,
        capabilityLabel: input.ask.capabilityLabel,
        summary: `I could not resolve this metrics request: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
        data: {
          status: 'execution_failed',
          error: error instanceof Error ? error.message : String(error),
        },
        contextReferences: [],
      };
    }
  }

  /**
   * Batch token deltas into ~150 ms windows so the SSE channel carries
   * dozens of `delta` events per answer instead of thousands. A `null`
   * delta means "discard the streamed draft" (e.g. the model went into a
   * tool-call round) — flush state is cleared and a `delta_reset` is sent
   * so the frontend drops the partial text.
   */
  private createBatchedDeltaForwarder(
    sessionId: string,
  ): (delta: string | null) => void {
    let pending = '';
    let timer: NodeJS.Timeout | null = null;

    const flush = () => {
      timer = null;
      if (!pending) return;
      const chunk = pending;
      pending = '';
      this.chatProgressBus.emit(sessionId, { type: 'delta', text: chunk });
    };

    return (delta: string | null) => {
      if (delta === null) {
        if (timer) clearTimeout(timer);
        pending = '';
        timer = null;
        this.chatProgressBus.emit(sessionId, { type: 'delta_reset', text: '' });
        return;
      }
      pending += delta;
      if (!timer) timer = setTimeout(flush, 150);
    };
  }

  private buildContextReferences(
    toolCalls: Array<{
      measurement: string;
      resolvedField: string;
      aggregation: string;
      rangeStart: string;
      rangeStop?: string;
      value: number | null;
      ok: boolean;
    }>,
  ): Record<string, unknown>[] {
    return toolCalls
      .filter((tc) => tc.ok && tc.value !== null)
      .map((tc, idx) => ({
        id: `metric-${idx}`,
        // Tag as a metric so the UI keeps it out of the Sources panel
        // (only manuals / documents / web results are shown there).
        sourceType: 'metric',
        sourceTitle: `${tc.measurement} :: ${tc.resolvedField}`,
        snippet: `${tc.aggregation}(${tc.rangeStart}${
          tc.rangeStop ? ` → ${tc.rangeStop}` : ''
        }) = ${tc.value}`,
      }));
  }
}
