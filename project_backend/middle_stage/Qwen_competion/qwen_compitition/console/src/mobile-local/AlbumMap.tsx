import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { AlbumItem } from "./runtime";
import { locationLabel } from "./runtime";
import styles from "./mobileLocal.module.less";

type AlbumMapProps = {
  items: AlbumItem[];
  onSelect: (items: AlbumItem[], label: string) => void;
};

type Cluster = {
  latitude: number;
  longitude: number;
  items: AlbumItem[];
};

function locationItems(items: AlbumItem[]): AlbumItem[] {
  return items.filter(
    (item) =>
      Number.isFinite(item.location?.latitude) &&
      Number.isFinite(item.location?.longitude),
  );
}

function cellSize(zoom: number): number {
  if (zoom <= 9) return 0.8;
  if (zoom <= 11) return 0.25;
  if (zoom <= 13) return 0.06;
  if (zoom <= 15) return 0.015;
  if (zoom <= 17) return 0.004;
  return 0.001;
}

function detailForZoom(zoom: number): "broad" | "city" | "precise" {
  if (zoom <= 10) return "broad";
  if (zoom <= 14) return "city";
  return "precise";
}

function clusterItems(items: AlbumItem[], zoom: number): Cluster[] {
  const size = cellSize(zoom);
  const groups = new Map<string, Cluster>();
  for (const item of locationItems(items)) {
    const latitude = item.location!.latitude!;
    const longitude = item.location!.longitude!;
    const key = `${Math.round(latitude / size)}:${Math.round(longitude / size)}`;
    const current = groups.get(key);
    if (current) {
      current.items.push(item);
      current.latitude =
        current.items.reduce((sum, value) => sum + value.location!.latitude!, 0) /
        current.items.length;
      current.longitude =
        current.items.reduce((sum, value) => sum + value.location!.longitude!, 0) /
        current.items.length;
    } else {
      groups.set(key, { latitude, longitude, items: [item] });
    }
  }
  return [...groups.values()];
}

export default function AlbumMap({ items, onSelect }: AlbumMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const itemsRef = useRef(items);
  const onSelectRef = useRef(onSelect);
  const fittedRef = useRef(false);
  const hasLocatedItems = locationItems(items).length > 0;

  itemsRef.current = items;
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
    }).setView([22.1987, 113.5439], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    }).addTo(map);
    const layer = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerRef.current = layer;

    const render = () => {
      layer.clearLayers();
      const zoom = map.getZoom();
      const detail = detailForZoom(zoom);
      for (const cluster of clusterItems(itemsRef.current, zoom)) {
        const count = cluster.items.length;
        const icon = L.divIcon({
          className: "",
          html: `<span class="${styles.mapMarker}">${count}</span>`,
          iconSize: [44, 44],
          iconAnchor: [22, 22],
        });
        const marker = L.marker([cluster.latitude, cluster.longitude], { icon });
        const label =
          locationLabel(cluster.items[0].location, detail) ||
          `${cluster.latitude.toFixed(4)}, ${cluster.longitude.toFixed(4)}`;
        const tooltip = document.createElement("span");
        tooltip.textContent = `${label} · ${count} 张`;
        marker.bindTooltip(tooltip, { direction: "top" });
        marker.on("click", () => onSelectRef.current(cluster.items, label));
        marker.addTo(layer);
      }
    };

    map.on("zoomend moveend", render);
    render();
    window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      map.off();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [hasLocatedItems]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const zoom = map.getZoom();
    const detail = detailForZoom(zoom);
    for (const cluster of clusterItems(items, zoom)) {
      const count = cluster.items.length;
      const icon = L.divIcon({
        className: "",
        html: `<span class="${styles.mapMarker}">${count}</span>`,
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      });
      const marker = L.marker([cluster.latitude, cluster.longitude], { icon });
      const label = locationLabel(cluster.items[0].location, detail);
      const tooltip = document.createElement("span");
      tooltip.textContent = `${label} · ${count} 张`;
      marker.bindTooltip(tooltip, { direction: "top" });
      marker.on("click", () => onSelectRef.current(cluster.items, label));
      marker.addTo(layer);
    }
    const located = locationItems(items);
    if (!fittedRef.current && located.length) {
      fittedRef.current = true;
      const bounds = L.latLngBounds(
        located.map((item) => [
          item.location!.latitude!,
          item.location!.longitude!,
        ]),
      );
      map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
    }
    window.setTimeout(() => map.invalidateSize(), 0);
  }, [items]);

  if (!hasLocatedItems) {
    return (
      <div className={styles.mapEmpty}>
        暂无带坐标的照片。导入含 GPS 的原图，或等待识图 AI 高置信度识别地标。
      </div>
    );
  }

  return <div ref={containerRef} className={styles.albumMap} aria-label="旅行照片地图" />;
}
