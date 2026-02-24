/** key: unique metric key (e.g. speed_knots); label: display name; description: what the metric means */
export class CreateMetricDefinitionDto {
  key: string;
  label: string;
  description?: string;
  unit?: string;
  dataType?: string;
}
