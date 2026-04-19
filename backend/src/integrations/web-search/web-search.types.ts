import { SourceReferenceDto } from '../../common/dto/source-reference.dto';

export interface WebSearchQueryInput {
  question: string;
  locale?: string;
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
