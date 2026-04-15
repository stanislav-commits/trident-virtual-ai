import { Injectable } from '@nestjs/common';
import { ChatNormalizedQuery } from './chat.types';

export type ChatQueryIntent =
  | 'telemetry_list'
  | 'telemetry_status'
  | 'telemetry_history'
  | 'manual_specification'
  | 'maintenance_due_now'
  | 'next_due_calculation'
  | 'last_maintenance'
  | 'parts_fluids_consumables'
  | 'maintenance_procedure'
  | 'troubleshooting'
  | 'certificate_status'
  | 'regulation_compliance'
  | 'analytics_forecast'
  | 'fragment_reference'
  | 'general';

export type ChatSourceCategory =
  | 'MANUALS'
  | 'HISTORY_PROCEDURES'
  | 'CERTIFICATES'
  | 'REGULATION'
  | 'TELEMETRY';

export type ChatDocumentSourceCategory = Exclude<
  ChatSourceCategory,
  'TELEMETRY'
>;

export interface ChatQueryPlan {
  primaryIntent: ChatQueryIntent;
  secondaryIntents: ChatQueryIntent[];
  sourcePriorities: ChatSourceCategory[];
  hardDocumentCategories?: ChatDocumentSourceCategory[];
  requiresCurrentDateTime: boolean;
  requiresTelemetry: boolean;
  requiresTelemetryHistory: boolean;
  allowsMaintenanceCalculation: boolean;
  prefersExactDocumentRows: boolean;
  supportsMultiSourceAggregation: boolean;
}

@Injectable()
export class ChatQueryPlannerService {
  planQuery(
    query: string | ChatNormalizedQuery,
    resolvedSubjectQuery?: string,
  ): ChatQueryPlan {
    const normalizedQuery = typeof query === 'string' ? undefined : query;
    const effectiveQuery =
      typeof query === 'string' ? query : query.effectiveQuery;
    const primaryIntent = this.classifyPrimaryIntent(query, resolvedSubjectQuery);
    const subjectContext = [
      effectiveQuery,
      resolvedSubjectQuery ?? '',
      normalizedQuery?.subject ?? '',
      normalizedQuery?.asset ?? '',
    ]
      .filter(Boolean)
      .join('\n');
    const secondaryIntents = this.detectSecondaryIntents(
      primaryIntent,
      effectiveQuery,
      subjectContext,
    );

    return {
      primaryIntent,
      secondaryIntents,
      sourcePriorities: this.buildSourcePriorities(primaryIntent, secondaryIntents),
      hardDocumentCategories: this.buildHardDocumentCategories(
        primaryIntent,
        secondaryIntents,
        subjectContext,
      ),
      requiresCurrentDateTime: this.requiresCurrentDateTime(
        primaryIntent,
        secondaryIntents,
        subjectContext,
      ),
      requiresTelemetry: this.requiresTelemetry(primaryIntent, secondaryIntents),
      requiresTelemetryHistory: this.requiresTelemetryHistory(
        primaryIntent,
        secondaryIntents,
        subjectContext,
        normalizedQuery,
      ),
      allowsMaintenanceCalculation: primaryIntent === 'next_due_calculation',
      prefersExactDocumentRows: this.prefersExactDocumentRows(
        primaryIntent,
        subjectContext,
      ),
      supportsMultiSourceAggregation: this.supportsMultiSourceAggregation(
        primaryIntent,
        secondaryIntents,
        subjectContext,
      ),
    };
  }

