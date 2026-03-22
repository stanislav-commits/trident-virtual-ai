export class BulkRemoveManualsDto {
  mode?: 'manualIds' | 'all';
  manualIds?: string[];
  excludeManualIds?: string[];
}
