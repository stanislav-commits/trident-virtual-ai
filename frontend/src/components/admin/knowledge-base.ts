export const KNOWLEDGE_BASE_CATEGORY_VALUES = [
  "MANUALS",
  "HISTORY_PROCEDURES",
  "CERTIFICATES",
  "REGULATION",
] as const;

export type KnowledgeBaseCategory = (typeof KNOWLEDGE_BASE_CATEGORY_VALUES)[number];

export type KnowledgeBaseCategoryConfig = {
  id: KnowledgeBaseCategory;
  label: string;
  folderLabel: string;
  uploadHeading: string;
  description: string;
  acceptedExtensionsLabel: string;
  accept: string;
  emptyState: string;
  rowLabel: string;
};

export const KNOWLEDGE_BASE_CATEGORIES: KnowledgeBaseCategoryConfig[] = [
  {
    id: "MANUALS",
    label: "Manuals",
    folderLabel: "Manuals",
    uploadHeading: "Upload manuals",
    description:
      "Best for technical manuals and handbooks. This category keeps the current tuned RAG parsing flow for manual documents.",
    acceptedExtensionsLabel: "PDF, DOC, DOCX, TXT, MD, CSV, JPG, JPEG, PNG, WEBP",
    accept: ".pdf,.doc,.docx,.txt,.md,.csv,.jpg,.jpeg,.png,.webp",
    emptyState: "No manuals uploaded for this ship yet.",
    rowLabel: "manuals",
  },
  {
    id: "HISTORY_PROCEDURES",
    label: "History Procedures",
    folderLabel: "History Procedures",
    uploadHeading: "Upload history procedures",
    description:
      "Use for history and procedure files. Table files are sent through table parsing, while text and PDF files keep the document flow already used in RAGFlow.",
    acceptedExtensionsLabel: "PDF, CSV, MD, XLSX, TXT",
    accept: ".pdf,.csv,.md,.xlsx,.txt",
    emptyState: "No history procedures uploaded for this ship yet.",
    rowLabel: "history procedure files",
  },
  {
    id: "CERTIFICATES",
    label: "Certificates",
    folderLabel: "Certificates",
    uploadHeading: "Upload certificates",
    description:
      "Use for certificates and scanned compliance documents. PDF and image files are indexed together with the rest of the ship knowledge base.",
    acceptedExtensionsLabel: "PDF, JPG, JPEG, PNG, WEBP",
    accept: ".pdf,.jpg,.jpeg,.png,.webp",
    emptyState: "No certificates uploaded for this ship yet.",
    rowLabel: "certificates",
  },
  {
    id: "REGULATION",
    label: "Regulation",
    folderLabel: "Regulation",
    uploadHeading: "Upload regulation files",
    description:
      "Use for regulation and policy documents that should stay searchable alongside manuals and procedures.",
    acceptedExtensionsLabel: "PDF, DOC, DOCX, TXT, MD",
    accept: ".pdf,.doc,.docx,.txt,.md",
    emptyState: "No regulation files uploaded for this ship yet.",
    rowLabel: "regulation files",
  },
];

export const DEFAULT_KNOWLEDGE_BASE_CATEGORY: KnowledgeBaseCategory = "MANUALS";

export function getKnowledgeBaseCategoryConfig(
  category: KnowledgeBaseCategory,
): KnowledgeBaseCategoryConfig {
  return (
    KNOWLEDGE_BASE_CATEGORIES.find((item) => item.id === category) ??
    KNOWLEDGE_BASE_CATEGORIES[0]
  );
}
