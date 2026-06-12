import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Form-data flags for POST /assets/import-xlsx/commit. The file goes
 * up as a multipart field alongside these. The boolean transform makes
 * "true"/"false" strings work since multipart bodies arrive as strings.
 */

const toBool = (v: unknown): boolean =>
  v === true || v === 'true' || v === '1' || v === 1;

export class CommitImportDto {
  @IsOptional() @IsBoolean() @Transform(({ value }) => toBool(value))
  deleteOrphans?: boolean;

  @IsOptional() @IsBoolean() @Transform(({ value }) => toBool(value))
  mergeRenames?: boolean;

  @IsOptional() @IsBoolean() @Transform(({ value }) => toBool(value))
  snapshotBefore?: boolean;
}
