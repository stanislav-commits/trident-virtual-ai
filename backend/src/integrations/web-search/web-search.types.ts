import { SourceReferenceDto } from '../../common/dto/source-reference.dto';

export interface WebSearchQueryInput {
  question: string;
  locale?: string;
  /**
   * Per-call vessel context, passed by the caller. Should be a 1-3 sentence
   * summary that identifies the vessel and the equipment that frames the
   * question — e.g. "M/Y Sea Wolf X, 50m hybrid motor yacht. Propulsion:
   * Lucchi electric motors via Siemens BlueDrive. Aux gensets: MASE VS350V."
   * Web-search will paste this into its system prompt so results stay
   * scoped to the actual vessel and refuse off-topic sources.
   * When omitted, the prompt uses a generic placeholder.
   */
  vesselContext?: string;
}

export interface WebSearchContextReference {
  id: string;
  sourceTitle?: string;
  sourceUrl?: string;
  snippet?: string;
}

export interface WebSearchResult {
  answer: string;
  references: SourceReferenceDto[];
  contextReferences: WebSearchContextReference[];
  provider: string;
  model: string;
}