  classifyPrimaryIntent(
    query: string | ChatNormalizedQuery,
    resolvedSubjectQuery?: string,
  ): ChatQueryIntent {
    const normalizedQuery = typeof query === 'string' ? undefined : query;
    const normalized =
      typeof query === 'string' ? query.trim() : query.effectiveQuery.trim();
    const lowered = normalized.toLowerCase();

    if (
      normalizedQuery &&
      this.isHistoricalTelemetryIntentFromNormalized(
        normalizedQuery,
        resolvedSubjectQuery,
      )
    ) {
      return 'telemetry_history';
    }

    if (this.isMaintenanceCalculationQuery(lowered)) {
      return 'next_due_calculation';
    }

    if (this.isLastMaintenanceQuery(lowered)) {
      return 'last_maintenance';
    }

    if (this.isTelemetryHistoryQuery(normalized)) {
      return 'telemetry_history';
    }

    if (this.isAnalyticsForecastQuery(lowered)) {
      return 'analytics_forecast';
    }

    if (this.isCertificateQuery(lowered)) {
      return 'certificate_status';
    }

    if (this.isRegulationQuery(lowered)) {
      return 'regulation_compliance';
    }

    if (this.isTelemetryListQuery(lowered)) {
      return 'telemetry_list';
    }

    if (this.isCurrentInventoryTelemetryQuery(normalized)) {
      return 'telemetry_status';
    }

    if (
      normalizedQuery &&
      this.isLiveTelemetryIntentFromNormalized(
        normalizedQuery,
        resolvedSubjectQuery,
      )
    ) {
      return 'telemetry_status';
    }

    if (this.isManualSpecificationQuery(normalized)) {
      return 'manual_specification';
    }

    if (this.isMaintenanceProcedureQuery(lowered)) {
      return 'maintenance_procedure';
    }

    if (this.isPartsQuery(lowered)) {
      return 'parts_fluids_consumables';
    }

    if (this.isLiveTelemetryStatusQuery(normalized)) {
      return 'telemetry_status';
    }

    if (this.isTroubleshootingQuery(lowered)) {
      return 'troubleshooting';
    }

    if (this.isMaintenanceDueNowQuery(lowered)) {
      return 'maintenance_due_now';
    }

    if (this.isTelemetryValueQuery(normalized)) {
      return 'telemetry_status';
    }

    if (this.isFragmentReferenceQuery(normalized)) {
      return 'fragment_reference';
    }

    return 'general';
  }

  private detectSecondaryIntents(
    primaryIntent: ChatQueryIntent,
    query: string,
    subjectContext: string,
  ): ChatQueryIntent[] {
    const intents = new Set<ChatQueryIntent>();
    const lowered = query.toLowerCase();

    if (
      primaryIntent !== 'regulation_compliance' &&
      this.isRegulationQuery(subjectContext.toLowerCase())
    ) {
      intents.add('regulation_compliance');
    }

    if (
      primaryIntent !== 'certificate_status' &&
      this.isCertificateQuery(subjectContext.toLowerCase())
    ) {
      intents.add('certificate_status');
    }

    if (
      primaryIntent !== 'maintenance_procedure' &&
      this.isMaintenanceProcedureQuery(lowered)
    ) {
      intents.add('maintenance_procedure');
    }

    if (
      primaryIntent !== 'parts_fluids_consumables' &&
      this.isPartsQuery(lowered)
    ) {
      intents.add('parts_fluids_consumables');
    }

    if (
      primaryIntent !== 'manual_specification' &&
      this.isManualSpecificationQuery(query)
    ) {
      intents.add('manual_specification');
    }

    if (
      primaryIntent !== 'telemetry_status' &&
      this.isTelemetryValueQuery(query) &&
      /\b(current|currently|now|reading|value|temperature|pressure|level|runtime|hours?)\b/i.test(
        lowered,
      )
    ) {
      intents.add('telemetry_status');
    }

    if (
      primaryIntent !== 'analytics_forecast' &&
      this.isAnalyticsForecastQuery(lowered)
    ) {
      intents.add('analytics_forecast');
    }

    return [...intents];
  }

