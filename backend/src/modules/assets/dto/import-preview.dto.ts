/**
 * Result of the dry-run import preview. Backend computes this from the
 * xlsx buffer + current DB state. UI shows numbers + sample lists, lets
 * admin tick what to apply, then re-submits the same file to /commit.
 */

export interface ImportPreviewCreate {
  assetIdInternal: string;
  displayName: string;
  sfiGroup: string | null;
  brand: string | null;
  model: string | null;
}

export interface ImportPreviewUpdateChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface ImportPreviewUpdate {
  assetIdInternal: string;
  displayName: string;
  changes: ImportPreviewUpdateChange[];
}

export interface ImportPreviewOrphan {
  assetIdInternal: string;
  displayName: string;
  sfiGroup: string | null;
  brand: string | null;
  model: string | null;
  boundMetricCount: number;
  linkedDocumentCount: number;
}

export interface ImportPreviewRename {
  oldAssetIdInternal: string;
  newAssetIdInternal: string;
  displayName: string;
  matchScore: 'exact-name-brand-model' | 'exact-name-brand' | 'exact-name';
}

export interface ImportPreviewResult {
  totalRows: number;
  parseErrors: Array<{ row: number; reason: string }>;
  create: ImportPreviewCreate[];
  update: ImportPreviewUpdate[];
  orphans: ImportPreviewOrphan[];
  potentialRenames: ImportPreviewRename[];
  // Numbers separately because the UI shows them in the modal header
  // before the user expands any list.
  counts: {
    create: number;
    update: number;
    orphans: number;
    renames: number;
    parseErrors: number;
  };
}
