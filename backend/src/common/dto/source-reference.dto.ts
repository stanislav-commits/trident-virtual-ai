export class SourceReferenceDto {
  source!: string;
  title!: string;
  uri?: string;
  snippet?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}
