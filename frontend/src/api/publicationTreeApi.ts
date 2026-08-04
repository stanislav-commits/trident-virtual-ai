import { fetchWithAuth } from "./core";

/** law | notice_series | form | other — the second rail level. */
export type PublicationNodeType = "law" | "notice_series" | "form" | "other";

export interface PublicationNode {
  id: string;
  parentId: string | null;
  category: string;
  nodeType: PublicationNodeType;
  jurisdiction: string | null;
  number: string | null;
  title: string;
  sortOrder: number;
  hasContent: boolean;
  documentId: string | null;
  fileName: string | null;
  isAiDocument: boolean;
  aiDocumentId: string | null;
  textQuality: number | null;
  parseState: "none" | "needed" | "parsing" | "parsed" | "failed";
  childCount: number;
  needsParsingCount: number;
}

export interface PublicationSearchHit extends PublicationNode {
  path: string[];
}

export interface PublicationRailCategory {
  category: string;
  jurisdiction: string | null;
  total: number;
  types: Array<{ nodeType: PublicationNodeType; count: number }>;
}

async function ensureOk(response: Response, what: string): Promise<void> {
  if (response.ok) return;
  const text = await response.text();
  let detail = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "message" in parsed) {
      const message = (parsed as { message: unknown }).message;
      detail = Array.isArray(message) ? message.join("; ") : String(message);
    }
  } catch {
    // not JSON — keep the raw text
  }
  throw new Error(`${what} failed: ${detail.slice(0, 200)}`);
}

async function getJson<T>(token: string, path: string, what: string): Promise<T> {
  const response = await fetchWithAuth(path, { token, method: "GET" });
  await ensureOk(response, what);
  return (await response.json()) as T;
}