  private buildSourcePriorities(
    primaryIntent: ChatQueryIntent,
    secondaryIntents: ChatQueryIntent[],
  ): ChatSourceCategory[] {
    const add = (categories: ChatSourceCategory[], result: ChatSourceCategory[]) => {
      for (const category of categories) {
        if (!result.includes(category)) {
          result.push(category);
        }
      }
      return result;
    };

    const result: ChatSourceCategory[] = [];
    switch (primaryIntent) {
      case 'telemetry_list':
      case 'telemetry_status':
        add(
          ['TELEMETRY', 'MANUALS', 'HISTORY_PROCEDURES', 'CERTIFICATES', 'REGULATION'],
          result,
        );
        break;
      case 'telemetry_history':
        add(
          ['HISTORY_PROCEDURES', 'TELEMETRY', 'MANUALS', 'CERTIFICATES', 'REGULATION'],
          result,
        );
        break;
      case 'manual_specification':
        add(
          ['MANUALS', 'HISTORY_PROCEDURES', 'REGULATION', 'CERTIFICATES', 'TELEMETRY'],
          result,
        );
        break;
      case 'maintenance_due_now':
      case 'next_due_calculation':
      case 'last_maintenance':
        add(
          ['HISTORY_PROCEDURES', 'TELEMETRY', 'MANUALS', 'CERTIFICATES', 'REGULATION'],
          result,
        );
        break;
      case 'maintenance_procedure':
        add(
          ['MANUALS', 'HISTORY_PROCEDURES', 'REGULATION', 'CERTIFICATES', 'TELEMETRY'],
          result,
        );
        break;
      case 'parts_fluids_consumables':
        add(
          ['MANUALS', 'HISTORY_PROCEDURES', 'TELEMETRY', 'CERTIFICATES', 'REGULATION'],
          result,
        );
        break;
      case 'troubleshooting':
        add(
          ['MANUALS', 'TELEMETRY', 'HISTORY_PROCEDURES', 'CERTIFICATES', 'REGULATION'],
          result,
        );
        break;
      case 'certificate_status':
        add(
          ['CERTIFICATES', 'REGULATION', 'HISTORY_PROCEDURES', 'MANUALS', 'TELEMETRY'],
          result,
        );
        break;
      case 'regulation_compliance':
        add(
          ['REGULATION', 'CERTIFICATES', 'MANUALS', 'HISTORY_PROCEDURES', 'TELEMETRY'],
          result,
        );
        break;
      case 'analytics_forecast':
        add(
          ['HISTORY_PROCEDURES', 'TELEMETRY', 'MANUALS', 'CERTIFICATES', 'REGULATION'],
          result,
        );
        break;
      default:
        add(
          ['MANUALS', 'HISTORY_PROCEDURES', 'CERTIFICATES', 'REGULATION', 'TELEMETRY'],
          result,
        );
        break;
    }

    if (secondaryIntents.includes('regulation_compliance')) {
      add(['REGULATION'], result);
    }

    if (secondaryIntents.includes('certificate_status')) {
      add(['CERTIFICATES'], result);
    }

    return result;
  }

  private buildHardDocumentCategories(
    primaryIntent: ChatQueryIntent,
    secondaryIntents: ChatQueryIntent[],
    subjectContext: string,
  ): ChatDocumentSourceCategory[] | undefined {
    const explicitMultiSourceRequest =
      /\b(based on|using|together with|and also|plus|combine|both|all relevant)\b/i.test(
        subjectContext,
      );
    const result: ChatDocumentSourceCategory[] = [];
    const add = (categories: ChatDocumentSourceCategory[]) => {
      for (const category of categories) {
        if (!result.includes(category)) {
          result.push(category);
        }
      }
    };

    add(this.getHardDocumentCategoriesForIntent(primaryIntent));

    if (explicitMultiSourceRequest) {
      for (const intent of secondaryIntents) {
        add(this.getHardDocumentCategoriesForIntent(intent));
      }
    }

    return result.length > 0 ? result : undefined;
  }

  private getHardDocumentCategoriesForIntent(
    intent: ChatQueryIntent,
  ): ChatDocumentSourceCategory[] {
    switch (intent) {
      case 'manual_specification':
      case 'maintenance_procedure':
      case 'parts_fluids_consumables':
      case 'troubleshooting':
        return ['MANUALS'];
      case 'maintenance_due_now':
      case 'next_due_calculation':
      case 'last_maintenance':
      case 'analytics_forecast':
        return ['HISTORY_PROCEDURES'];
      case 'certificate_status':
        return ['CERTIFICATES'];
      case 'regulation_compliance':
        return ['REGULATION'];
      default:
        return [];
    }
  }

