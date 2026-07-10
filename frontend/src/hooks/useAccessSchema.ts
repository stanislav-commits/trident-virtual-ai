import { useEffect, useState } from "react";
import { getAccessSchema, type AccessSchema } from "../api/accessControlApi";
import { useAuth } from "../context/AuthContext";

// Module-level cache — the taxonomy is static, so fetch it once per session and
// share it across every admin surface (matrix, user positions, PMS departments).
let cached: AccessSchema | null = null;
let inflight: Promise<AccessSchema> | null = null;

/**
 * The single source of truth for the access taxonomy — positions (with labels +
 * department), the canonical department list, and matrix categories. All admin
 * dropdowns/grids read from this instead of hardcoding their own lists.
 */
export function useAccessSchema(): AccessSchema | null {
  const { token } = useAuth();
  const [schema, setSchema] = useState<AccessSchema | null>(cached);

  useEffect(() => {
    if (!token || cached) return;
    let cancelled = false;
    inflight ??= getAccessSchema(token);
    inflight
      .then((s) => {
        cached = s;
        if (!cancelled) setSchema(s);
      })
      .catch(() => {
        inflight = null;
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return schema;
}

export function positionLabel(schema: AccessSchema | null, value: string | null): string {
  if (!value) return "—";
  return schema?.positions.find((p) => p.value === value)?.label ?? value;
}
