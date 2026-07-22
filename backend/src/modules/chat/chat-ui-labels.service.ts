import { Injectable, Logger } from '@nestjs/common';
import { formatError } from '../../common/utils/error.utils';
import { ChatLlmService } from './chat-llm.service';

/**
 * Chart click-to-ask UI strings (button labels + the composed follow-up
 * question) in one language. Templates carry `{placeholder}` tokens the
 * frontend fills in — see chat.mapper equivalents in the frontend
 * ChatChartBlock.
 */
export interface ChatChartLabels {
  askPoint: string;
  askInterval: string;
  questionPointTemplate: string;
  questionIntervalTemplate: string;
}

const ENGLISH: ChatChartLabels = {
  askPoint: 'What happened here?',
  askInterval: 'What happened in this window?',
  questionPointTemplate:
    'On the "{title}" chart: {when}. What was going on at that time? ' +
    'Check other metrics, events and alarms in that window and explain the cause.',
  questionIntervalTemplate:
    'On the "{title}" chart: the interval from {from} to {to}. ' +
    'What was going on and what drove the change? Check other metrics, ' +
    'events and alarms in that window and explain the cause.',
};

const PLACEHOLDER_RE = /\{(\w+)\}/g;

function placeholdersOf(s: string): Set<string> {
  return new Set([...s.matchAll(PLACEHOLDER_RE)].map((m) => m[1]));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/**
 * Translates the chart click-to-ask UI strings into whatever language the
 * chat turn is in — genuinely ANY language (not a hardcoded RU/EN pair),
 * since the planner already resolves a natural-language name per turn for
 * answer composition. Translated once per distinct language and cached
 * for the life of the process; falls back to English on any failure or on
 * a translation that drops a `{placeholder}` token (would silently break
 * the composed question).
 */
@Injectable()
export class ChatUiLabelsService {
  private readonly logger = new Logger(ChatUiLabelsService.name);
  private readonly cache = new Map<string, ChatChartLabels>();

  constructor(private readonly chatLlmService: ChatLlmService) {}

  async getChartLabels(language: string | null): Promise<ChatChartLabels> {
    const normalized = language?.trim().toLowerCase() ?? '';
    if (!normalized || normalized === 'english' || normalized === 'en') {
      return ENGLISH;
    }

    const cached = this.cache.get(normalized);
    if (cached) return cached;

    try {
      const translated = await this.translate(language!.trim());
      this.cache.set(normalized, translated);
      return translated;
    } catch (err) {
      this.logger.warn(
        `Chart-label translation failed for "${language}": ${formatError(err)}`,
      );
      return ENGLISH;
    }
  }

  private async translate(language: string): Promise<ChatChartLabels> {
    const systemPrompt = [
      'You translate short UI strings for a yacht-crew chat app.',
      'Translate the JSON VALUES into the requested language. Keep the JSON',
      'keys unchanged. Keep every {placeholder} token EXACTLY as written',
      '(same spelling, same braces) — do not translate or alter placeholder',
      'names. Output ONLY the JSON object, no commentary, no markdown fence.',
    ].join(' ');
    const userPrompt = `Target language: ${language}\n\n${JSON.stringify(ENGLISH)}`;

    const raw = await this.chatLlmService.completeText({
      systemPrompt,
      userPrompt,
      temperature: 0,
      maxTokens: 500,
    });

    const jsonText = this.extractJson(raw ?? '');
    const parsed = JSON.parse(jsonText) as Partial<ChatChartLabels>;

    if (
      typeof parsed.askPoint !== 'string' ||
      typeof parsed.askInterval !== 'string' ||
      typeof parsed.questionPointTemplate !== 'string' ||
      typeof parsed.questionIntervalTemplate !== 'string'
    ) {
      throw new Error('translated payload missing expected keys');
    }

    // Guard against a translation that renamed/dropped a placeholder — that
    // would silently break the composed question at fill-in time.
    if (
      !sameSet(
        placeholdersOf(parsed.questionPointTemplate),
        placeholdersOf(ENGLISH.questionPointTemplate),
      ) ||
      !sameSet(
        placeholdersOf(parsed.questionIntervalTemplate),
        placeholdersOf(ENGLISH.questionIntervalTemplate),
      )
    ) {
      throw new Error('translated templates lost a {placeholder}');
    }

    return parsed as ChatChartLabels;
  }

  private extractJson(text: string): string {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON object in translation response');
    return match[0];
  }
}