  private requiresCurrentDateTime(
    primaryIntent: ChatQueryIntent,
    secondaryIntents: ChatQueryIntent[],
    subjectContext: string,
  ): boolean {
    return (
      primaryIntent === 'maintenance_due_now' ||
      primaryIntent === 'next_due_calculation' ||
      primaryIntent === 'last_maintenance' ||
      primaryIntent === 'certificate_status' ||
      primaryIntent === 'analytics_forecast' ||
      primaryIntent === 'telemetry_history' ||
      secondaryIntents.includes('certificate_status') ||
      /\b(today|tonight|now|currently|this month|next month|this week|next week|remaining|left|overdue|expire|expires|expired)\b/i.test(
        subjectContext,
      )
    );
  }

  private requiresTelemetry(
    primaryIntent: ChatQueryIntent,
    secondaryIntents: ChatQueryIntent[],
  ): boolean {
    return (
      primaryIntent === 'telemetry_list' ||
      primaryIntent === 'telemetry_status' ||
      primaryIntent === 'telemetry_history' ||
      primaryIntent === 'analytics_forecast' ||
      primaryIntent === 'troubleshooting' ||
      primaryIntent === 'next_due_calculation' ||
      secondaryIntents.includes('telemetry_status')
    );
  }

  private requiresTelemetryHistory(
    primaryIntent: ChatQueryIntent,
    secondaryIntents: ChatQueryIntent[],
    subjectContext: string,
    normalizedQuery?: ChatNormalizedQuery,
  ): boolean {
    if (
      normalizedQuery &&
      this.isHistoricalTelemetryIntentFromNormalized(
        normalizedQuery,
        subjectContext,
      )
    ) {
      return true;
    }

    return (
      primaryIntent === 'telemetry_history' ||
      primaryIntent === 'analytics_forecast' ||
      secondaryIntents.includes('analytics_forecast') ||
      /\b(last\s+\d+\s+(?:days?|weeks?|months?)|over\s+the\s+last|history|historical|trend|forecast|position\s+(?:on|at))\b/i.test(
        subjectContext,
      )
    );
  }

  private isHistoricalTelemetryIntentFromNormalized(
    normalizedQuery: ChatNormalizedQuery,
    resolvedSubjectQuery?: string,
  ): boolean {
    if (
      normalizedQuery.timeIntent.kind !== 'historical_point' &&
      normalizedQuery.timeIntent.kind !== 'historical_range' &&
      normalizedQuery.timeIntent.kind !== 'historical_event'
    ) {
      return false;
    }

    if (normalizedQuery.sourceHints.includes('TELEMETRY')) {
      return true;
    }

    const searchSpace = [
      normalizedQuery.subject ?? '',
      normalizedQuery.asset ?? '',
      normalizedQuery.effectiveQuery,
      resolvedSubjectQuery ?? '',
    ].join(' ');

    return /\b(tank|fuel|oil|coolant|temperature|pressure|voltage|load|rpm|runtime|hours?|position|latitude|longitude|telemetry|metric)\b/i.test(
      searchSpace,
    );
  }

  private isLiveTelemetryIntentFromNormalized(
    normalizedQuery: ChatNormalizedQuery,
    resolvedSubjectQuery?: string,
  ): boolean {
    if (!normalizedQuery.sourceHints.includes('TELEMETRY')) {
      return false;
    }

    if (
      normalizedQuery.timeIntent.kind === 'historical_point' ||
      normalizedQuery.timeIntent.kind === 'historical_range' ||
      normalizedQuery.timeIntent.kind === 'historical_event'
    ) {
      return false;
    }

    if (normalizedQuery.operation === 'position') {
      return true;
    }

    if (normalizedQuery.timeIntent.kind === 'current') {
      return true;
    }

    const searchSpace = [
      normalizedQuery.subject ?? '',
      normalizedQuery.asset ?? '',
      normalizedQuery.effectiveQuery,
      resolvedSubjectQuery ?? '',
    ]
      .filter(Boolean)
      .join(' ');

    if (
      normalizedQuery.followUpMode !== 'standalone' &&
      this.isTelemetryValueQuery(searchSpace)
    ) {
      return true;
    }

    return /\b(operating\s+time|runtime|running\s+hours|hours?|hour\s*meter|throttle|load|speed|wind|direction|angle|location|position|coordinates?|gps|latitude|longitude|lat|lon|level|remaining|available|active|inactive|online|offline|alarm|alarms|reading|readings|value|values)\b/i.test(
      searchSpace,
    );
  }

