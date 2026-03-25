export class UpdateShipDto {
  name?: string;
  organizationName?: string;
  imoNumber?: string | null;
  flag?: string | null;
  buildYear?: number | string | null;
  lengthOverall?: number | string | null;
  beam?: number | string | null;
  deadweight?: number | string | null;
  grossTonnage?: number | string | null;
  buildYard?: string | null;
  shipClass?: string | null;
  metricKeys?: string[];
  userIds?: string[];
}
