/**
 * Windy Map Forecast API — a single, page-wide instance.
 *
 * Windy's `windyInit` boots one global map app into a `#windy` container and
 * cannot be re-initialised. So we boot it once into an off-screen holder and
 * reparent that same element into whichever chat map modal is open (only one
 * at a time). This lets the vessel track be drawn directly ON Windy's weather
 * map, using the operator's Map-Forecast key (client-side, domain-locked).
 *
 * Everything is best-effort: no key, a blocked domain, or a load failure
 * rejects the promise and the caller falls back to the plain Windy embed.
 */

// Windy's API shape is loosely typed; we only touch a few members.
interface WindyStore {
  set: (key: string, value: unknown) => void;
}
export interface WindyApi {
  // Leaflet map instance (Windy ships its own Leaflet as window.L).
  map: LeafletMapLike;
  store: WindyStore;
}
interface LeafletMapLike {
  setView: (center: [number, number], zoom: number) => void;
  fitBounds: (bounds: [number, number][], opts?: unknown) => void;
  invalidateSize: () => void;
  removeLayer: (layer: unknown) => void;
}

interface WindyGlobal {
  windyInit?: (
    opts: Record<string, unknown>,
    cb: (api: WindyApi) => void,
  ) => void;
  L?: LeafletGlobalLike;
}
interface LeafletGlobalLike {
  polyline: (latlngs: [number, number][], opts?: unknown) => unknown;
  circleMarker: (latlng: [number, number], opts?: unknown) => unknown;
  layerGroup: () => LeafletLayerGroup;
}
interface LeafletLayerGroup {
  addLayer: (layer: unknown) => LeafletLayerGroup;
  addTo: (map: LeafletMapLike) => LeafletLayerGroup;
}

const LEAFLET_SRC = "https://unpkg.com/leaflet@1.4.0/dist/leaflet.js";
const WINDY_BOOT_SRC = "https://api.windy.com/assets/map-forecast/libBoot.js";

export function windyKey(): string | null {
  const k = import.meta.env.VITE_WINDY_MAP_KEY as string | undefined;
  return k && k.trim() ? k.trim() : null;
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.getAttribute("data-loaded") === "1") return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(src)));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.addEventListener("load", () => {
      s.setAttribute("data-loaded", "1");
      resolve();
    });
    s.addEventListener("error", () => reject(new Error(`failed to load ${src}`)));
    document.head.appendChild(s);
  });
}

let boot: Promise<{ api: WindyApi; el: HTMLElement; holder: HTMLElement }> | null =
  null;

export function initWindy(): Promise<{
  api: WindyApi;
  el: HTMLElement;
  holder: HTMLElement;
}> {
  if (boot) return boot;
  boot = (async () => {
    const key = windyKey();
    if (!key) throw new Error("VITE_WINDY_MAP_KEY not set");
    // Windy requires Leaflet loaded first (its own supported version).
    await injectScript(LEAFLET_SRC);
    await injectScript(WINDY_BOOT_SRC);

    const holder = document.createElement("div");
    holder.style.cssText =
      "position:fixed; left:-100000px; top:0; width:1200px; height:800px; z-index:-1;";
    const el = document.createElement("div");
    el.id = "windy";
    el.style.width = "100%";
    el.style.height = "100%";
    holder.appendChild(el);
    document.body.appendChild(holder);

    const w = window as unknown as WindyGlobal;
    if (typeof w.windyInit !== "function") {
      throw new Error("windyInit unavailable");
    }
    const api = await new Promise<WindyApi>((resolve, reject) => {
      const to = window.setTimeout(
        () => reject(new Error("windy init timed out")),
        20000,
      );
      w.windyInit!(
        { key, verbose: false, lat: 43, lon: 16, zoom: 6 },
        (a: WindyApi) => {
          window.clearTimeout(to);
          resolve(a);
        },
      );
    });
    return { api, el, holder };
  })().catch((e) => {
    boot = null; // allow a later retry
    throw e;
  });
  return boot;
}

/** Draw (replacing any previous) the vessel track + current marker on the
 *  Windy map and set the weather overlay. Returns the layer group so the
 *  caller can remove it when the modal closes. */
export function drawTrackOnWindy(
  api: WindyApi,
  track: Array<[number, number]>,
  overlay: string,
): LeafletLayerGroup | null {
  const L = (window as unknown as WindyGlobal).L;
  if (!L || track.length === 0) return null;
  const group = L.layerGroup();
  group.addLayer(
    L.polyline(track, { color: "#2f81f7", weight: 3, opacity: 0.95 }),
  );
  group.addLayer(
    L.circleMarker(track[track.length - 1], {
      radius: 7,
      color: "#ffffff",
      fillColor: "#2f81f7",
      fillOpacity: 1,
      weight: 2,
    }),
  );
  group.addTo(api.map);
  try {
    api.store.set("overlay", overlay);
  } catch {
    // overlay name not recognised — leave Windy's default.
  }
  api.map.fitBounds(track, { padding: [40, 40], maxZoom: 10 });
  api.map.invalidateSize();
  return group;
}
