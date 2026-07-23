import {
  AccessPosition,
  departmentForPosition,
  isAccessPosition,
  POSITION_LABELS,
} from './access-positions';

export interface WriteAuthResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Coarse write-authorization for the chat's write tools (create/complete
 * maintenance tasks, defects, metric watches, hours readings) — these
 * previously had NO position gating at all, just the confirmed:true prompt
 * contract. Master/Superintendent may act on any department; a department
 * position (head or crew) may only act within its OWN department; an action
 * with no department context (general tasks, watches, hours readings — no
 * reliable department signal exists for those) is open to any non-guest
 * position. Guests and unrecognized/missing positions are always denied.
 */
export function checkDepartmentWriteAccess(
  actorPosition: string | null | undefined,
  targetDepartment: string | null | undefined,
): WriteAuthResult {
  const basic = checkBasicWriteAccess(actorPosition);
  if (!basic.allowed) return basic;

  const position = actorPosition as AccessPosition;
  if (
    position === AccessPosition.MASTER ||
    position === AccessPosition.SUPERINTENDENT
  ) {
    return { allowed: true };
  }
  if (!targetDepartment) {
    return { allowed: true };
  }
  const actorDept = departmentForPosition(position);
  if (actorDept === targetDepartment) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      `this action is scoped to the ${targetDepartment} department — ` +
      `the account's position (${POSITION_LABELS[position]}) is ` +
      `${actorDept ? actorDept : 'not assigned to a department'}`,
  };
}

/**
 * Minimal write-authorization for actions with no department signal to
 * check against: any recognized, non-guest crew position.
 */
export function checkBasicWriteAccess(
  actorPosition: string | null | undefined,
): WriteAuthResult {
  if (!actorPosition || !isAccessPosition(actorPosition)) {
    return {
      allowed: false,
      reason: 'no recognized crew position is set on this account',
    };
  }
  if (actorPosition === AccessPosition.GUEST) {
    return {
      allowed: false,
      reason: 'guest accounts cannot write to operational registers',
    };
  }
  return { allowed: true };
}
