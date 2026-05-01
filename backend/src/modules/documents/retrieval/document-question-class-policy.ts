import { DocumentDocClass } from '../enums/document-doc-class.enum';
import { DocumentRetrievalQuestionType } from '../enums/document-retrieval-question-type.enum';

export interface DocumentQuestionClassPolicy {
  primary: DocumentDocClass[];
  secondary: DocumentDocClass[];
}

const DOCUMENT_QUESTION_CLASS_POLICIES: Partial<
  Record<DocumentRetrievalQuestionType, DocumentQuestionClassPolicy>
> = {
  [DocumentRetrievalQuestionType.EQUIPMENT_REFERENCE]: {
    primary: [DocumentDocClass.MANUAL],
    secondary: [],
  },
  [DocumentRetrievalQuestionType.TROUBLESHOOTING]: {
    primary: [DocumentDocClass.MANUAL],
    secondary: [],
  },
  [DocumentRetrievalQuestionType.STEP_BY_STEP_PROCEDURE]: {
    primary: [DocumentDocClass.REGULATION],
    secondary: [DocumentDocClass.MANUAL],
  },
  [DocumentRetrievalQuestionType.COMPLIANCE_OR_CERTIFICATE]: {
    primary: [DocumentDocClass.CERTIFICATE],
    secondary: [DocumentDocClass.REGULATION],
  },
  [DocumentRetrievalQuestionType.HISTORICAL_CASE]: {
    primary: [DocumentDocClass.HISTORICAL_PROCEDURE],
    secondary: [],
  },
  [DocumentRetrievalQuestionType.MULTI_DOCUMENT_COMPARE]: {
    primary: [
      DocumentDocClass.MANUAL,
      DocumentDocClass.REGULATION,
      DocumentDocClass.CERTIFICATE,
      DocumentDocClass.HISTORICAL_PROCEDURE,
    ],
    secondary: [],
  },
};

export function getDocumentQuestionClassPolicy(
  questionType: DocumentRetrievalQuestionType | null,
): DocumentQuestionClassPolicy | null {
  if (!questionType) {
    return null;
  }

  const policy = DOCUMENT_QUESTION_CLASS_POLICIES[questionType];

  return policy
    ? {
        primary: [...policy.primary],
        secondary: [...policy.secondary],
      }
    : null;
}

export function getPreferredDocumentClassesForQuestionType(
  questionType: DocumentRetrievalQuestionType | null,
): DocumentDocClass[] {
  const policy = getDocumentQuestionClassPolicy(questionType);

  return policy ? mergeClasses(policy.primary, policy.secondary) : [];
}

function mergeClasses(
  primaryClasses: DocumentDocClass[],
  additionalClasses: DocumentDocClass[],
): DocumentDocClass[] {
  return Array.from(new Set([...primaryClasses, ...additionalClasses]));
}
