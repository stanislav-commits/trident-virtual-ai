import { IsIn, IsOptional } from 'class-validator';

/**
 * Form-data flags for POST /assets/import-xlsx/commit. The file goes up as a
 * multipart field alongside these.
 *
 * They are typed as STRINGS on purpose. Multipart bodies arrive as strings,
 * and the global ValidationPipe runs with `enableImplicitConversion`, which
 * casts a field declared `boolean` with plain `Boolean("false")` — i.e. true —
 * before any @Transform gets a look in. That is not theoretical: on
 * 2026-06-12 an import sent with `deleteOrphans=false` deleted 87 assets, and
 * it still reproduced on 2026-07-31 (1477 deleted, restored from snapshot).
 *
 * So the wire value stays a string all the way to the controller, which
 * converts it once, explicitly. Nothing downstream has to know how the flag
 * was spelled.
 */
export class CommitImportDto {
  @IsOptional()
  @IsIn(['true', 'false', '1', '0'])
  deleteOrphans?: string;

  @IsOptional()
  @IsIn(['true', 'false', '1', '0'])
  mergeRenames?: string;

  @IsOptional()
  @IsIn(['true', 'false', '1', '0'])
  snapshotBefore?: string;
}

/** What the import service actually works with. */
export interface CommitImportOptions {
  deleteOrphans?: boolean;
  mergeRenames?: boolean;
  snapshotBefore?: boolean;
}

/**
 * Absent stays absent: snapshotBefore defaults to taking a snapshot, so
 * "unset" and "false" must not collapse into the same value.
 */
export function toCommitImportOptions(
  dto: CommitImportDto,
): CommitImportOptions {
  const flag = (v: string | undefined): boolean | undefined =>
    v === undefined ? undefined : v === 'true' || v === '1';
  return {
    deleteOrphans: flag(dto.deleteOrphans),
    mergeRenames: flag(dto.mergeRenames),
    snapshotBefore: flag(dto.snapshotBefore),
  };
}
