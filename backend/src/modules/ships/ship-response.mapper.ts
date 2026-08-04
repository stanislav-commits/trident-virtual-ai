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
  beamM: number | null;
  depthM: number | null;
  grossTonnage: number | null;
  netTonnage: number | null;
  shipyard: string | null;
  classSociety: string | null;
  publicationFlag: string | null;
  publicationClass: string | null;
  homePort: string | null;
  fleetManagerEmail: string | null;
  operationType: string | null;
  metricAnalysisHint: string | null;
  // Vessel master data — auto-populated into compliance records.
  officialNumber: string | null;
  portOfRegistry: string | null;
  registeredOwner: string | null;
  companyName: string | null;
  companyImoNumber: string | null;
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
    beamM: ship.beamM != null ? Number(ship.beamM) : null,
    depthM: ship.depthM != null ? Number(ship.depthM) : null,
    grossTonnage: ship.grossTonnage,
    netTonnage: ship.netTonnage,
    shipyard: ship.shipyard,
    classSociety: ship.classSociety,
    publicationFlag: ship.publicationFlag,
    publicationClass: ship.publicationClass,
    homePort: ship.homePort,
    fleetManagerEmail: ship.fleetManagerEmail,
    operationType: ship.operationType,
    metricAnalysisHint: ship.metricAnalysisHint,
    officialNumber: ship.officialNumber,
    portOfRegistry: ship.portOfRegistry,
    registeredOwner: ship.registeredOwner,
    companyName: ship.companyName,
    companyImoNumber: ship.companyImoNumber,
    createdAt: ship.createdAt.toISOString(),
    updatedAt: ship.updatedAt.toISOString(),
  };
}
