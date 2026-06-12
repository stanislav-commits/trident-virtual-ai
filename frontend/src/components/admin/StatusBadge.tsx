import type { ReactNode } from "react";

/**
 * Shared status badge used by the PMS verdicts in the asset drawer
 * (`assets-section__pms-badge--*`) and the compliance statuses
 * (`compliance__badge--*`). It renders the exact `${base} ${base}--${variant}`
 * class pair each call site used before, so existing CSS keeps applying
 * unchanged — only the markup is shared, not the styling.
 */
export function StatusBadge({
  base,
  variant,
  children,
}: {
  /** BEM block class, e.g. "compliance__badge". */
  base: string;
  /** BEM modifier suffix, e.g. "expired" → `${base}--expired`. */
  variant: string;
  children: ReactNode;
}) {
  return <span className={`${base} ${base}--${variant}`}>{children}</span>;
}
