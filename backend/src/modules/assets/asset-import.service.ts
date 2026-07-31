import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ShipMetricCatalogEntity } from '../metrics/entities/ship-metric-catalog.entity';
import { ShipEntity } from '../ships/entities/ship.entity';
import { CreateAssetDto } from './dto/create-asset.dto';
import { ImportResultDto } from './dto/import-result.dto';
import { AssetDocumentLinkEntity } from './entities/asset-document-link.entity';
import { AssetEntity } from './entities/asset.entity';
import { SfiService } from '../sfi/sfi.service';
import type {
  ImportPreviewResult,
  ImportPreviewRename,
  ImportPreviewSfiWarning,
} from './dto/import-preview.dto';
import type { CommitImportOptions } from './dto/commit-import.dto';
import { lowerTrim } from './assets.normalization';
import { parseXlsxToDrafts } from './asset-xlsx.codec';
import { AssetSnapshotService } from './asset-snapshot.service';

/**
 * Loading a register file: dry-run first, then commit.
 *
 * Split out of AssetsService because an import is a different kind of
 * operation from the CRUD around it — it reads a whole file, diffs it against
 * the whole ship, and rewrites the register in one transaction. The preview is
 * the point: 1500 rows arriving from a spreadsheet is not something anyone
 * should apply unseen, so nothing here writes until the operator has looked at
 * the create/update/orphan counts and said yes.
 */
@Injectable()
export class AssetImportService {
  constructor(
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipRepository: Repository<ShipEntity>,
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly metricCatalogRepository: Repository<ShipMetricCatalogEntity>,
    @InjectRepository(AssetDocumentLinkEntity)
    private readonly assetDocLinkRepository: Repository<AssetDocumentLinkEntity>,
    private readonly sfiService: SfiService,
    private readonly snapshots: AssetSnapshotService,
  ) {}

