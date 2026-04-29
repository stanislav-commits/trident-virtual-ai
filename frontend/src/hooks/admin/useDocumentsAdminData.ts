import { useCallback, useEffect, useRef, useState } from "react";
import {
  listDocuments,
  type DocumentDocClass,
  type DocumentListPage,
  type DocumentParseStatus,
} from "../../api/documentsApi";

interface UseDocumentsAdminDataOptions {
  shipId?: string;
  docClass?: DocumentDocClass;
  parseStatus?: DocumentParseStatus;
  name?: string;
  page: number;
  pageSize: number;
  enabled: boolean;
}

export interface DocumentsAdminData {
  documentsPage: DocumentListPage | null;
  loading: boolean;
  error: string;
  setError: (nextError: string) => void;
  refreshDocuments: () => Promise<void>;
}

export function useDocumentsAdminData(
  token: string | null,
  options: UseDocumentsAdminDataOptions,
): DocumentsAdminData {
  const [documentsPage, setDocumentsPage] = useState<DocumentListPage | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const latestRequestIdRef = useRef(0);

  const refreshDocuments = useCallback(async () => {
    if (!options.enabled || !token) {
      setDocumentsPage(null);
      setLoading(false);
      setError("");
      return;
    }

    const requestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = requestId;
    setLoading(true);
    setError("");

    try {
      const nextPage = await listDocuments(token, {
        shipId: options.shipId,
        docClass: options.docClass,
        parseStatus: options.parseStatus,
        name: options.name,
        page: options.page,
        pageSize: options.pageSize,
      });

      if (latestRequestIdRef.current !== requestId) {
        return;
      }

      setDocumentsPage(nextPage);
    } catch (documentsError) {
      if (latestRequestIdRef.current === requestId) {
        setError(
          documentsError instanceof Error
            ? documentsError.message
            : "Failed to load documents",
        );
      }
    } finally {
      if (latestRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [
    options.docClass,
    options.enabled,
    options.name,
    options.page,
    options.pageSize,
    options.parseStatus,
    options.shipId,
    token,
  ]);

  useEffect(() => {
    void refreshDocuments();
  }, [refreshDocuments]);

  return {
    documentsPage,
    loading,
    error,
    setError,
    refreshDocuments,
  };
}
