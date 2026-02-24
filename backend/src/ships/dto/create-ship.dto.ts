export class CreateShipDto {
  name: string;
  serialNumber?: string;
  metricKeys: string[];
  userIds?: string[];
}
