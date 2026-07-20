import { DocumentDocClass } from '../../enums/document-doc-class.enum';
import { DocumentRetrievalQuestionType } from '../../enums/document-retrieval-question-type.enum';

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
  // NOTE on PUBLICATION vs legacy REGULATION: the Knowledge Base redesign
  // renamed rules/regs to the `publication` class (fleet-wide, platform scope),
  // and `procedure` is now a first-class SMS/SOP class. Legacy `regulation`
  // docs still exist until the prod data migration (regulation → publication),
  // so both are listed during the transition — retrieval simply ignores classes
  // with no parsed docs.
  [DocumentRetrievalQuestionType.STEP_BY_STEP_PROCEDURE]: {
    primary: [
      DocumentDocClass.PROCEDURE,
      // Fleet circulars carry the management company's standing instructions
      // and required actions — same authority tier as SMS procedures.
      DocumentDocClass.CIRCULAR,
      DocumentDocClass.PUBLICATION,
      DocumentDocClass.REGULATION,
    ],
    secondary: [DocumentDocClass.MANUAL],
  },
  // Certificate STATUS is answered from the live Compliance register via the
  // `compliance` chat route, not from retired certificate documents. A
  // compliance_or_certificate documents ask that still lands here looks only at
  // the regulation/publication TEXT behind the requirement.
  [DocumentRetrievalQuestionType.COMPLIANCE_OR_CERTIFICATE]: {
    primary: [DocumentDocClass.PUBLICATION, DocumentDocClass.REGULATION],
    // Circulars often announce compliance requirements (e.g. SEEMP annual
    // review, STCW training) before they land anywhere else.
    secondary: [DocumentDocClass.CIRCULAR],
  },
  // HISTORICAL_CASE intentionally has NO policy: maintenance/PMS history is
  // answered from the live Tasks register via the `pms` chat route, not from
  // retired historical_procedure documents. A historical_case documents ask
  // falls back to the router's candidate classes (minus retired ones).
  [DocumentRetrievalQuestionType.MULTI_DOCUMENT_COMPARE]: {
    primary: [
      DocumentDocClass.MANUAL,
      DocumentDocClass.PROCEDURE,
      DocumentDocClass.CIRCULAR,
      DocumentDocClass.PUBLICATION,
      DocumentDocClass.REGULATION,
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
