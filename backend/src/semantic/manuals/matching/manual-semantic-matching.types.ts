import type { DocumentationSemanticCandidate } from '../../contracts/semantic.types';

export interface SearchableSemanticManual {
  id: string;
  ragflowDocumentId: string;
  filename: string;
  category: string | null;
  semanticProfile: unknown;
  tags?: Array<{
    tag: {
      key: string;
      category: string;
      subcategory: string;
      item: string;
      description: string | null;
    };
  }>;
}

export interface DistinctiveQueryAnchor {
  token: string;
  emphasized: boolean;
}

export interface ConcreteSubjectSignal {
  normalized: string;
  collapsed: string;
  tokens: string[];
  weight: number;
}

export interface SpecificSubjectPhrase {
  normalized: string;
  collapsed: string;
  tokens: string[];
}

export interface SpecificSubjectCandidateRank {
  candidate: DocumentationSemanticCandidate;
  specificityScore: number;
  explicitSourceMatched: boolean;
  vendorMatched: boolean;
  modelMatched: boolean;
  identifierMatched: boolean;
}
