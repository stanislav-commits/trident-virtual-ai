export interface ShipTelemetryEntry {
  key: string;
  label: string;
  description?: string | null;
  unit?: string | null;
  bucket?: string | null;
  measurement?: string | null;
  field?: string | null;
  dataType?: string | null;
  value: string | number | boolean | null;
  updatedAt?: Date | null;
}

export interface ShipTelemetryContext {
  telemetry: Record<string, string | number | boolean | null>;
  totalActiveMetrics: number;
  matchedMetrics: number;
  prefiltered: boolean;
  matchMode: 'none' | 'sample' | 'exact' | 'direct' | 'related';
  clarification: {
    question: string;
    pendingQuery: string;
    actions: Array<{
      label: string;
      message: string;
      kind?: 'suggestion' | 'all';
    }>;
  } | null;
}

export interface TelemetryListRequest {
  mode: 'sample' | 'full';
  limit?: number;
}

export interface NavigationMotionTelemetryIntent {
  wantsLocation: boolean;
  wantsSpeed: boolean;
  wantsHeading: boolean;
  wantsWind: boolean;
  preferredSpeedKind?: 'sog' | 'stw' | 'vmg';
}

export interface TelemetryQueryComponent {
  raw: string;
  normalized: string;
  subjectPhrase: string;
  commonSubjectPhrase: string;
  entityPhrase: string;
  measurementPhrase: string;
  measurementAnchorPhrase: string;
  hasMeasurementPhrase: boolean;
  hasMeaningfulSubject: boolean;
  queryKinds: Set<string>;
  tokenCount: number;
}

export interface StoredFluidSubject {
  fluid: 'fuel' | 'oil' | 'water' | 'coolant' | 'def';
  waterQualifiers?: Array<'fresh' | 'sea' | 'black' | 'grey' | 'bilge'>;
}
