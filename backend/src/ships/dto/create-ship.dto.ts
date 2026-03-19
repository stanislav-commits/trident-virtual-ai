export class CreateShipDto {
  name: string;
  organizationName: string;
  imoNumber?: string | null;
  flag?: string | null;
  deadweight?: number | string | null;
  grossTonnage?: number | string | null;
  buildYard?: string | null;
  shipClass?: string | null;
  metricKeys?: string[];
  userIds?: string[];
}
