import { Injectable, Logger } from '@nestjs/common';
import { SemanticLlmService } from '../../semantic/semantic-llm.service';

export interface TelemetrySemanticQuery {
  schemaVersion: string;
  measurementKinds: string[];
  subjectTerms: string[];
  semanticPhrases: string[];
  preferredSpeedKind: 'sog' | 'stw' | 'vmg' | null;
  confidence: number;
}

const TELEMETRY_MEASUREMENT_KINDS = [
  'temperature',
  'pressure',
  'voltage',
  'current',
  'load',
  'power',
  'energy',
  'speed',
  'flow',
  'hours',
  'status',
  'level',
  'location',
  'heading',
] as const;

const TELEMETRY_QUERY_SEMANTIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'measurementKinds',
    'subjectTerms',
    'semanticPhrases',
    'preferredSpeedKind',
    'confidence',
  ],
  properties: {
    measurementKinds: {
      type: 'array',
      items: {
        type: 'string',
        enum: [...TELEMETRY_MEASUREMENT_KINDS],
      },
      maxItems: 6,
    },
    subjectTerms: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 8,
    },
    semanticPhrases: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 10,
    },
    preferredSpeedKind: {
      anyOf: [
        { type: 'null' },
        { type: 'string', enum: ['sog', 'stw', 'vmg'] },
      ],
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
  },
} as const;

@Injectable()
export class TelemetryQuerySemanticNormalizerService {
  private readonly logger = new Logger(
    TelemetryQuerySemanticNormalizerService.name,
  );

  constructor(private readonly semanticLlm: SemanticLlmService) {}

