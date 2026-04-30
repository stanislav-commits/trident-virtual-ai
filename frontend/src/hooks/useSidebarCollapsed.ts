import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "trident.chatSidebar.collapsed";

function readInitial(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState<boolean>(readInitial);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      // localStorage may be unavailable (private mode, quota); UI still works.
    }
  }, [collapsed]);

  const toggle = useCallback(() => {
    setCollapsed((value) => !value);
  }, []);

  return { collapsed, toggle, setCollapsed };
}