  async previewImportFromXlsx(
    shipId: string,
    buffer: Buffer,
  ): Promise<ImportPreviewResult> {
    await this.assertShipExists(shipId);
    const { drafts, parseErrors, totalRows } = parseXlsxToDrafts(buffer);

    const existing = await this.assetRepository.find({ where: { shipId } });
    const existingByCode = new Map(
      existing.map((a) => [a.assetIdInternal, a]),
    );
    const incomingByCode = new Map(drafts.map((d) => [d.draft.assetIdInternal!, d.draft]));

    const create: ImportPreviewResult['create'] = [];
    const update: ImportPreviewResult['update'] = [];

    for (const { draft } of drafts) {
      const code = draft.assetIdInternal!;
      const current = existingByCode.get(code);
      if (!current) {
        create.push({
          assetIdInternal: code,
          displayName: draft.displayName!,
          sfiGroup: draft.sfiGroup ?? null,
          brand: draft.brand ?? null,
          model: draft.model ?? null,
        });
        continue;
      }
      const changes = this.diffAssetFields(current, draft);
      if (changes.length > 0) {
        update.push({
          assetIdInternal: code,
          displayName: draft.displayName!,
          changes,
        });
      }
    }

    // Orphans = current assets that are NOT mentioned in the file.
    const orphans = existing.filter((a) => !incomingByCode.has(a.assetIdInternal));

    // Rename candidates = orphan + new-create with matching display_name
    // + brand + model (or weaker tiers). Conservative: don't propose if
    // displayName is missing on either side.
    const renames: ImportPreviewRename[] = [];
    const norm = lowerTrim;
    for (const o of orphans) {
      if (!o.displayName) continue;
      for (const c of create) {
        if (norm(c.displayName) !== norm(o.displayName)) continue;
        const brandMatch =
          o.brand && c.brand && norm(o.brand) === norm(c.brand);
        const modelMatch =
          o.model && c.model && norm(o.model) === norm(c.model);
        let score: ImportPreviewRename['matchScore'];
        if (brandMatch && modelMatch) score = 'exact-name-brand-model';
        else if (brandMatch) score = 'exact-name-brand';
        else score = 'exact-name';
        renames.push({
          oldAssetIdInternal: o.assetIdInternal,
          newAssetIdInternal: c.assetIdInternal,
          displayName: o.displayName,
          matchScore: score,
        });
        break; // one match per orphan is enough for the UI
      }
    }

    // Bound metric + linked doc counts per orphan — admin wants to know
    // what data they'd lose by deleting.
    const orphanIds = orphans.map((o) => o.id);
    let metricCounts = new Map<string, number>();
    let docCounts = new Map<string, number>();
    if (orphanIds.length > 0) {
      const mc = await this.metricCatalogRepository
        .createQueryBuilder('m')
        .select('m.bound_asset_id', 'asset_id')
        .addSelect('COUNT(*)', 'cnt')
        .where('m.bound_asset_id IN (:...ids)', { ids: orphanIds })
        .groupBy('m.bound_asset_id')
        .getRawMany<{ asset_id: string; cnt: string }>();
      metricCounts = new Map(mc.map((r) => [r.asset_id, parseInt(r.cnt, 10)]));
      const dc = await this.assetDocLinkRepository
        .createQueryBuilder('l')
        .select('l.asset_id', 'asset_id')
        .addSelect('COUNT(*)', 'cnt')
        .where('l.asset_id IN (:...ids)', { ids: orphanIds })
        .groupBy('l.asset_id')
        .getRawMany<{ asset_id: string; cnt: string }>();
      docCounts = new Map(dc.map((r) => [r.asset_id, parseInt(r.cnt, 10)]));
    }

    const orphansOut = orphans.map((o) => ({
      assetIdInternal: o.assetIdInternal,
      displayName: o.displayName,
      sfiGroup: o.sfiGroup,
      brand: o.brand,
      model: o.model,
      boundMetricCount: metricCounts.get(o.id) ?? 0,
      linkedDocumentCount: docCounts.get(o.id) ?? 0,
    }));
    // Suppress orphans that have a rename candidate from the orphans list
    // — UI shows them in the "potentialRenames" bucket instead so admin
    // doesn't get confused.
    const renameOldCodes = new Set(renames.map((r) => r.oldAssetIdInternal));
    const orphansFinal = orphansOut.filter(
      (o) => !renameOldCodes.has(o.assetIdInternal),
    );

    // SFI validation against the loaded taxonomy — flag drafts whose
    // sfi_sub isn't a known catalog code (off-standard / typo) or is
    // missing entirely. Non-blocking; surfaced in the preview modal.
    const validSfi = new Set((await this.sfiService.all()).map((n) => n.code));
    const sfiWarnings: ImportPreviewSfiWarning[] = [];
    for (const { draft } of drafts) {
      const sub = draft.sfiSub ?? null;
      if (!sub) {
        sfiWarnings.push({
          assetIdInternal: draft.assetIdInternal!,
          sfiSub: null,
          reason: 'missing',
        });
      } else if (!validSfi.has(sub)) {
        sfiWarnings.push({
          assetIdInternal: draft.assetIdInternal!,
          sfiSub: sub,
          reason: 'unknown-code',
        });
      }
    }

    return {
      totalRows,
      parseErrors,
      create,
      update,
      orphans: orphansFinal,
      potentialRenames: renames,
      sfiWarnings,
      counts: {
        create: create.length,
        update: update.length,
        orphans: orphansFinal.length,
        renames: renames.length,
        parseErrors: parseErrors.length,
        sfiWarnings: sfiWarnings.length,
      },
    };
  }