  async normalize(params: {
    userQuery: string;
    resolvedSubjectQuery?: string;
  }): Promise<TelemetrySemanticQuery> {
    const fallback = this.buildFallback(params);
    if (!this.semanticLlm.isConfigured()) {
      return fallback;
    }

    try {
      const raw = await this.semanticLlm.generateStructuredObject<unknown>({
        name: 'telemetry_query_semantic_hints',
        description:
          'Structured telemetry retrieval hints for a yacht telemetry user query.',
        schema: TELEMETRY_QUERY_SEMANTIC_SCHEMA as Record<string, unknown>,
        instructions: this.buildInstructions(),
        input: this.buildInput(params),
      });
      return this.mergeWithFallback(this.parse(raw), fallback);
    } catch (error) {
      this.logger.warn(
        `Telemetry semantic fallback used for "${this.truncate(params.userQuery)}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return fallback;
    }
  }

  private buildInstructions(): string {
    return [
      'You interpret yacht telemetry questions into compact retrieval hints.',
      'Do not answer the user question.',
      'Return only concise canonical telemetry search hints that could help match metric labels, fields, measurements, or descriptions.',
      'Prefer canonical marine telemetry wording over the user wording when the user uses conversational phrasing.',
      'For vessel location requests, including conversational wording like whereabouts or where are we, include phrases such as latitude, longitude, vessel position, or coordinates when appropriate.',
      'For vessel speed requests, including pace, how fast, moving, or underway wording, include speed over ground when that is the most likely current navigation speed metric.',
      'For vessel heading requests, including heading, heading true, or course wording, include phrases such as heading true, heading magnetic, or vessel heading when appropriate.',
      'For runtime questions, map natural language such as operating time or time on equipment to running hours, runtime, or hour meter when appropriate.',
      'Do not invent vendor or equipment names that are not implied by the query.',
      'Keep subjectTerms short noun phrases or single-word asset terms.',
      'Keep semanticPhrases short and retrieval-oriented.',
    ].join(' ');
  }

  private buildInput(params: {
    userQuery: string;
    resolvedSubjectQuery?: string;
  }): string {
    return [
      `User query:\n${params.userQuery.trim()}`,
      params.resolvedSubjectQuery?.trim()
        ? `Resolved subject context:\n${params.resolvedSubjectQuery.trim()}`
        : '',
      `Allowed measurement kinds: ${TELEMETRY_MEASUREMENT_KINDS.join(', ')}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private parse(raw: unknown): TelemetrySemanticQuery {
    const value = this.asRecord(raw);
    const measurementKinds = this.readStringArray(value.measurementKinds).filter(
      (kind): kind is TelemetrySemanticQuery['measurementKinds'][number] =>
        (TELEMETRY_MEASUREMENT_KINDS as readonly string[]).includes(kind),
    );
    const subjectTerms = this.cleanTerms(this.readStringArray(value.subjectTerms));
    const semanticPhrases = this.cleanTerms(
      this.readStringArray(value.semanticPhrases),
      60,
    );
    const preferredSpeedKind =
      value.preferredSpeedKind === 'sog' ||
      value.preferredSpeedKind === 'stw' ||
      value.preferredSpeedKind === 'vmg'
        ? value.preferredSpeedKind
        : null;
    const confidence =
      typeof value.confidence === 'number' && Number.isFinite(value.confidence)
        ? Math.max(0, Math.min(1, value.confidence))
        : 0;

    return {
      schemaVersion: 'telemetry-semantic-query.v1',
      measurementKinds,
      subjectTerms,
      semanticPhrases,
      preferredSpeedKind,
      confidence,
    };
  }

  private buildFallback(params: {
    userQuery: string;
    resolvedSubjectQuery?: string;
  }): TelemetrySemanticQuery {
    const normalized = this.normalizeText(
      `${params.userQuery}\n${params.resolvedSubjectQuery ?? ''}`,
    );
    const tokens = normalized
      .split(/\s+/)
      .filter(Boolean)
      .filter((token) => token.length >= 3)
      .filter((token) => !this.isStopWord(token));
    const measurementKinds = this.extractFallbackMeasurementKinds(normalized);
    const subjectTerms = [...new Set(tokens)].slice(0, 6);
    const semanticPhrases = this.buildFallbackPhrases(
      subjectTerms,
      measurementKinds,
    );

    return {
      schemaVersion: 'telemetry-semantic-query.v1',
      measurementKinds,
      subjectTerms,
      semanticPhrases,
      preferredSpeedKind:
        /\b(speed\s+over\s+ground|sog|pace|how\s+fast)\b/i.test(normalized)
          ? 'sog'
          : null,
      confidence:
        measurementKinds.length > 0 || semanticPhrases.length > 0 ? 0.35 : 0.15,
    };
  }

  private mergeWithFallback(
    parsed: TelemetrySemanticQuery,
    fallback: TelemetrySemanticQuery,
  ): TelemetrySemanticQuery {
    const mergedKinds = [
      ...new Set([...parsed.measurementKinds, ...fallback.measurementKinds]),
    ];
    const mergedSubjectTerms = this.cleanTerms([
      ...parsed.subjectTerms,
      ...fallback.subjectTerms,
    ]);
    const mergedPhrases = this.cleanTerms(
      [...parsed.semanticPhrases, ...fallback.semanticPhrases],
      60,
    );

    return {
      schemaVersion: parsed.schemaVersion,
      measurementKinds: mergedKinds,
      subjectTerms: mergedSubjectTerms,
      semanticPhrases: mergedPhrases,
      preferredSpeedKind:
        parsed.preferredSpeedKind ?? fallback.preferredSpeedKind ?? null,
      confidence: Math.max(parsed.confidence, fallback.confidence),
    };
  }

  private buildFallbackPhrases(
    subjectTerms: string[],
    measurementKinds: string[],
  ): string[] {
    const phrases = new Set<string>();
    const subjectPhrase = subjectTerms.slice(0, 3).join(' ').trim();

    for (const kind of measurementKinds) {
      switch (kind) {
        case 'location':
          phrases.add('vessel location');
          phrases.add('vessel position');
          phrases.add('latitude');
          phrases.add('longitude');
          break;
        case 'speed':
          phrases.add('vessel speed');
          phrases.add('speed over ground');
          break;
        case 'heading':
          phrases.add('vessel heading');
          phrases.add('heading true');
          phrases.add('heading magnetic');
          break;
        case 'hours':
          phrases.add('running hours');
          phrases.add('runtime');
          phrases.add('hour meter');
          break;
        default:
          phrases.add(kind);
          break;
      }
    }

    if (subjectPhrase) {
      for (const kind of measurementKinds) {
        if (kind === 'location') {
          phrases.add(`${subjectPhrase} position`);
          continue;
        }
        if (kind === 'speed') {
          phrases.add(`${subjectPhrase} speed`);
          continue;
        }
        if (kind === 'heading') {
          phrases.add(`${subjectPhrase} heading`);
          continue;
        }
        if (kind === 'hours') {
          phrases.add(`${subjectPhrase} runtime`);
          phrases.add(`${subjectPhrase} running hours`);
          continue;
        }
        phrases.add(`${subjectPhrase} ${kind}`);
      }
    }

    return [...phrases].slice(0, 8);
  }

  private extractFallbackMeasurementKinds(normalized: string): string[] {
    const kinds: string[] = [];
    const checks: Array<
      [kind: TelemetrySemanticQuery['measurementKinds'][number], pattern: RegExp]
    > = [
      [
        'location',
        /\b(latitude|longitude|location|position|coordinates?|whereabouts|lat|lon|gps)\b|\bwhere\s+(?:are\s+we|am\s+i)\b/i,
      ],
      ['speed', /\b(speed|pace|sog|stw|vmg|knots?|kts?)\b|\bhow\s+fast\b/i],
      [
        'heading',
        /\b(heading|heading\s+true|heading\s+magnetic|course\s+over\s+ground|cog)\b/i,
      ],
      ['hours', /\b(runtime|running|hours?|hour meter)\b/i],
      ['voltage', /\b(voltages?|volts?)\b/i],
      ['current', /\b(currents?|amps?|amperage)\b/i],
      ['temperature', /\b(temp(?:erature)?|temps?)\b/i],
      ['pressure', /\b(pressure|pressures)\b/i],
      ['load', /\b(load|loads)\b/i],
      ['power', /\b(power|watts?|kilowatts?|kw)\b/i],
      ['flow', /\b(flow|flows?|rate|rates)\b/i],
      ['level', /\b(level|levels|quantity|volume|remaining|available|onboard)\b/i],
      ['status', /\b(status|state|alarm|warning|fault|trip)\b/i],
    ];
    for (const [kind, pattern] of checks) {
      if (pattern.test(normalized)) {
        kinds.push(kind);
      }
    }
    return kinds;
  }

  private cleanTerms(values: string[], maxLength = 40): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const normalized = this.normalizeText(value);
      if (!normalized || normalized.length > maxLength || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      result.push(normalized);
      if (result.length >= 10) {
        break;
      }
    }
    return result;
  }

  private readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is string => typeof item === 'string');
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Telemetry semantic payload must be an object');
    }
    return value as Record<string, unknown>;
  }

  private normalizeText(value: string): string {
    return value
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_./:-]+/g, ' ')
      .replace(/[^a-zA-Z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private isStopWord(value: string): boolean {
    return new Set([
      'a',
      'an',
      'and',
      'are',
      'at',
      'boat',
      'current',
      'for',
      'how',
      'i',
      'in',
      'is',
      'latest',
      'location',
      'me',
      'metric',
      'metrics',
      'my',
      'now',
      'of',
      'on',
      'our',
      'please',
      'position',
      'reading',
      'readings',
      'right',
      'ship',
      'show',
      'speed',
      'status',
      'telemetry',
      'tell',
      'that',
      'the',
      'their',
      'there',
      'these',
      'this',
      'value',
      'values',
      'vessel',
      'we',
      'what',
      'where',
      'which',
      'with',
      'yacht',
      'you',
      'your',
    ]).has(value);
  }

  private truncate(value: string): string {
    const compact = value.replace(/\s+/g, ' ').trim();
    return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
  }
}