  private prefersExactDocumentRows(
    primaryIntent: ChatQueryIntent,
    subjectContext: string,
  ): boolean {
    return (
      primaryIntent === 'maintenance_due_now' ||
      primaryIntent === 'next_due_calculation' ||
      primaryIntent === 'last_maintenance' ||
      (primaryIntent === 'maintenance_procedure' &&
        this.isIntervalMaintenanceProcedureQuery(subjectContext)) ||
      primaryIntent === 'parts_fluids_consumables' ||
      /\b1p\d{2,}\b/i.test(subjectContext)
    );
  }

  private supportsMultiSourceAggregation(
    primaryIntent: ChatQueryIntent,
    secondaryIntents: ChatQueryIntent[],
    subjectContext: string,
  ): boolean {
    return (
      primaryIntent === 'analytics_forecast' ||
      primaryIntent === 'troubleshooting' ||
      primaryIntent === 'certificate_status' ||
      primaryIntent === 'next_due_calculation' ||
      secondaryIntents.includes('regulation_compliance') ||
      /\b(based on|using|together with|and also|plus|combine|both|all relevant)\b/i.test(
        subjectContext,
      )
    );
  }

  private isMaintenanceCalculationQuery(query: string): boolean {
    return /\b(when\s+should|when\s+is\s+the\s+next|how\s+many\s+hours?\s+(?:remain|remaining|left)?\s*until|hours?\s+left|remaining\s+hours?|next\s+service\s+at\s+what\s+hour|due\s+at\s+what\s+hour|overdue\s+by)\b/i.test(
      query,
    ) ||
      /\bwhen\s+(?:is|will)\s+.+\b(?:maintenance|service|oil\s+change|filter(?:\s+change)?|inspection|overhaul|greasing|grease|calibration|cleaning)\b.+\bdue\b/i.test(
        query,
      ) ||
      /\b(?:should|do|does|is|are|what)\b[\s\S]{0,32}\b(?:perform|do|carry\s+out|schedule|plan|need|needs)\b[\s\S]{0,24}\b(?:maintenance|service)\b[\s\S]{0,24}\b(?:at|for|based\s+on|from)\b[\s\S]{0,16}\b(?:this|that|current)\b[\s\S]{0,16}\b(?:counter|reading|runtime|hour\s*meter|running\s+hours?|hours?)\b/i.test(
        query,
      ) ||
      /\b(?:maintenance|service)\b[\s\S]{0,24}\b(?:at|for|based\s+on|from)\b[\s\S]{0,16}\b(?:this|that|current)\b[\s\S]{0,16}\b(?:counter|reading|runtime|hour\s*meter|running\s+hours?|hours?)\b/i.test(
        query,
      );
  }

  private isLastMaintenanceQuery(query: string): boolean {
    return /\b(when\s+was\s+the\s+last|last\s+(?:service|maintenance|oil\s+change|inspection|survey)|when\s+did\s+we\s+last)\b/i.test(
      query,
    );
  }

  private isTelemetryHistoryQuery(query: string): boolean {
    return /\b(position\s+on|position\s+at|where\s+was\s+the\s+(?:yacht|vessel|ship)|what\s+was\s+the\s+(?:yacht|vessel|ship)\s+position)\b/i.test(
      query,
    );
  }

  private isAnalyticsForecastQuery(query: string): boolean {
    if (
      /\b(forecast|budget|order\s+for\s+(?:next|coming|upcoming)\s+month|(?:next|coming|upcoming)\s+month|(?:next|coming|upcoming)\s+week)\b/i.test(
        query,
      )
    ) {
      return true;
    }

    if (/\bhow\s+much\b[\s\S]{0,80}\bneed\b/i.test(query)) {
      return true;
    }

    if (
      /\b(consumption|usage|trend|historical|history)\b/i.test(query) ||
      /\bover\s+the\s+last\s+\d+\b/i.test(query) ||
      /\blast\s+\d+\s+(?:days?|weeks?|months?)\b/i.test(query)
    ) {
      return true;
    }

    return (
      /\baverage\b/i.test(query) &&
      (/\bover\s+the\s+last\b/i.test(query) ||
        /\blast\s+\d+\s+(?:days?|weeks?|months?)\b/i.test(query) ||
        /\b(historical|history|trend)\b/i.test(query))
    );
  }

