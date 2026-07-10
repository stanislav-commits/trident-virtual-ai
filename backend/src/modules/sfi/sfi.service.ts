import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SfiTaxonomyEntity } from './entities/sfi-taxonomy.entity';
import { SFI_TAXONOMY } from './sfi-taxonomy.data';

@Injectable()
export class SfiService implements OnModuleInit {
  private readonly logger = new Logger(SfiService.name);

  constructor(
    @InjectRepository(SfiTaxonomyEntity)
    private readonly repo: Repository<SfiTaxonomyEntity>,
  ) {}

  /**
   * Idempotent seed on boot. Re-seeds only when the row count differs from the
   * committed data (fresh DB, or the taxonomy changed). Swallows errors so a
   * missing table (migration not yet run) doesn't crash startup.
   */
  async onModuleInit(): Promise<void> {
    try {
      const count = await this.repo.count();
      if (count === SFI_TAXONOMY.length) return;
      // Transactional so a failed insert (e.g. a column not migrated yet)
      // rolls back the clear and leaves the existing rows intact.
      await this.repo.manager.transaction(async (tx) => {
        const r = tx.getRepository(SfiTaxonomyEntity);
        await r.clear();
        await r.insert(SFI_TAXONOMY.map((n) => ({ ...n })));
        // Re-sync the register's stored SFI names to the (new) taxonomy by code,
        // so existing assets don't keep stale sub-group names after a taxonomy
        // update. Codes are untouched — only the display names follow the master.
        await tx.query(
          `UPDATE assets a SET sfi_group_name = t.name
             FROM sfi_taxonomy t
            WHERE t.code = a.sfi_group AND t.level = 1 AND a.sfi_group IS NOT NULL`,
        );
        await tx.query(
          `UPDATE assets a SET sfi_sub_name = t.name
             FROM sfi_taxonomy t
            WHERE t.code = a.sfi_sub AND t.level = 2 AND a.sfi_sub IS NOT NULL`,
        );
      });
      this.logger.log(
        `Seeded SFI taxonomy: ${SFI_TAXONOMY.length} nodes + re-synced asset SFI names`,
      );
    } catch (err) {
      this.logger.warn(`SFI taxonomy seed skipped: ${(err as Error).message}`);
    }
  }

  /** Top-level SFI groups (level 1), in canonical order. */
  groups(): Promise<SfiTaxonomyEntity[]> {
    return this.repo.find({ where: { level: 1 }, order: { sortOrder: 'ASC' } });
  }

  /**
   * Sub-groups of a group. Defaults to level 2 — the depth the register's
   * `sfi_sub` uses (e.g. `3.2`). Pass a deeper level for finer nodes.
   */
  subs(groupCode: string, level = 2): Promise<SfiTaxonomyEntity[]> {
    return this.repo.find({
      where: { groupCode, level },
      order: { sortOrder: 'ASC' },
    });
  }

  /** Whole taxonomy (all levels), in canonical order. */
  all(): Promise<SfiTaxonomyEntity[]> {
    return this.repo.find({ order: { sortOrder: 'ASC' } });
  }

  /** Look up a single node by its dotted code — used for import validation. */
  byCode(code: string): Promise<SfiTaxonomyEntity | null> {
    return this.repo.findOne({ where: { code } });
  }
}
