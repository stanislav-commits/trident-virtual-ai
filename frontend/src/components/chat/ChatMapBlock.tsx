import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { ChatMapDto } from "../../types/chat";
import {
  drawTrackOnWindy,
  initWindy,
  windyKey,
  type WindyApi,
} from "./windyMap";

/**
 * Draws the vessel's GPS track (render_map) on a self-contained Leaflet map —
 * track polyline + start/current markers, fit to bounds. An expand button
 * opens the vessel's location on an interactive Windy weather map in a modal
 * (single instance, so multiple in-chat maps never conflict), with a layer
 * switcher for wind/waves/rain/etc.
 *
 * Plain imperative Leaflet (not react-leaflet) so it's robust under React 19
 * and lets several map blocks coexist in one conversation.
 */

// Our render_map layer names → Windy embed overlay names.
const WINDY_OVERLAY: Record<string, string> = {
  wind: "wind",
  waves: "waves",
  currents: "currents",
  pressure: "pressure",
  temp: "temp",
  rain: "rain",
  gust: "gust",
  swell: "swell1",
};

// Selectable layers for the in-modal weather-layer switcher (label is
// English-only, matching the rest of this file's hardcoded UI strings).
const WEATHER_LAYERS: Array<{ overlay: string; label: string }> = [
  { overlay: "wind", label: "Wind" },
  { overlay: "waves", label: "Waves" },
  { overlay: "currents", label: "Currents" },
  { overlay: "pressure", label: "Pressure" },
  { overlay: "temp", label: "Temp" },
  { overlay: "rain", label: "Rain" },
  { overlay: "gust", label: "Gusts" },
  { overlay: "swell1", label: "Swell" },
];

