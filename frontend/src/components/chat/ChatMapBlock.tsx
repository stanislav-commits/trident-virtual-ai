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
 * track polyline + start/current markers, fit to bounds. A "Weather (Windy)"
 * button opens the vessel's location on an interactive Windy weather map in a
 * modal (single instance, so multiple in-chat maps never conflict).
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

function isDarkTheme(): boolean {
  const root = document.documentElement;
  const attr = root.getAttribute("data-theme");
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

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

    const dark = isDarkTheme();
    const tileUrl = dark
      ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      : "https://{s}.basemaps.cartocdn.com/voyager/{z}/{x}/{y}{r}.png";

    const map = L.map(el, {
      attributionControl: true,
      scrollWheelZoom: false,
      zoomControl: true,
    });
    L.tileLayer(tileUrl, {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
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

  const overlay = WINDY_OVERLAY[chart.weatherLayer] ?? "wind";

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
        const group = drawTrackOnWindy(api, points, overlay);
        windyHandleRef.current = { el, holder, group, api };
        setWindyMode("windy");
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
  }, [weatherOpen, points, overlay]);

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
      `&overlay=${overlay}&menu=&message=&marker=true&calendar=now` +
      `&type=map&location=coordinates&metricWind=kt&metricTemp=%C2%B0C&radarRange=-1`;

  return (
    <>
      <div className="chat-map">
        <div className="chat-map__header">
          <span className="chat-map__title">{chart.title}</span>
          {windyUrl && (
            <button
              type="button"
              className="chat-map__weather-btn"
              onClick={() => setWeatherOpen(true)}
              title="Открыть карту погоды Windy"
            >
              Погода Windy
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
              <button
                type="button"
                className="chat-map-modal__close"
                onClick={() => setWeatherOpen(false)}
                aria-label="Close"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
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
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
