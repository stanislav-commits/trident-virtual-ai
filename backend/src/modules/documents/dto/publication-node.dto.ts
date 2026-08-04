import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * The categories the import seeds. NOT a closed set — the operator names
 * their own categories on the rail, so nodeType is free text.
 */
export const PUBLICATION_NODE_TYPES = [
  'law',
  'notice_series',
  'form',
  'other',
] as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const trimOrNull = ({ value }: { value: unknown }) => {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  return value.trim() || null;
};

export class CreatePublicationNodeDto {
  /** Parent node — absent means this is a new publication root. */
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  /** Required for roots; inherited from the parent otherwise. */
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(60)
  nodeType?: string;

  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(30)
  jurisdiction?: string | null;

  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(60)
  number?: string | null;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(400)
  title!: string;

  /** Insert before this sibling instead of appending at the end. */
  @IsOptional()
  @IsUUID()
  beforeSiblingId?: string | null;
}

export class UpdatePublicationNodeDto {
  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(60)
  number?: string | null;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(400)
  title?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(60)
  nodeType?: string;
}

export class MovePublicationNodeDto {
  /** null moves the node up to be a publication root. */
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsUUID()
  beforeSiblingId?: string | null;
}

export class SetAiDocumentDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