  private diffAssetFields(
    current: AssetEntity,
    draft: Partial<CreateAssetDto>,
  ): Array<{ field: string; oldValue: string | null; newValue: string | null }> {
    const out: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
    // List of fields to diff. Skip extras (jsonb) — it's merged, not
    // replaced, so a per-key diff would be noisy. Skip auto-populated
    // provenance flags too.
    const fields: Array<[keyof CreateAssetDto, keyof AssetEntity]> = [
      ['displayName', 'displayName'],
      ['sfiGroup', 'sfiGroup'],
      ['sfiSub', 'sfiSub'],
      ['sfiSubName', 'sfiSubName'],
      ['sfiGroupName', 'sfiGroupName'],
      ['drawingCode', 'drawingCode'],
      ['department', 'department'],
      ['parentAssetId', 'parentAssetId'],
      ['servedByAssetId', 'servedByAssetId'],
      ['locationAssetId', 'locationAssetId'],
      ['brand', 'brand'],
      ['model', 'model'],
      ['serialNo', 'serialNo'],
      ['location', 'location'],
      ['rinaRef', 'rinaRef'],
      ['notes', 'notes'],
      ['zone', 'zone'],
      ['deckRole', 'deckRole'],
      ['spaceInstance', 'spaceInstance'],
      ['spaceLabel', 'spaceLabel'],
      ['drawingRef', 'drawingRef'],
      ['inspectionObligation', 'inspectionObligation'],
    ];
    for (const [draftKey, entityKey] of fields) {
      const next = (draft[draftKey] as unknown as string | undefined) ?? null;
      const cur = (current[entityKey] as unknown as string | null | undefined) ?? null;
      // null in draft means "missing in file" — we preserve current, no
      // change. Only diff when draft has a non-null new value.
      if (next === null) continue;
      if (String(next).trim() === String(cur ?? '').trim()) continue;
      out.push({
        field: String(draftKey),
        oldValue: cur === null ? null : String(cur),
        newValue: String(next),
      });
    }
    // Numbers
    if (
      draft.criticality !== undefined &&
      draft.criticality !== null &&
      draft.criticality !== current.criticality
    ) {
      out.push({
        field: 'criticality',
        oldValue: current.criticality?.toString() ?? null,
        newValue: draft.criticality.toString(),
      });
    }
    if (
      draft.deckLevel !== undefined &&
      draft.deckLevel !== null &&
      draft.deckLevel !== current.deckLevel
    ) {
      out.push({
        field: 'deckLevel',
        oldValue: current.deckLevel?.toString() ?? null,
        newValue: draft.deckLevel.toString(),
      });
    }
    return out;
  }