  private isCertificateQuery(query: string): boolean {
    return /\b(certificates?|certifications?|survey|class\s+certificate|expires?|expiry|valid\s+until|renewal)\b/i.test(
      query,
    );
  }

  private isRegulationQuery(query: string): boolean {
    if (
      /\b(regulation|regulations|marpol|imo|solas|ism|isps|mlc|flag\s+state|obligation|obligations|compliance|prohibited|detention|fine|annex|class\s+rules?|class\s+requirements?|code|law|laws)\b/i.test(
        query,
      )
    ) {
      return true;
    }

    return (
      /\b(required|requirement|requirements|allowed|permit(?:ted)?|prohibited)\b[\s\S]{0,40}\b(marpol|imo|solas|ism|isps|mlc|flag\s+state|regulation|regulations|annex|class|rule|rules|code|law|laws)\b/i.test(
        query,
      ) ||
      /\b(?:under|according\s+to|per)\s+(?:the\s+)?(?:marpol|imo|solas|ism|isps|mlc|flag\s+state|regulation|regulations|annex|class|rules?|code|law|laws)\b/i.test(
        query,
      )
    );
  }

  private isTelemetryListQuery(query: string): boolean {
    if (
      this.isManualSpecificationQuery(query) ||
      this.isMaintenanceProcedureQuery(query) ||
      this.isPartsQuery(query)
    ) {
      return false;
    }

    const asksForInventory =
      /\b(show|display|give|return|output|write|provide|enumerate)\b/i.test(
        query,
      ) ||
      /^\s*list\b/i.test(query) ||
      /\b(?:can|could|would|will|please)\s+(?:you\s+)?list\b/i.test(query) ||
      /\blist\s+of\b/i.test(query) ||
      /\b(all|available|full|complete|entire|every|random|\d{1,2})\b/i.test(
        query,
      );
    const mentionsTelemetryInventory =
      /\b(metrics?|telemetry|readings?|values?|signals?|sensor(?:s)?)\b/i.test(
        query,
      ) ||
      (/\b(alarms?|warnings?|faults?|trips?)\b/i.test(query) &&
        asksForInventory);
    if (!mentionsTelemetryInventory) {
      return false;
    }

    return asksForInventory;
  }

  private isMaintenanceProcedureQuery(query: string): boolean {
    return (
      /\b(procedure|steps?|how\s+to|how\s+do\s+i|how\s+can\s+i|how\s+should(?:\s+i|\s+the|\s+it)?|instruction|instructions|checklist|perform|replace|clean|inspect|test|grease|carry\s+out|install|installation|mounted|mounting|wire|wiring|connect|connection|configure|configuration|setup|set\s+up|start|stop|restart|flush|create\s+(?:a\s+)?route|make\s+(?:a\s+)?route|enter\s+(?:a\s+)?route|add\s+(?:a\s+)?waypoint|what\s+should\s+i\s+do|what\s+do\s+i\s+do|what\s+needs?\s+to\s+be\s+done|what\s+does\s+.*include)\b/i.test(
        query,
      ) || this.isIntervalMaintenanceProcedureQuery(query)
    );
  }

  private isIntervalMaintenanceProcedureQuery(query: string): boolean {
    const hasIntervalSignal =
      /\b\d{2,6}(?:\s*-\s*|\s+)?(?:h(?:ours?|rs?)?|hourly|months?|month|years?|year)\b/i.test(
        query,
      ) ||
      /\b(annual|annually|monthly|weekly|daily|periodic|intervals?)\b/i.test(
        query,
      );
    if (!hasIntervalSignal) {
      return false;
    }

    return (
      /\b(service|servicing|mainten[a-z]*|inspection|checks?|tasks?|schedule|overhaul|included|due)\b/i.test(
        query,
      ) ||
      /\b(what\s+should\s+i\s+do|what\s+shoul\s+i\s+do|what\s+do\s+i\s+do|what\s+needs?\s+to\s+be\s+done|what\s+should\s+be\s+done|what\s+is\s+included|perform|carry\s+out)\b/i.test(
        query,
      )
    );
  }

