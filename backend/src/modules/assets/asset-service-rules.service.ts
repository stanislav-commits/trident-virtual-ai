import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ServiceRuleEntity } from './entities/service-rule.entity';
import type {
  CompleteServiceRuleDto,
  CreateServiceRuleDto,
  UpdateServiceRuleDto,
} from './dto/service-rule.dto';
import { AssetsService } from './assets.service';

/**
 * Per-asset service rules — the register's own maintenance intervals.
 *
 * Superseded by pms_tasks, which is where planned maintenance actually lives
 * now, and the table is empty on production. Kept because the chat analyzer
 * still reads it, and moved out here so a deprecated subsystem stops taking up
 * room in the register service.
 */
@Injectable()
export class AssetServiceRulesService {
  constructor(
    @InjectRepository(ServiceRuleEntity)
    private readonly serviceRuleRepository: Repository<ServiceRuleEntity>,
    private readonly assetsService: AssetsService,
  ) {}

  async listServiceRules(
    shipId: string,
    assetUuid: string,
  ): Promise<ServiceRuleEntity[]> {
    await this.assetsService.getOne(shipId, assetUuid); // asserts ship + asset
    return this.serviceRuleRepository.find({
      where: { shipId, assetId: assetUuid },
      order: { taskName: 'ASC' },
    });
  }

  async createServiceRule(
    shipId: string,
    assetUuid: string,
    dto: CreateServiceRuleDto,
  ): Promise<ServiceRuleEntity> {
    await this.assetsService.getOne(shipId, assetUuid);
    if (dto.intervalHours == null && dto.intervalMonths == null) {
      throw new BadRequestException(
        'At least one of intervalHours / intervalMonths is required',
      );
    }
    const existing = await this.serviceRuleRepository.findOne({
      where: { assetId: assetUuid, taskName: dto.taskName },
    });
    if (existing) {
      throw new ConflictException(
        `Rule "${dto.taskName}" already exists for this asset`,
      );
    }
    return this.serviceRuleRepository.save(
      this.serviceRuleRepository.create({
        shipId,
        assetId: assetUuid,
        taskName: dto.taskName,
        intervalHours: dto.intervalHours ?? null,
        intervalMonths: dto.intervalMonths ?? null,
        lastDoneAt: dto.lastDoneAt ? new Date(dto.lastDoneAt) : null,
        lastDoneRuntimeHours: dto.lastDoneRuntimeHours ?? null,
        source: dto.source ?? 'manual',
        notes: dto.notes ?? null,
      }),
    );
  }

  async updateServiceRule(
    shipId: string,
    ruleId: string,
    dto: UpdateServiceRuleDto,
  ): Promise<ServiceRuleEntity> {
    const rule = await this.serviceRuleRepository.findOne({
      where: { id: ruleId, shipId },
    });
    if (!rule) throw new NotFoundException(`Service rule ${ruleId} not found`);
    if (dto.taskName !== undefined) rule.taskName = dto.taskName;
    if (dto.intervalHours !== undefined) rule.intervalHours = dto.intervalHours;
    if (dto.intervalMonths !== undefined) rule.intervalMonths = dto.intervalMonths;
    if (dto.lastDoneAt !== undefined) {
      rule.lastDoneAt = dto.lastDoneAt ? new Date(dto.lastDoneAt) : null;
    }
    if (dto.lastDoneRuntimeHours !== undefined) {
      rule.lastDoneRuntimeHours = dto.lastDoneRuntimeHours;
    }
    if (dto.notes !== undefined) rule.notes = dto.notes;
    if (rule.intervalHours == null && rule.intervalMonths == null) {
      throw new BadRequestException(
        'Rule must keep at least one of intervalHours / intervalMonths',
      );
    }
    // Any manual edit confirms the rule — clear the ai_extracted flag so
    // it counts as human-verified from here on.
    rule.source = 'manual';
    return this.serviceRuleRepository.save(rule);
  }

  /** "Mark done": stamps the completion baseline. */
  async completeServiceRule(
    shipId: string,
    ruleId: string,
    dto: CompleteServiceRuleDto,
  ): Promise<ServiceRuleEntity> {
    const rule = await this.serviceRuleRepository.findOne({
      where: { id: ruleId, shipId },
    });
    if (!rule) throw new NotFoundException(`Service rule ${ruleId} not found`);
    rule.lastDoneAt = dto.doneAt ? new Date(dto.doneAt) : new Date();
    if (dto.runtimeHours !== undefined) {
      rule.lastDoneRuntimeHours = dto.runtimeHours;
    }
    if (dto.notes) {
      rule.notes = rule.notes
        ? `${rule.notes}\n[done ${rule.lastDoneAt.toISOString().slice(0, 10)}] ${dto.notes}`
        : `[done ${rule.lastDoneAt.toISOString().slice(0, 10)}] ${dto.notes}`;
    }
    return this.serviceRuleRepository.save(rule);
  }

  async deleteServiceRule(shipId: string, ruleId: string): Promise<void> {
    const rule = await this.serviceRuleRepository.findOne({
      where: { id: ruleId, shipId },
    });
    if (!rule) throw new NotFoundException(`Service rule ${ruleId} not found`);
    await this.serviceRuleRepository.remove(rule);
  }
}