  /**
   * Commit an import. The buffer is parsed AGAIN here (rather than
   * passed from preview) — keeps the API stateless and avoids storing
   * uploaded files between requests. The drafts go through the same
   * upsert as the legacy flow; orphan delete + rename merge happen in
   * the same transaction so the operation is all-or-nothing.
   */
  async commitImportFromXlsx(
    shipId: string,
    buffer: Buffer,
    opts: CommitImportOptions,
    userId: string | null,
  ): Promise<ImportResultDto & { snapshotId: string | null; deleted: number; merged: number }> {
    await this.assertShipExists(shipId);

    let snapshotId: string | null = null;
    if (opts.snapshotBefore !== false) {
      // Default to TRUE — admins explicitly opt out, not opt in. The
      // table is cheap and the rollback option is precious.
      snapshotId = await this.snapshots.create(
        shipId,
        `pre-import (${new Date().toISOString().slice(0, 10)})`,
        userId,
      );
    }

    const { drafts, parseErrors, totalRows } = parseXlsxToDrafts(buffer);
    const result: ImportResultDto = {
      totalRows,
      inserted: 0,
      updated: 0,
      skipped: parseErrors.length,
      errors: parseErrors.map((e) => ({ row: e.row, reason: e.reason })),
    };

    // Compute renames + orphans BEFORE the upsert so we can act on them
    // after using the new-asset UUIDs.
    const existing = await this.assetRepository.find({ where: { shipId } });
    const existingByCode = new Map(existing.map((a) => [a.assetIdInternal, a]));
    const incomingCodes = new Set(drafts.map((d) => d.draft.assetIdInternal!));
    const orphansBefore = existing.filter((a) => !incomingCodes.has(a.assetIdInternal));

    const renames: Array<{ oldId: string; newCode: string }> = [];
    if (opts.mergeRenames) {
      const norm = lowerTrim;
      for (const o of orphansBefore) {
        if (!o.displayName) continue;
        for (const d of drafts) {
          if (existingByCode.has(d.draft.assetIdInternal!)) continue; // not a new create
          if (norm(d.draft.displayName) !== norm(o.displayName)) continue;
          renames.push({
            oldId: o.id,
            newCode: d.draft.assetIdInternal!,
          });
          break;
        }
      }
    }

    let mergedCount = 0;
    let deletedCount = 0;

    await this.assetRepository.manager.transaction(async (tx) => {
      const txRepo = tx.getRepository(AssetEntity);
      for (const { rowNum, draft } of drafts) {
        try {
          const existingRow = await txRepo.findOne({
            where: { shipId, assetIdInternal: draft.assetIdInternal },
          });
          if (existingRow) {
            this.applyDraftToExisting(existingRow, draft);
            await txRepo.save(existingRow);
            result.updated += 1;
          } else {
            await txRepo.save(
              txRepo.create({
                shipId,
                ...this.draftToCreatePayload(draft),
              }),
            );
            result.inserted += 1;
          }
        } catch (err) {
          result.errors.push({
            row: rowNum,
            sfiCode: draft.assetIdInternal,
            reason: (err as Error).message,
          });
          result.skipped += 1;
        }
      }

      // Renames — repoint metric bindings and asset_documents to the
      // new asset, then delete the old.
      for (const r of renames) {
        const newAsset = await txRepo.findOne({
          where: { shipId, assetIdInternal: r.newCode },
        });
        if (!newAsset) continue;
        await tx.getRepository(ShipMetricCatalogEntity)
          .createQueryBuilder()
          .update()
          .set({ boundAssetId: newAsset.id })
          .where('bound_asset_id = :old', { old: r.oldId })
          .execute();
        await tx.getRepository(AssetDocumentLinkEntity)
          .createQueryBuilder()
          .update()
          .set({ assetId: newAsset.id })
          .where('asset_id = :old', { old: r.oldId })
          .execute();
        await txRepo.delete({ id: r.oldId });
        mergedCount += 1;
      }

      // Orphan deletion. Skip orphans already merged via rename above.
      if (opts.deleteOrphans === true) {
        const mergedIds = new Set(renames.map((r) => r.oldId));
        const orphansToDelete = orphansBefore
          .filter((o) => !mergedIds.has(o.id))
          .map((o) => o.id);
        if (orphansToDelete.length > 0) {
          await txRepo
            .createQueryBuilder()
            .delete()
            .where('id IN (:...ids)', { ids: orphansToDelete })
            .execute();
          deletedCount = orphansToDelete.length;
        }
      }
    });

    return { ...result, snapshotId, deleted: deletedCount, merged: mergedCount };
  }

