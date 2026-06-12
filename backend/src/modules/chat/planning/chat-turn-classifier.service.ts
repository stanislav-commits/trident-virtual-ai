import { Injectable, Logger } from '@nestjs/common';
import { ChatLlmService } from '../chat-llm.service';
import { formatConversationContext } from '../context/chat-context-prompt.utils';
import { ChatConversationContext } from '../context/chat-conversation-context.types';
import { ChatCapabilityRegistryService } from './chat-capability-registry.service';
import { ChatMetricsAskTimeMode } from './chat-metrics-ask-time-mode.enum';
import { parseJsonObject } from './chat-turn-json.utils';
import { ChatTurnClassificationAsk } from './chat-turn-classifier.types';
import { ChatTurnIntent } from './chat-turn-intent.enum';

/**
 * Words/phrases that signal the question is about THIS vessel's own state or
 * data, not a public-knowledge question. When these are present and the LLM
 * classifier still picks `web_search` / `small_talk`, we override to a
 * metrics intent so the answer is grounded in onboard telemetry.
 */
const VESSEL_SIGNAL_PATTERN =
  /\b(onboard|on\s+board|on\s+this\s+vessel|on\s+the\s+vessel|on\s+the\s+yacht|on\s+the\s+ship|our\s+(?:vessel|ship|yacht|gensets?|engines?|tanks?)|the\s+(?:vessel|ship|yacht)(?:'s)?|ship'?s\s+(?:tank|fuel|water|engine|genset|capacity)|vessel'?s\s+(?:tank|fuel|water|engine|genset|capacity)|do\s+we\s+(?:use|have|consume|produce|run|need|bunker)|we\s+(?:use|consumed?|produced?|burned?|need|bunker|have|don'?t\s+have|lack|have\s+no|haven'?t)|us\s+(?:use|consume)|i\s+(?:bunker|refuel|top\s+up)|can\s+i\s+(?:bunker|fit|store|carry|fuel|refuel)|how\s+(?:much|many)\s+\w+\s+can\s+i|how\s+(?:much|many)\b[^?]*\b(?:bunker|fit|carry|store|capacity|tank|fuel)|(?:how\s+(?:did\s+you|do\s+you|was\s+(?:it|this))\s+(?:calculat|comput|deriv|infer|estimat|figur|measur|get|determin))|why\s+(?:did|do)\s+you\s+(?:say|think|conclude)|where\s+did\s+(?:the|that|this)\s+(?:number|value|figure|estimate)\s+come\s+from)\b|на\s+борту|у\s+нас\s+на\s+(?:судне|борту|яхте)|на\s+судне|наша\s+(?:яхта|судно)|сколько\s+(?:могу|можно)\s+(?:залить|забункеровать|вместить)|как\s+(?:ты|вы)\s+(?:посчитал|вычислил|определил)|откуда\s+(?:эта|такая|эти)\s+(?:цифра|значение|данные)/iu;

/**
 * If the user explicitly invoked an industry standard / regulation /
 * "typical" framing, they DO want the public answer — keep web_search.
 */
const PUBLIC_INTENT_PATTERN =
  /\b(per\s+iso|per\s+marpol|industry\s+standard|industry\s+average|typically|regulation|marpol|imo\b|class\s+society|public\s+sources?|standards?\b)\b|по\s+стандарту|по\s+iso|по\s+регламенту/iu;

/**
 * Words signalling the user wants the live / right-now state rather than a
 * trend or aggregate. Used to pick live_metrics over historical_metrics
 * when we override.
 */
const LIVE_NOW_PATTERN =
  /\b(right\s+now|currently|at\s+the\s+moment|at\s+this\s+moment|live)\b|сейчас|прямо\s+сейчас|в\s+данный\s+момент/iu;

/**
 * Is the active vessel's name mentioned in the question? Normalize spaces,
 * hyphens and underscores so "Sea Wolf X" / "Seawolf X" / "sea-wolf x" /
 * "seawolfx" all count as the same name. Tolerates "the X" prefix too
 * ("the seawolf x").
 */
function mentionsShipName(haystack: string, shipName: string | null): boolean {
  if (!shipName) return false;
  const compactName = shipName.toLowerCase().replace(/[\s_-]+/g, '');
  if (compactName.length < 3) return false;
  const compactHaystack = haystack.toLowerCase().replace(/[\s_-]+/g, '');
  return compactHaystack.includes(compactName);
}

@Injectable()
export class ChatTurnClassifierService {
  private readonly logger = new Logger(ChatTurnClassifierService.name);

  constructor(
    private readonly chatLlmService: ChatLlmService,
    private readonly chatCapabilityRegistryService: ChatCapabilityRegistryService,
  ) {}

  async classifyAsk(input: {
    context: ChatConversationContext;
    question: string;
  }): Promise<ChatTurnClassificationAsk> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(input.context, input.question);
    const rawResult = await this.chatLlmService.completeText({
      systemPrompt,
      userPrompt,
      temperature: 0,
      maxTokens: 220,
    });

    const parsed = this.parseClassification(rawResult) ?? {
      intent: ChatTurnIntent.SMALL_TALK,
      question: input.question.trim() || 'Continue the conversation.',
      timeMode: null,
      timestamp: null,
      rangeStart: null,
      rangeEnd: null,
    };

    this.logger.log(
      `Classifier picked intent=${parsed.intent} for "${input.question.slice(0, 120)}"`,
    );

    return this.overrideIntentForVesselSignals(
      parsed,
      input.question,
      input.context.session.ship?.name ?? null,
    );
  }

  /**
   * Safety net for cases where the LLM classifier picks `web_search` or
   * `small_talk` even though the question is clearly about THIS vessel's
   * state ("what is the average water consumption onboard?", "how much fuel
   * do we use?"). In those cases route to a metrics intent so the answer
   * comes from telemetry, not a generic ISO write-up.
   *
   * An explicit public-intent marker ("per ISO", "industry standard", etc.)
   * suppresses the override — if the user genuinely wants the public
   * reference, respect it.
   */
  private overrideIntentForVesselSignals(
    parsed: ChatTurnClassificationAsk,
    originalQuestion: string,
    activeShipName: string | null,
  ): ChatTurnClassificationAsk {
    if (
      parsed.intent !== ChatTurnIntent.WEB_SEARCH &&
      parsed.intent !== ChatTurnIntent.SMALL_TALK
    ) {
      return parsed;
    }

    const haystack = `${originalQuestion} ${parsed.question}`;
    const matchedGeneric = VESSEL_SIGNAL_PATTERN.test(haystack);
    const matchedShipName = mentionsShipName(haystack, activeShipName);

    if (!matchedGeneric && !matchedShipName) {
      return parsed;
    }
    if (PUBLIC_INTENT_PATTERN.test(haystack)) {
      return parsed;
    }

    const overridden = LIVE_NOW_PATTERN.test(haystack)
      ? ChatTurnIntent.LIVE_METRICS
      : ChatTurnIntent.HISTORICAL_METRICS;

    this.logger.log(
      `Overriding intent ${parsed.intent} → ${overridden} (` +
        `${matchedGeneric ? 'vessel-signal' : 'ship-name'} in "${originalQuestion.slice(0, 120)}")`,
    );

    return {
      ...parsed,
      intent: overridden,
    };
  }

  private buildSystemPrompt(): string {
    const capabilities = this.chatCapabilityRegistryService
      .getDefinitions()
      .map(
        (definition) =>
          `- ${definition.intent}: ${definition.label} (currently ${definition.enabled ? 'enabled' : 'disabled'})`,
      )
      .join('\n');

    return [
      'You classify one standalone ask for the Trident backend.',
      'The ask has already been decomposed and must not be split further.',
      'Use the full recent conversation for follow-up context.',
      'Do not answer the user. Only classify this one ask.',
      'Use small_talk only when the ask is general conversation and there is no specific source-backed ask to execute.',
      'For metrics asks, set timeMode to one of snapshot, point_in_time, or range.',
      'For point_in_time metrics asks, provide an ISO timestamp only if you can infer it reliably; otherwise leave timestamp null.',
      'For range metrics asks, provide ISO rangeStart and rangeEnd when you can infer them reliably; otherwise leave them null.',
      'For non-metrics asks, set timeMode to null and timestamp/rangeStart/rangeEnd to null.',
      'Allowed intents:',
      capabilities,
      'Intent guidance:',
      '- small_talk: normal conversation, brainstorming, writing help, or general assistant use without a Trident-specific source.',
      '- web_search: PURE public-information / regulatory / general-knowledge questions that have NOTHING to do with the state of THIS vessel. The question must NOT reference onboard quantities (fuel, water, energy, hours, distance, position, voyages), onboard equipment (by brand/model OR generic role like "the generators"), or use words like "onboard", "on this vessel", "on the yacht", "we", "us", "our". Allowed: "what is MARPOL?", "what is a bunker delivery note?", "what does ISO 15748-2 say?". NOT allowed (route to historical_metrics instead): "what is the average water consumption onboard?", "how much fuel do we use?", "what is our typical energy consumption?".',
      '- documentation: questions about product/platform docs, references, guides, or knowledge-base content.',
      '- manuals: ANY question that refers to a vessel manual, datasheet, or PMS — including questions that name a specific brand/model on this vessel and ask for an operating range, oil change interval, fault code meaning, service interval, alarm threshold, rated value, consumables, part numbers, troubleshooting, or "per the manual". Examples: "what is the oil change interval for the MASE VS350V per the manual?", "what does Volvo D13 manual say about coolant interval?", "rated power of Siemens LSM1100 PM motor". Always prefer manuals over web_search when a specific onboard brand/model is mentioned.',
      '- live_metrics: questions about current telemetry, current values, current vessel state, or live operational metrics. Includes "how much X is on board right NOW", "current fuel/water level", "what is the engine doing now", "are we underway".',
      '- historical_metrics: questions about trends, history, comparisons over time, aggregates, or metrics across a period. ALSO includes consumption / production / efficiency / average-usage questions about THIS vessel: "average water consumption onboard", "how much fuel do we use per day", "how much energy did the AC consume last week", "what is our fuel efficiency", "how many liters of grey water per day". Words like "onboard", "we", "us", "our", "this vessel" are STRONG signals for historical_metrics over web_search — even when the wording sounds generic ("what is the average...").',
      'Return only raw JSON with this exact shape:',
      '{"intent":"small_talk|web_search|documentation|manuals|live_metrics|historical_metrics","question":"standalone string","timeMode":"snapshot|point_in_time|range|null","timestamp":"ISO string or null","rangeStart":"ISO string or null","rangeEnd":"ISO string or null","reasoning":"short string"}',
      'Do not wrap JSON in markdown.',
    ].join('\n');
  }

  private buildUserPrompt(
    context: ChatConversationContext,
    question: string,
  ): string {
    return [
      'Classify this standalone ask from the latest user turn.',
      '',
      `Standalone ask: ${question}`,
      '',
      formatConversationContext(context),
    ].join('\n');
  }

  private parseClassification(
    rawResult: string | null,
  ): ChatTurnClassificationAsk | null {
    const parsed = parseJsonObject(rawResult);

    if (!parsed) {
      return null;
    }

    const entry = parsed as Record<string, unknown>;
    const intent =
      typeof entry.intent === 'string' && this.isSupportedIntent(entry.intent)
        ? entry.intent
        : null;
    const question =
      typeof entry.question === 'string' && entry.question.trim().length > 0
        ? entry.question.trim()
        : null;

    if (!intent || !question) {
      return null;
    }

    const parsedTimeMode =
      typeof entry.timeMode === 'string'
        ? this.parseTimeMode(entry.timeMode)
        : null;
    const timestamp =
      typeof entry.timestamp === 'string' && entry.timestamp.trim().length > 0
        ? entry.timestamp.trim()
        : null;
    const rangeStart =
      typeof entry.rangeStart === 'string' && entry.rangeStart.trim().length > 0
        ? entry.rangeStart.trim()
        : null;
    const rangeEnd =
      typeof entry.rangeEnd === 'string' && entry.rangeEnd.trim().length > 0
        ? entry.rangeEnd.trim()
        : null;

    return {
      intent,
      question,
      timeMode: parsedTimeMode,
      timestamp,
      rangeStart,
      rangeEnd,
    };
  }

  private parseTimeMode(value: string): ChatMetricsAskTimeMode | null {
    if (Object.values(ChatMetricsAskTimeMode).includes(value as ChatMetricsAskTimeMode)) {
      return value as ChatMetricsAskTimeMode;
    }

    return null;
  }

  private isSupportedIntent(value: string): value is ChatTurnIntent {
    return Object.values(ChatTurnIntent).includes(value as ChatTurnIntent);
  }
}
