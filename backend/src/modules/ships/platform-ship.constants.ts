/**
 * The platform scope (approach B for fleet-wide Publications): a single,
 * hidden ShipEntity row that OWNS all Publications and the shared RAGFlow
 * dataset they parse into. Keeping it a real ship row means every per-ship
 * code path (upload → parse → download → its own dataset) works for
 * publications with zero special-casing; only listing/retrieval need to know
 * about it. The id is fixed so it can be referenced from migrations + services
 * without a lookup. Hidden from ship lists via `isPlatform`.
 */
export const PLATFORM_SHIP_ID = '00000000-0000-4000-8000-000000000001';

export const PLATFORM_SHIP_NAME = 'Platform — Publications';