  /** Apply a parsed draft to an existing entity, preserving non-null
   * existing values when the draft is null. Extracted so the same
   * upsert logic is shared between preview-driven commit and the
   * legacy single-shot import path. */
  private applyDraftToExisting(
    existing: AssetEntity,
    draft: Partial<CreateAssetDto>,
  ): void {
    Object.assign(existing, {
      displayName: draft.displayName,
      sfiGroup: draft.sfiGroup ?? existing.sfiGroup,
      sfiGroupName: draft.sfiGroupName ?? existing.sfiGroupName,
      sfiSub: draft.sfiSub ?? existing.sfiSub,
      sfiSubName: draft.sfiSubName ?? existing.sfiSubName,
      drawingCode: draft.drawingCode ?? existing.drawingCode,
      parentAssetId: draft.parentAssetId ?? existing.parentAssetId,
      servedByAssetId: draft.servedByAssetId ?? existing.servedByAssetId,
      locationAssetId: draft.locationAssetId ?? existing.locationAssetId,
      brand: draft.brand ?? existing.brand,
      model: draft.model ?? existing.model,
      serialNo: draft.serialNo ?? existing.serialNo,
      criticality: draft.criticality ?? existing.criticality,
      commissionedDate: draft.commissionedDate ?? existing.commissionedDate,
      location: draft.location ?? existing.location,
      department: draft.department ?? existing.department,
      rinaRef: draft.rinaRef ?? existing.rinaRef,
      notes: draft.notes ?? existing.notes,
      zone: draft.zone ?? existing.zone,
      deckRole: draft.deckRole ?? existing.deckRole,
      deckLevel: draft.deckLevel ?? existing.deckLevel,
      spaceInstance: draft.spaceInstance ?? existing.spaceInstance,
      spaceLabel: draft.spaceLabel ?? existing.spaceLabel,
      drawingRef: draft.drawingRef ?? existing.drawingRef,
      inspectionObligation:
        draft.inspectionObligation ?? existing.inspectionObligation,
      parentAutoPopulated:
        draft.parentAutoPopulated ?? existing.parentAutoPopulated,
      criticalityAutoPopulated:
        draft.criticalityAutoPopulated ?? existing.criticalityAutoPopulated,
      sourceSheet: draft.sourceSheet ?? existing.sourceSheet,
      extras: draft.extras
        ? { ...(existing.extras ?? {}), ...draft.extras }
        : existing.extras,
    });
  }

  private draftToCreatePayload(draft: Partial<CreateAssetDto>): Partial<AssetEntity> {
    return {
      assetIdInternal: draft.assetIdInternal,
      displayName: draft.displayName,
      sfiGroup: draft.sfiGroup,
      // sfi_group_name, drawing_code and department were missing here while
      // applyDraftToExisting wrote all three: a row already in the register
      // kept its values, a NEW row silently lost them. Both mappings have to
      // cover every column the sheet carries, or an import is lossy in a way
      // that only shows up on the rows nobody is watching.
      sfiGroupName: draft.sfiGroupName,
      sfiSub: draft.sfiSub,
      sfiSubName: draft.sfiSubName,
      drawingCode: draft.drawingCode,
      department: draft.department,
      parentAssetId: draft.parentAssetId,
      servedByAssetId: draft.servedByAssetId,
      locationAssetId: draft.locationAssetId,
      brand: draft.brand,
      model: draft.model,
      serialNo: draft.serialNo,
      criticality: draft.criticality,
      commissionedDate: draft.commissionedDate,
      location: draft.location,
      rinaRef: draft.rinaRef,
      notes: draft.notes,
      zone: draft.zone,
      deckRole: draft.deckRole,
      deckLevel: draft.deckLevel,
      spaceInstance: draft.spaceInstance,
      spaceLabel: draft.spaceLabel,
      drawingRef: draft.drawingRef,
      inspectionObligation: draft.inspectionObligation,
      parentAutoPopulated: draft.parentAutoPopulated,
      criticalityAutoPopulated: draft.criticalityAutoPopulated,
      sourceSheet: draft.sourceSheet,
      extras: draft.extras,
    };
  }

  /**
   * Legacy single-shot import — preserved for backward compat with the
   * existing controller route. Behaves like a commit with all flags
   * defaulted (snapshot=true, deleteOrphans=false, mergeRenames=false).
   */
  async importFromXlsx(
    shipId: string,
    buffer: Buffer,
  ): Promise<ImportResultDto> {
    const out = await this.commitImportFromXlsx(
      shipId,
      buffer,
      { snapshotBefore: true },
      null,
    );
    return {
      totalRows: out.totalRows,
      inserted: out.inserted,
      updated: out.updated,
      skipped: out.skipped,
      errors: out.errors,
    };
  }

  private async assertShipExists(shipId: string): Promise<void> {
    const exists = await this.shipRepository.exists({ where: { id: shipId } });
    if (!exists) {
      throw new NotFoundException(`Ship ${shipId} not found`);
    }
  }
}