  private isTroubleshootingQuery(query: string): boolean {
    if (this.isLiveTelemetryStatusQuery(query)) {
      return false;
    }

    return /\b(fault|alarm|error|troubleshoot|issue|problem|not\s+working|failure|high\s+.*temperature|low\s+.*pressure|stopped|why\s+has)\b/i.test(
      query,
    );
  }

  private isMaintenanceDueNowQuery(query: string): boolean {
    return /\b(what\s+maintenance\s+is\s+due|what\s+service\s+is\s+due|due\s+now|maintenance\s+due\s+now|service\s+due\s+now|what\s+is\s+the\s+next\s+(maintenance|service)|what\s+(maintenance|service)\s+is\s+next|overdue)\b/i.test(
      query,
    );
  }

  private isTelemetryValueQuery(query: string): boolean {
    if (this.isManualSpecificationQuery(query)) {
      return false;
    }

    if (this.isPartsQuery(query)) {
      return false;
    }

    if (this.isCurrentInventoryTelemetryQuery(query)) {
      return true;
    }

    if (/[a-z0-9]+(?:[_-][a-z0-9]+)+/i.test(query)) {
      return true;
    }

    return (
      /\b(current|currently|status|state|reading|readings|value|values|temperature|temperatures|temp|pressure|pressures|level|levels|voltage|voltages|current|currents|amperage|amperages|load|loads|rpm|speed|speeds|wind|direction|angle|flow|flows|rate|rates|running\s+hours|runtime|operating\s+time|hour\s*meter|latitude|longitude|location|position|coordinates?|gps|lat|lon)\b/i.test(
        query,
      ) ||
      (/\b(active|inactive|enabled|disabled|online|offline)\b/i.test(query) &&
        /\b(alarm|alarms|bilge|generator|genset|engine|tank|fuel|oil|coolant|battery|batteries|charger|chargers|pump|pumps|thruster|valve|door|hatch)\b/i.test(
          query,
        )) ||
      /\bwhere\s+is\s+(?:the\s+)?(?:yacht|vessel|ship|boat)\b/i.test(query) ||
      this.isConversationalCurrentNavigationQuery(query) ||
      /\b(?:actual|current|live)\s+(?:coordinates?|position|location)\b/i.test(
        query,
      )
    );
  }

  private isLiveTelemetryStatusQuery(query: string): boolean {
    if (!this.isTelemetryValueQuery(query)) {
      return false;
    }

    if (this.isConversationalCurrentNavigationQuery(query)) {
      return true;
    }

    if (/^\s*(why|how)\b/i.test(query)) {
      return this.isCurrentInventoryTelemetryQuery(query);
    }

    return /\b(current|currently|now|right now|live|actual|status|state|active|inactive|enabled|disabled|online|offline|reading|readings|value|values)\b/i.test(
      query,
    ) || this.isCurrentInventoryTelemetryQuery(query);
  }

  private isConversationalCurrentNavigationQuery(query: string): boolean {
    const normalized = query.toLowerCase();
    const asksWhereWeAre =
      /\bwhere\s+(?:are|r)\s+(?:we|i)\b/i.test(normalized) ||
      /\bwhere\s+am\s+i\b/i.test(normalized) ||
      /\bwhere\s+is\s+(?:the\s+)?(?:yacht|vessel|ship|boat)\b/i.test(
        normalized,
      ) ||
      /\bwhere\s+is\s+[\w\s'-]{2,80}?\b(?:now|right\s+now|currently)\b/i.test(
        normalized,
      );
    const asksOwnSpeed =
      /\bhow\s+fast\s+(?:are\s+)?(?:we|i|the\s+(?:yacht|vessel|ship|boat))\b/i.test(
        normalized,
      ) ||
      /\bhow\s+fast\s+(?:is|are)\s+[\w\s'-]{2,80}?\b(?:moving|going|travelling|traveling|sailing|underway)\b/i.test(
        normalized,
      ) ||
      /\b(?:yacht|vessel|ship|boat)\s+speed\b/i.test(normalized) ||
      /\bspeed\s+over\s+ground\b/i.test(normalized) ||
      /\b(?:sog|stw|knots?)\b/i.test(normalized);
    const hasNavigationSubject =
      /\b(?:we|i|yacht|vessel|ship|boat|navigation|gps|position|location)\b/i.test(
        normalized,
      ) || asksWhereWeAre;

    return asksWhereWeAre || (asksOwnSpeed && hasNavigationSubject);
  }

