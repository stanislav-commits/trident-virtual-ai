/** A readable string for any thrown value — the message for Errors, else String(). */
export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
