export interface ImportRowError {
  row: number;            // 1-based row number in the xlsx
  sfiCode?: string;
  reason: string;
}

export interface ImportResultDto {
  totalRows: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: ImportRowError[];
}
