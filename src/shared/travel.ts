import type { GeoState } from "./types";

/** "34 min by car, 41 km" (prefixed "about " when only the region is known). Empty string when unknown. */
export function formatTravel(v: {
  travelMinutes: number | null;
  travelKm: number | null;
  geoState: GeoState;
}): string {
  if (v.travelMinutes === null) return "";
  const parts = [`${Math.round(v.travelMinutes)} min by car`];
  if (v.travelKm !== null) parts.push(`${Math.round(v.travelKm * 10) / 10} km`);
  const text = parts.join(", ");
  return v.geoState === "approximate" ? `about ${text}` : text;
}
