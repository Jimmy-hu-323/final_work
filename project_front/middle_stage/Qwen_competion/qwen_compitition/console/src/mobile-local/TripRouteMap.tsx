import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { fetchQwenPawRoute, type LocalTrip, type TripStop } from "./runtime";
import styles from "./mobileLocal.module.less";

type Props = {
  trip: LocalTrip;
  currentStopIndex?: number;
};

type LatLng = [number, number];

const AMAP_TILE_URL =
  "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}";
const routeCache = new Map<string, LatLng[]>();

function locatedStops(stops: TripStop[]): TripStop[] {
  return stops.filter(
    (stop) => Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude),
  );
}

function location(stop: TripStop): string {
  return `${stop.longitude!.toFixed(6)},${stop.latitude!.toFixed(6)}`;
}

function routeMode(stop: TripStop): "walking" | "driving" {
  return stop.note?.includes("步行") ? "walking" : "driving";
}

export default function TripRouteMap({ trip, currentStopIndex = -1 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [tilesFailed, setTilesFailed] = useState(false);
  const stops = useMemo(() => locatedStops(trip.stops || []), [trip.stops]);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current || !stops.length) return;
    let disposed = false;
    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: false,
    });
    const routeLayer = L.layerGroup().addTo(map);
    if (online) {
      let failures = 0;
      const tiles = L.tileLayer(AMAP_TILE_URL, {
        subdomains: "1234",
        maxZoom: 18,
        minZoom: 3,
      });
      tiles.on("tileerror", () => {
        failures += 1;
        if (failures >= 3) setTilesFailed(true);
      });
      tiles.on("load", () => setTilesFailed(false));
      tiles.addTo(map);
    }

    const coordinates = stops.map(
      (stop) => [stop.latitude!, stop.longitude!] as LatLng,
    );
    const drawRoutes = () => {
      routeLayer.clearLayers();
      for (let index = 1; index < stops.length; index += 1) {
        const previous = stops[index - 1];
        const current = stops[index];
        const mode = routeMode(current);
        const key = `${mode}:${location(previous)}:${location(current)}`;
        const realRoute = routeCache.get(key);
        L.polyline(
          realRoute?.length
            ? realRoute
            : [coordinates[index - 1], coordinates[index]],
          {
            color: "#ff6a00",
            weight: realRoute?.length ? 5 : 4,
            opacity: realRoute?.length ? 0.88 : 0.55,
            dashArray: realRoute?.length ? undefined : "8 8",
            lineJoin: "round",
          },
        ).addTo(routeLayer);
      }
    };
    drawRoutes();

    stops.forEach((stop, index) => {
      const originalIndex = (trip.stops || []).findIndex(
        (item) => item.id === stop.id,
      );
      const state =
        originalIndex <= currentStopIndex
          ? "done"
          : originalIndex === currentStopIndex + 1
          ? "next"
          : "future";
      const icon = L.divIcon({
        className: "",
        html: `<span class="${styles.tripMapMarker} ${
          styles[`tripMapMarker_${state}`]
        }">${originalIndex + 1}</span>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });
      const marker = L.marker(coordinates[index], { icon });
      const tooltip = document.createElement("span");
      tooltip.textContent = [
        stop.name,
        stop.day ? `第 ${stop.day} 天` : "",
        stop.time || "",
      ]
        .filter(Boolean)
        .join(" · ");
      marker.bindTooltip(tooltip, { direction: "top" });
      marker.addTo(map);
    });
    if (coordinates.length === 1) {
      map.setView(coordinates[0], 15);
    } else {
      map.fitBounds(L.latLngBounds(coordinates), {
        padding: [28, 28],
        maxZoom: 16,
      });
    }
    mapRef.current = map;

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => map.invalidateSize(false));
    resizeObserver?.observe(containerRef.current);
    window.requestAnimationFrame(() => map.invalidateSize(false));

    if (online) {
      stops.slice(1).forEach((stop, relativeIndex) => {
        const previous = stops[relativeIndex];
        const mode = routeMode(stop);
        const origin = location(previous);
        const destination = location(stop);
        const key = `${mode}:${origin}:${destination}`;
        if (routeCache.has(key)) return;
        void fetchQwenPawRoute(origin, destination, mode)
          .then((response) => {
            const points = (response.points || []).filter(
              (point): point is LatLng =>
                Array.isArray(point) &&
                point.length === 2 &&
                Number.isFinite(point[0]) &&
                Number.isFinite(point[1]),
            );
            if (!disposed && points.length) {
              routeCache.set(key, points);
              drawRoutes();
            }
          })
          .catch(() => {
            // The straight dashed segment remains visible if the route service
            // is temporarily unavailable; the server-side key is never exposed.
          });
      });
    }

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, [currentStopIndex, online, stops, trip.stops]);

  if (!stops.length) {
    return (
      <div className={styles.tripMapEmpty}>
        这份行程还没有景点坐标。请在“对话”中完成并确认一次规划，系统会从服务器高德行程同步坐标和路线。
      </div>
    );
  }

  return (
    <div className={styles.tripMapShell}>
      {!online && (
        <div className={styles.tripMapOffline}>
          当前离线：继续显示本地保存的景点顺序和路线，地图底图暂不可用。
        </div>
      )}
      {online && tilesFailed && (
        <div className={styles.tripMapOffline}>
          高德底图暂时加载失败，景点与路线仍会继续显示。
        </div>
      )}
      <div
        ref={containerRef}
        className={styles.tripMap}
        aria-label={`${trip.title}路线图`}
      />
    </div>
  );
}
