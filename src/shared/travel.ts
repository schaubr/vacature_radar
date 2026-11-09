import type { GeoState } from "./types";
import { formatNumber, translate, type Lang } from "./i18n";

/** "34 min by car, 41 km" (prefixed "about " when only the region is known). Empty string when unknown. English unless `lang` says otherwise. */
export function formatTravel(
  v: {
    travelMinutes: number | null;
    travelKm: number | null;
    geoState: GeoState;
  },
  lang: Lang = "en",
): string {
  if (v.travelMinutes === null) return "";
  const parts = [translate(lang, "travel.byCar", { min: Math.round(v.travelMinutes) })];
  if (v.travelKm !== null) {
    parts.push(translate(lang, "travel.km", { km: formatNumber(lang, Math.round(v.travelKm * 10) / 10, { useGrouping: false }) }));
  }
  const text = parts.join(", ");
  return v.geoState === "approximate" ? translate(lang, "travel.about", { text }) : text;
}
