export function isMaintenanceRecordIntent(value: string): boolean {
  const normalized = normalizeIntentText(value);

  if (!normalized || hasExplicitNonRecordDocumentIntent(normalized)) {
    return false;
  }

  return (
    hasMaintenanceRecordSignal(normalized) ||
    hasMaintenanceAssignmentSignal(normalized) ||
    hasHistoricalMaintenanceEventSignal(normalized)
  );
}

export function isAdministrativeComplianceIntent(value: string): boolean {
  const normalized = normalizeIntentText(value);

  if (!normalized || hasManualInstructionSignal(normalized)) {
    return false;
  }

  return (
    hasAdministrativeComplianceSignal(normalized) &&
    !hasExplicitMaintenanceRecordOverride(normalized)
  );
}

export function isManualInstructionIntent(value: string): boolean {
  const normalized = normalizeIntentText(value);

  if (!normalized) {
    return false;
  }

  return hasManualInstructionSignal(normalized);
}

function hasExplicitNonRecordDocumentIntent(value: string): boolean {
  return (
    hasManualInstructionSignal(value) ||
    (hasAdministrativeComplianceSignal(value) &&
      !hasExplicitMaintenanceRecordOverride(value))
  );
}

function hasAdministrativeComplianceSignal(value: string): boolean {
  // NOTE: sop / checklist / emergency procedure used to be in this list, but
  // they are PROCEDURE signals — with the SMS knowledge base they overrode
  // step_by_step_procedure asks ("emergency, which forms do I fill in?") to
  // COMPLIANCE_OR_CERTIFICATE, whose stricter evidence assessment killed the
  // procedure chunks → silent web fallback. Certificate STATUS questions now
  // route to the dedicated `compliance` responder anyway.
  return /\b(?:certificate|certificates|certification|approval|issuer|validity|valid until|valid|expires?|expiry|expiration|registration|permit|compliance|regulation|regulatory|survey|marpol|solas|class approval)\b/u.test(
    value,
  );
}

function hasExplicitMaintenanceRecordOverride(value: string): boolean {
  return (
    /\bpms\b/u.test(value) ||
    /\bmaintenance (?:records?|history|tasks?|jobs?|work orders?)\b/u.test(
      value,
    ) ||
    (/\b(?:tasks?|jobs?|work orders?)\b/u.test(value) &&
      /\b(?:maintenance|service|inspection|test|overhaul)\b/u.test(value)) ||
    (/\b(?:work scope|scope of work|responsible|responsibility|performed by|approved by|engineer(?:s|'s)? notes?)\b/u.test(
      value,
    ) &&
      hasMaintenanceRecordContext(value))
  );
}

function hasManualInstructionSignal(value: string): boolean {
  return (
    /\b(?:manual|manufacturer|maker|oem)\b/u.test(value) ||
    /\b(?:how to|how do i|step by step|instructions?|procedure for|according to the manual|manual says|manual state|operation instructions?|technical specifications?|troubleshoot(?:ing)?|fault finding)\b/u.test(
      value,
    ) ||
    (/\b(?:replace|replacement|remove|removal|install|installation|repair|service|clean|adjust|inspect|operate|perform)\b/u.test(
      value,
    ) &&
      /\b(?:how|instruction|procedure|manufacturer|manual|step)\b/u.test(value))
  );
}

function hasMaintenanceRecordSignal(value: string): boolean {
  return (
    /\bpms\b/u.test(value) ||
    /\bmaintenance records?\b/u.test(value) ||
    /\bmaintenance history\b/u.test(value) ||
    /\bplanned maintenance\b/u.test(value) ||
    /\bcompleted maintenance\b/u.test(value) ||
    hasTemporalMaintenanceRecordSignal(value) ||
    /\bcurrent (?:equipment )?(?:hours?|running hours?)\b/u.test(value) ||
    /\b(?:task|job|work order|service) (?:status|reference|ref(?:erence)? id)\b/u.test(
      value,
    ) ||
    (/\bstatus\b/u.test(value) &&
      /\b(?:maintenance|service|task|work order|pms)\b/u.test(value))
  );
}

function hasTemporalMaintenanceRecordSignal(value: string): boolean {
  return (
    /\b(?:when|next|scheduled|planned|upcoming|due|overdue)\b/u.test(value) &&
    hasMaintenanceRecordContext(value)
  );
}

function hasMaintenanceRecordContext(value: string): boolean {
  return /\b(?:maintenance|pms|tasks?|jobs?|work orders?|service|tests?|inspections?|checks?|overhauls?|work scope|scope of work|responsible|responsibility|performed by|approved by|breakdowns?|corrective(?: events?)?|engineer(?:s|'s)? notes?|current equipment hours|running hours?)\b/u.test(
    value,
  );
}

function hasMaintenanceAssignmentSignal(value: string): boolean {
  const hasAssignment =
    /\b(?:responsible|responsibility|assigned|performed by|approved by|work scope|scope of work)\b/u.test(
      value,
    );
  const hasTaskContext =
    /\b(?:maintenance|service|task|work order|pms|storage|inspection|test|record|job)\b/u.test(
      value,
    );

  return hasAssignment && hasTaskContext;
}

function hasHistoricalMaintenanceEventSignal(value: string): boolean {
  const hasHistorySignal =
    /\b(?:what happened|what was done|logged|recorded|history|historical|breakdown|corrective|failure|event|engineer(?:s|'s)? notes?|performed|approved)\b/u.test(
      value,
    );
  const hasMaintenanceContext =
    /\b(?:maintenance|service|repair|breakdown|corrective|failure|inspection|test|event|notes?)\b/u.test(
      value,
    );

  return hasHistorySignal && hasMaintenanceContext;
}

function normalizeIntentText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}.']+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
