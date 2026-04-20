export interface ChatTurnDecompositionAsk {
  question: string;
}

export interface ChatTurnDecomposition {
  asks: ChatTurnDecompositionAsk[];
  responseLanguage: string | null;
  reasoning: string;
}
