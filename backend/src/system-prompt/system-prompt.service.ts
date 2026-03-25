import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  SYSTEM_PROMPT_PLACEHOLDERS,
  SYSTEM_PROMPT_SETTING_KEY,
} from './system-prompt.constants';

type PromptSettingRecord = {
  value: string;
  updatedAt: Date;
  updatedBy: {
    id: string;
    userId: string;
    name: string | null;
  } | null;
} | null;

@Injectable()
export class SystemPromptService {
  constructor(private readonly prisma: PrismaService) {}

  async getPromptTemplate(): Promise<string> {
    const record = await this.prisma.appSetting.findUnique({
      where: { key: SYSTEM_PROMPT_SETTING_KEY },
      select: { value: true },
    });

    return record?.value ?? DEFAULT_SYSTEM_PROMPT_TEMPLATE;
  }

  async getSystemPrompt() {
    const record = await this.findPromptRecord();
    return this.buildPromptResponse(record);
  }

  async updateSystemPrompt(prompt: string, updatedById: string) {
    const normalizedPrompt = prompt.replace(/\r\n/g, '\n').trim();
    if (!normalizedPrompt) {
      throw new BadRequestException('System prompt cannot be empty');
    }

    const record = await this.prisma.appSetting.upsert({
      where: { key: SYSTEM_PROMPT_SETTING_KEY },
      create: {
        key: SYSTEM_PROMPT_SETTING_KEY,
        value: normalizedPrompt,
        updatedById,
      },
      update: {
        value: normalizedPrompt,
        updatedById,
      },
      select: {
        value: true,
        updatedAt: true,
        updatedBy: {
          select: {
            id: true,
            userId: true,
            name: true,
          },
        },
      },
    });

    return this.buildPromptResponse(record);
  }

  private async findPromptRecord(): Promise<PromptSettingRecord> {
    return this.prisma.appSetting.findUnique({
      where: { key: SYSTEM_PROMPT_SETTING_KEY },
      select: {
        value: true,
        updatedAt: true,
        updatedBy: {
          select: {
            id: true,
            userId: true,
            name: true,
          },
        },
      },
    });
  }

  private buildPromptResponse(record: PromptSettingRecord) {
    return {
      prompt: record?.value ?? DEFAULT_SYSTEM_PROMPT_TEMPLATE,
      isDefault: !record,
      updatedAt: record?.updatedAt ?? null,
      updatedBy: record?.updatedBy ?? null,
      placeholders: [...SYSTEM_PROMPT_PLACEHOLDERS],
    };
  }
}
