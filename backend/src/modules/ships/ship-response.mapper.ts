import { ShipEntity } from './entities/ship.entity';

export interface ShipResponseDto {
  id: string;
  name: string;
  organizationName: string | null;
  imoNumber: string | null;
  buildYear: number | null;
  mmsi: string | null;
  callSign: string | null;
  flag: string | null;
  lengthM: number | null;
  grossTonnage: number | null;
  shipyard: string | null;
  classSociety: string | null;
  homePort: string | null;
  fleetManagerEmail: string | null;
  operationType: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toShipResponse(ship: ShipEntity): ShipResponseDto {
  return {
    id: ship.id,
    name: ship.name,
    organizationName: ship.organizationName,
    imoNumber: ship.imoNumber,
    buildYear: ship.buildYear,
    mmsi: ship.mmsi,
    callSign: ship.callSign,
    flag: ship.flag,
    lengthM: ship.lengthM != null ? Number(ship.lengthM) : null,
    grossTonnage: ship.grossTonnage,
    shipyard: ship.shipyard,
    classSociety: ship.classSociety,
    homePort: ship.homePort,
    fleetManagerEmail: ship.fleetManagerEmail,
    operationType: ship.operationType,
    createdAt: ship.createdAt.toISOString(),
    updatedAt: ship.updatedAt.toISOString(),
  };
}
