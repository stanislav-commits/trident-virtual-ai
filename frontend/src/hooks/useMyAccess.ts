import { useEffect, useState } from "react";
import { getMyAccess, type MyAccess } from "../api/accessControlApi";
import { useAuth } from "../context/AuthContext";

/**
 * The logged-in user's own effective access (RBAC). `null` while loading or on
 * error → callers should treat null as "unrestricted" (see `canRead`), so a
 * transient failure never hides a surface from an admin.
 */
export function useMyAccess(): MyAccess | null {
  const { token } = useAuth();
  const [access, setAccess] = useState<MyAccess | null>(null);

  useEffect(() => {
    if (!token) {
      setAccess(null);
      return;
    }
    let cancelled = false;
    getMyAccess(token)
      .then((a) => {
        if (!cancelled) setAccess(a);
      })
      .catch(() => {
        if (!cancelled) setAccess(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return access;
}
