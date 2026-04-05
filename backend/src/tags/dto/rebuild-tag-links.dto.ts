export class RebuildTagLinksDto {
  scope?: 'all' | 'metrics' | 'manuals';
  shipId?: string;
  replaceExisting?: boolean;
}
