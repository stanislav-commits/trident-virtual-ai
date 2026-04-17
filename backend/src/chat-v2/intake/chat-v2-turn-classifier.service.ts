import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import {
  ChatV2Language,
  ChatV2TurnClassification,
  ChatV2TurnKind,
} from '../chat-v2.types';

type RawLlmClassification = Partial<{
  kind: unknown;
  confidence: unknown;
  language: unknown;
  reason: unknown;
  userTask: unknown;
}>;

@Injectable()
export class ChatV2TurnClassifierService {
  private readonly logger = new Logger(ChatV2TurnClassifierService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.model =
      process.env.CHAT_V2_CLASSIFIER_MODEL ||
      process.env.LLM_MODEL ||
      'gpt-4o-mini';
  }

  async classify(userQuery: string): Promise<ChatV2TurnClassification> {
    const rawQuery = userQuery.trim();

    if (!rawQuery) {
      return {
        kind: 'small_talk',
        confidence: 1,
        language: 'unknown',
        reason: 'The message is empty.',
      };
    }

    try {
      const outputText = await this.classifyWithLlm(rawQuery);
      return this.parseLlmClassification(outputText, rawQuery);
    } catch (error) {
      this.logger.warn(
        `Chat v2 LLM turn classification failed; routing as task_request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return {
        kind: 'task_request',
        confidence: 0,
        language: 'unknown',
        reason:
          'LLM classification failed. Routed as task_request to avoid losing a real user request.',
        userTask: rawQuery,
      };
    }
  }

  private async classifyWithLlm(userQuery: string): Promise<string> {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is not set');
    }

    const response = await this.client.responses.create({
      model: this.model,
      temperature: 0,
      max_output_tokens: 260,
      instructions:
        'Classify a single user chat message for Trident Intelligence.\n' +
        'Return ONLY valid JSON with this shape: {"kind":"small_talk"|"task_request","confidence":0..1,"language":"en"|"uk"|"ru"|"it"|"unknown","reason":"short reason","userTask":string|null}.\n' +
        'Definitions:\n' +
        '- small_talk: casual conversation only, greetings, thanks, social check-ins, jokes, or friendly non-operational conversation. No useful action or information retrieval is requested.\n' +
        '- task_request: the user asks for any useful action, answer, lookup, calculation, chat-history recall, vessel data, manuals, metrics, regulations, certificates, procedures, or troubleshooting.\n' +
        'Important examples:\n' +
        '- "hi there" => small_talk\n' +
        '- "How are you doing today?" => small_talk\n' +
        '- "hi, what is current yacht speed?" => task_request\n' +
        '- "what was my previous question?" => task_request\n' +
        '- "can you explain bunkering step by step?" => task_request\n' +
        'If unsure, choose task_request.',
      input: [
        {
          role: 'user',
          content: `User message:\n${userQuery}`,
        },
      ],
    });

    const outputText = response.output_text?.trim();
    if (!outputText) {
      throw new Error('Empty classifier response from LLM');
    }

    return outputText;
  }

  private parseLlmClassification(
    outputText: string,
    rawQuery: string,
  ): ChatV2TurnClassification {
    const raw = this.parseJsonObject(outputText);
    const kind = this.parseKind(raw.kind);
    const confidence = this.parseConfidence(raw.confidence);
    const language = this.parseLanguage(raw.language);
    const reason =
      typeof raw.reason === 'string' && raw.reason.trim()
        ? raw.reason.trim()
        : 'LLM classified the turn.';
    const userTask =
      typeof raw.userTask === 'string' && raw.userTask.trim()
        ? raw.userTask.trim()
        : kind === 'task_request'
          ? rawQuery
          : undefined;

    return {
      kind,
      confidence,
      language,
      reason,
      ...(userTask ? { userTask } : {}),
    };
  }

  private parseJsonObject(outputText: string): RawLlmClassification {
    try {
      return JSON.parse(outputText) as RawLlmClassification;
    } catch {
      const jsonMatch = outputText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Classifier response did not contain JSON');
      }

      return JSON.parse(jsonMatch[0]) as RawLlmClassification;
    }
  }

  private parseKind(value: unknown): ChatV2TurnKind {
    if (value === 'small_talk' || value === 'task_request') {
      return value;
    }

    throw new Error('Classifier response had an invalid kind');
  }

  private parseConfidence(value: unknown): number {
    const confidence = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(confidence)) {
      return 0.5;
    }

    return Math.max(0, Math.min(1, confidence));
  }

  private parseLanguage(value: unknown): ChatV2Language {
    if (
      value === 'en' ||
      value === 'uk' ||
      value === 'ru' ||
      value === 'it' ||
      value === 'unknown'
    ) {
      return value;
    }

    return 'unknown';
  }
}