  private isCurrentInventoryTelemetryQuery(query: string): boolean {
    const normalized = query.toLowerCase();
    if (
      /\b(next\s+month|next\s+week|forecast|budget|trend|historical|history|over\s+the\s+last|last\s+\d+\s+(?:days?|weeks?|months?)|need\s+to\s+order|order)\b/i.test(
        normalized,
      )
    ) {
      return false;
    }

    return (
      /\b(onboard|on\s+board|in\s+(?:the\s+)?tanks?|tank\s+levels?|all\s+(?:fuel|oil|water|coolant|def)\s+tanks|remaining|available)\b/i.test(
        normalized,
      ) ||
      (/\b(fuel|oil|water|coolant|def|urea)\b/i.test(normalized) &&
        /\b(level|levels|quantity|amount|volume|contents?)\b/i.test(
          normalized,
        ) &&
        /\b(tank|tanks)\b/i.test(normalized)) ||
      (/\b(how\s+many|how\s+much|total|combined|sum)\b/i.test(normalized) &&
        /\b(fuel|oil|water|coolant|def|urea)\b/i.test(normalized))
    );
  }

  private isPartsQuery(query: string): boolean {
    if (
      /\b(parts?|spare\s*parts?|spares?|consumables?|filters?|part\s*numbers?|manufacturer\s*part|supplier\s*part|kits?|assembl(?:y|ies)|o-?rings?|seals?|gaskets?)\b/i.test(
        query,
      )
    ) {
      return true;
    }

    return (
      /\b(oil|coolant|fluid|fluids?)\b/i.test(query) &&
      /\b(quantity|quantities|capacity|capacities|grade|viscosity|type|available|onboard|how\s+much|how\s+many|need|order)\b/i.test(
        query,
      )
    );
  }

  private isManualSpecificationQuery(query: string): boolean {
    return (
      /\bwhat\s+(?:manual|does\s+the\s+manual)\s+(?:say|says)\b/i.test(query) ||
      /\b(?:according\s+to|from|inside|in)\s+(?:the\s+)?.+?\b(manual|operator'?s\s+manual|operators\s+manual|handbook|guide|document|procedure|file|pdf)\b/i.test(
        query,
      ) ||
      /\bwhat\s+does\s+the\s+.+?\b(manual|operator'?s\s+manual|handbook|guide)\b.*\b(say|specify|recommend)\b/i.test(
        query,
      ) ||
      /\b(replacement|service|inspection|change)\s+interval\b[\s\S]{0,60}\b(impeller|filter|belt|anode|cartridge|separator|element|pump)\b/i.test(
        query,
      ) ||
      /\b(normal|recommended|specified|operating)\b[\s\S]{0,40}\b(range|limit|limits|grade|viscosity|temperature|pressure|oil)\b/i.test(
        query,
      ) ||
      /\b(?:show|list|what|which)\b[\s\S]{0,40}\btanks?\b[\s\S]{0,40}\b(capacity|capacities)\b/i.test(
        query,
      ) ||
      /\b(capacity|capacities)\b[\s\S]{0,40}\btanks?\b/i.test(query) ||
      /\b(range|limit|limits|grade|viscosity|capacity|torque|spec(?:ification)?)\b[\s\S]{0,40}\b(?:manual|handbook|guide|volvo|mase)\b/i.test(
        query,
      ) ||
      /\b(?:show|list|what|which)\b[\s\S]{0,40}\b(audit|audits|compliance|inspection|inspections|checklist|checklists|survey|surveys)\b/i.test(
        query,
      )
    );
  }

  private isFragmentReferenceQuery(query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed || trimmed.includes('?')) return false;
    if (/\b(?:reference\s*id\s*)?1p\d{2,}\b/i.test(trimmed)) return false;
    const words = trimmed.split(/\s+/).filter(Boolean);
    return words.length <= 4 && !/\b(current|when|what|how|where|why)\b/i.test(trimmed);
  }
}
