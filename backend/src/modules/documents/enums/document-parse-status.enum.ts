export enum DocumentParseStatus {
  UPLOADED = 'uploaded',
  PENDING_CONFIG = 'pending_config',
  PENDING_PARSE = 'pending_parse',
  PARSING = 'parsing',
  PARSED = 'parsed',
  FAILED = 'failed',
  REPARSE_REQUIRED = 'reparse_required',
}