export default function ChatMapBlock({ chart }: { chart: ChatMapDto }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [weatherOpen, setWeatherOpen] = useState(false);

  const points = useMemo(
    () =>
      chart.track
        .filter(
          (p) =>
            typeof p.lat === "number" &&
            typeof p.lon === "number" &&
            Number.isFinite(p.lat) &&
            Number.isFinite(p.lon),
        )
        .map((p) => [p.lat, p.lon] as [number, number]),
    [chart],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el || points.length === 0) return;

    // CARTO "Voyager" basemap — colourful and readable (the dark CARTO tiles
    // render almost pure black in the compact card). NOTE: Voyager lives under
    // the `rastertiles/` path; without it CARTO returns 404 and the card shows
    // a blank grey map.
    const tileUrl =
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";

    const map = L.map(el, {
      // Attribution box hidden at the operator's request for a cleaner card.
      // (OSM data is ODbL — "© OpenStreetMap contributors" is normally
      // expected; re-enable if that attribution needs to be shown.)
      attributionControl: false,
      // Let the crew zoom the inline card with the wheel (not only once the
      // full-screen modal is open).
      scrollWheelZoom: true,
      zoomControl: true,
    });
    L.tileLayer(tileUrl, {
      maxZoom: 19,
    }).addTo(map);

    const line = L.polyline(points, {
      color: "#2f81f7",
      weight: 3,
      opacity: 0.9,
    }).addTo(map);

    // Start marker (hollow) and current-position marker (filled).
    const start = points[0];
    const last = points[points.length - 1];
    L.circleMarker(start, {
      radius: 5,
      color: "#3fb950",
      fillColor: "#3fb950",
      fillOpacity: 0.5,
      weight: 2,
    })
      .addTo(map)
      .bindTooltip("Start", { direction: "top" });

    const cur = chart.current;
    L.circleMarker(last, {
      radius: 7,
      color: "#ffffff",
      fillColor: "#2f81f7",
      fillOpacity: 1,
      weight: 2,
    })
      .addTo(map)
      .bindTooltip(
        cur
          ? `${cur.lat.toFixed(4)}, ${cur.lon.toFixed(4)}`
          : "Current position",
        { direction: "top", permanent: false },
      );

    map.fitBounds(line.getBounds(), { padding: [24, 24], maxZoom: 12 });

    // Leaflet needs a size recalc once the container has real dimensions.
    const t = window.setTimeout(() => map.invalidateSize(), 60);

    return () => {
      window.clearTimeout(t);
      map.remove();
    };
    // `points` is memoized from `chart`; depending on the whole `chart`
    // covers `chart.current` without tripping the ref-mutation rule.
  }, [chart, points]);

  useEffect(() => {
    if (!weatherOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWeatherOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [weatherOpen]);

  const [activeOverlay, setActiveOverlay] = useState(
    WINDY_OVERLAY[chart.weatherLayer] ?? "wind",
  );

  // Windy weather modal: prefer the Map-Forecast API (draws the track ON the
  // weather map, uses the operator's key). On no-key / blocked-domain / load
  // failure, fall back to the keyless Windy embed. The Windy instance is a
  // page-wide singleton reparented into whichever modal is open.
  const [windyMode, setWindyMode] = useState<"loading" | "windy" | "embed">(
    windyKey() ? "loading" : "embed",
  );
  const windyMountRef = useRef<HTMLDivElement | null>(null);
  const windyHandleRef = useRef<{
    el: HTMLElement;
    holder: HTMLElement;
    group: unknown;
    api: WindyApi;
  } | null>(null);

  useEffect(() => {
    if (!weatherOpen || !windyKey()) return;
    let cancelled = false;
    initWindy()
      .then(({ api, el, holder }) => {
        if (cancelled) return;
        const mount = windyMountRef.current;
        if (!mount) return;
        mount.appendChild(el);
        const group = drawTrackOnWindy(api, points, activeOverlay);
        windyHandleRef.current = { el, holder, group, api };
        setWindyMode("windy");
        // Windy sizes its own chrome (zoom control, layer badge) off the
        // container's dimensions at the moment it's read — reparenting
        // happens before the modal has finished layout, so those controls
        // end up positioned for the off-screen holder's original 1200x800,
        // not our modal. Re-measure once the modal has actually painted.
        window.setTimeout(() => {
          try {
            api.map.invalidateSize();
          } catch {
            // ignore
          }
          window.dispatchEvent(new Event("resize"));
        }, 100);
      })
      .catch(() => {
        if (!cancelled) setWindyMode("embed");
      });
    return () => {
      cancelled = true;
      const h = windyHandleRef.current;
      if (h) {
        if (h.group) {
          try {
            h.api.map.removeLayer(h.group);
          } catch {
            // ignore
          }
        }
        // Return the singleton element to its off-screen holder so Windy
        // stays alive for the next open.
        try {
          h.holder.appendChild(h.el);
        } catch {
          // ignore
        }
        windyHandleRef.current = null;
      }
    };
  }, [weatherOpen, points, activeOverlay]);

  // Drive Windy's (visually hidden) native zoom by clicking its own controls —
  // robust across Windy versions and avoids reaching into its Leaflet API.
  const zoomWindy = (dir: 1 | -1) => {
    const sel = dir > 0 ? ".zoom-plus" : ".zoom-minus";
    const btn = document.querySelector<HTMLElement>(`#embed-zoom ${sel}`);
    btn?.click();
  };

  if (points.length === 0) {
    return (
      <div className="chat-map chat-map--empty">
        <div className="chat-map__empty">No position fixes for this period.</div>
      </div>
    );
  }

  const cur = chart.current;
  const windyUrl =
    cur &&
    `https://embed.windy.com/embed2.html?lat=${cur.lat}&lon=${cur.lon}` +
      `&detailLat=${cur.lat}&detailLon=${cur.lon}&zoom=8&level=surface` +
      `&overlay=${activeOverlay}&menu=&message=&marker=true&calendar=now` +
      // Force English Windy UI chrome regardless of the browser's locale —
      // Windy otherwise auto-detects from navigator.language.
      `&type=map&location=coordinates&metricWind=kt&metricTemp=%C2%B0C&radarRange=-1&lang=en`;

  return (
    <>
      <div className="chat-map">
        <div className="chat-map__header">
          <span className="chat-map__title">{chart.title}</span>
          {windyUrl && (
            <button
              type="button"
              className="chat-map__expand-btn"
              onClick={() => setWeatherOpen(true)}
              title="Expand"
              aria-label="Expand map"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          )}
        </div>
        <div ref={containerRef} className="chat-map__canvas" />
      </div>

      {weatherOpen &&
        windyUrl &&
        createPortal(
          <div
            className="chat-map-modal-overlay"
            onClick={() => setWeatherOpen(false)}
          >
            <div
              className="chat-map-modal"
              onClick={(e) => e.stopPropagation()}
            >
              {/* No close button — click outside the map (or press Escape) to
                  close. The X used to sit behind Windy's chrome anyway. */}
              {windyMode === "embed" ? (
                <iframe
                  title="Windy weather map"
                  className="chat-map-modal__frame"
                  src={windyUrl}
                  frameBorder={0}
                  loading="lazy"
                />
              ) : (
                <>
                  <div ref={windyMountRef} className="chat-map-modal__frame" />
                  {windyMode === "loading" && (
                    <div className="chat-map-modal__loading">
                      Загрузка карты Windy…
                    </div>
                  )}
                </>
              )}
              {windyMode !== "loading" && (
                <div className="chat-map-modal__layers">
                  {WEATHER_LAYERS.map((l) => (
                    <button
                      key={l.overlay}
                      type="button"
                      className={
                        "chat-map-modal__layer-btn" +
                        (l.overlay === activeOverlay
                          ? " chat-map-modal__layer-btn--active"
                          : "")
                      }
                      onClick={() => setActiveOverlay(l.overlay)}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              )}
              {windyMode === "windy" && (
                <div className="chat-map-modal__zoom">
                  <button
                    type="button"
                    onClick={() => zoomWindy(1)}
                    aria-label="Zoom in"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onClick={() => zoomWindy(-1)}
                    aria-label="Zoom out"
                  >
                    −
                  </button>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