async function sendJson<T>(
  token: string,
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
  what: string,
): Promise<T | null> {
  const response = await fetchWithAuth(path, {
    token,
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  await ensureOk(response, what);
  if (response.status === 204) return null;
  return (await response.json()) as T;
}

export function fetchPublicationRail(
  token: string,
): Promise<PublicationRailCategory[]> {
  return getJson(token, "documents/publications/tree/rail", "Publications rail");
}

export function fetchPublicationRoots(
  token: string,
  category: string,
  nodeType?: string,
): Promise<PublicationNode[]> {
  const query = new URLSearchParams({ category });
  if (nodeType) query.set("type", nodeType);
  return getJson(
    token,
    `documents/publications/tree/roots?${query.toString()}`,
    "Publications",
  );
}

export interface PublicationNodeContent {
  id: string;
  number: string | null;
  title: string;
  textQuality: number | null;
  parseState: string;
  hasFile: boolean;
  documentId: string | null;
  fileName: string | null;
  /** Publication › category › the branches above this row. */
  path?: string[];
  /** Where the original sits in the import library, when not uploaded yet. */
  sourceRef: string | null;
  text: string;
  truncated: boolean;
}

export function fetchPublicationNodeContent(
  token: string,
  nodeId: string,
): Promise<PublicationNodeContent> {
  return getJson(
    token,
    `documents/publications/tree/nodes/${nodeId}/content`,
    "Preview",
  );
}

export function fetchPublicationChildren(
  token: string,
  nodeId: string,
): Promise<PublicationNode[]> {
  return getJson(
    token,
    `documents/publications/tree/nodes/${nodeId}/children`,
    "Publication contents",
  );
}

export function searchPublications(
  token: string,
  query: string,
): Promise<PublicationSearchHit[]> {
  return getJson(
    token,
    `documents/publications/tree/search?q=${encodeURIComponent(query)}`,
    "Search",
  );
}

export function createPublicationNode(
  token: string,
  input: {
    parentId?: string | null;
    category?: string;
    nodeType?: string;
    jurisdiction?: string | null;
    number?: string | null;
    title: string;
    beforeSiblingId?: string | null;
  },
): Promise<PublicationNode> {
  return sendJson(
    token,
    "documents/publications/tree/nodes",
    "POST",
    input,
    "Add",
  ) as Promise<PublicationNode>;
}

export function updatePublicationNode(
  token: string,
  nodeId: string,
  input: { number?: string | null; title?: string; nodeType?: string },
): Promise<PublicationNode> {
  return sendJson(
    token,
    `documents/publications/tree/nodes/${nodeId}`,
    "PATCH",
    input,
    "Rename",
  ) as Promise<PublicationNode>;
}

export async function deletePublicationNode(
  token: string,
  nodeId: string,
): Promise<void> {
  await sendJson(
    token,
    `documents/publications/tree/nodes/${nodeId}`,
    "DELETE",
    undefined,
    "Delete",
  );
}

export function setPublicationAiDocument(
  token: string,
  nodeId: string,
  enabled: boolean,
): Promise<PublicationNode> {
  return sendJson(
    token,
    `documents/publications/tree/nodes/${nodeId}/ai-document`,
    "POST",
    { enabled },
    "AI document",
  ) as Promise<PublicationNode>;
}

export async function attachPublicationNodeFile(
  token: string,
  nodeId: string,
  file: File,
): Promise<PublicationNode> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetchWithAuth(
    `documents/publications/tree/nodes/${nodeId}/content`,
    { token, method: "POST", body: form },
  );
  await ensureOk(response, `Upload ${file.name}`);
  return (await response.json()) as PublicationNode;
}

/** Re-transcribe a scan (or every scan under a branch) with vision. */
export function parsePublicationNode(
  token: string,
  nodeId: string,
): Promise<{ queued: number; skipped: string[] }> {
  return sendJson(
    token,
    `documents/publications/tree/nodes/${nodeId}/parse`,
    "POST",
    {},
    "Parse",
  ) as Promise<{ queued: number; skipped: string[] }>;
}

/** Pull finished vision output into the nodes waiting on it. */
export function collectParsedPublications(
  token: string,
): Promise<{ collected: number }> {
  return sendJson(
    token,
    "documents/publications/tree/collect-parsed",
    "POST",
    {},
    "Collect parsed",
  ) as Promise<{ collected: number }>;
}

/** Create a publication (rail shelf), optionally with its first category. */
export function createPublicationShelf(
  token: string,
  input: { publication: string; category?: string | null; jurisdiction?: string | null },
): Promise<PublicationRailCategory[]> {
  return sendJson(
    token,
    "documents/publications/tree/shelves",
    "POST",
    input,
    "Add publication",
  ) as Promise<PublicationRailCategory[]>;
}

/**
 * Remove a category, or the whole publication when `category` is omitted.
 * `withContents` is required to take a category that still holds documents.
 */
export async function removePublicationShelf(
  token: string,
  publication: string,
  category?: string | null,
  withContents = false,
): Promise<void> {
  const query = new URLSearchParams({ publication });
  if (category) query.set("category", category);
  if (withContents) query.set("withContents", "true");
  await sendJson(
    token,
    `documents/publications/tree/shelves?${query.toString()}`,
    "DELETE",
    undefined,
    category ? "Remove category" : "Remove publication",
  );
}

/** Rename a publication, or one of its categories. */
export function renamePublicationShelf(
  token: string,
  input: { publication: string; category?: string | null; name: string },
): Promise<PublicationRailCategory[]> {
  return sendJson(
    token,
    "documents/publications/tree/shelves",
    "PATCH",
    input,
    input.category ? "Rename category" : "Rename publication",
  ) as Promise<PublicationRailCategory[]>;
}

/** How much a delete would take with it. */
export function fetchPublicationShelfContents(
  token: string,
  publication: string,
  category?: string | null,
): Promise<{ documents: number; nodes: number }> {
  const query = new URLSearchParams({ publication });
  if (category) query.set("category", category);
  return getJson(
    token,
    `documents/publications/tree/shelves/contents?${query.toString()}`,
    "Read shelf contents",
  ) as Promise<{ documents: number; nodes: number }>;
}

export type PublicationJurisdiction = {
  jurisdiction: string;
  kind: "flag" | "class" | "other";
  /** The flag's or the society's own name — what a person picks by. */
  label: string;
  publications: string[];
};

/**
 * What the library actually holds, so a vessel can only be scoped to shelves
 * that exist. Public to the admin panel; the vessel form is its only caller.
 */
export async function fetchPublicationJurisdictions(
  token: string,
): Promise<PublicationJurisdiction[]> {
  const response = await fetchWithAuth(
    "documents/publications/tree/jurisdictions",
    { token },
  );
  if (!response.ok) throw new Error("Failed to load library jurisdictions");
  return response.json();
}

export interface PublicationReviewQueue {
  total: number;
  nodes: PublicationNodeContent[];
}

/** Rows whose extracted text the quality score doubts, worst first. */
export async function fetchPublicationReviewQueue(
  token: string,
  limit = 25,
  offset = 0,
  publication?: string,
): Promise<PublicationReviewQueue> {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (publication) query.set("publication", publication);
  const response = await fetchWithAuth(
    `documents/publications/tree/review?${query.toString()}`,
    { token },
  );
  await ensureOk(response, "Review queue");
  return (await response.json()) as PublicationReviewQueue;
}

/** The text is good enough as it stands — take this row out of the queue. */
export function acceptPublicationText(
  token: string,
  nodeId: string,
): Promise<PublicationNode> {
  return sendJson(
    token,
    `documents/publications/tree/nodes/${nodeId}/accept-text`,
    "POST",
    {},
    "Accept text",
  ) as Promise<PublicationNode>;
}
