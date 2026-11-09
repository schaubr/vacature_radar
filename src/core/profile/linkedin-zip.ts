import { unzipSync } from "fflate";
import { tEn, type Translator } from "../../shared/i18n";
import Papa from "papaparse";

type Row = Record<string, string>;

interface FileSpec {
  file: string;
  heading: string;
  known: string[];
  /** Render each row as its own block ("entries") or as a flat key list. */
  kind: "single" | "entries" | "list";
  titleKeys?: string[];
}

const SPECS: FileSpec[] = [
  {
    file: "profile.csv",
    heading: "Profile",
    kind: "single",
    known: ["First Name", "Last Name", "Headline", "Summary", "Industry", "Geo Location"],
  },
  {
    file: "positions.csv",
    heading: "Experience",
    kind: "entries",
    titleKeys: ["Title", "Company Name"],
    known: ["Title", "Company Name", "Started On", "Finished On", "Location", "Description"],
  },
  {
    file: "education.csv",
    heading: "Education",
    kind: "entries",
    titleKeys: ["Degree Name", "School Name"],
    known: ["School Name", "Degree Name", "Start Date", "End Date", "Notes", "Activities"],
  },
  { file: "skills.csv", heading: "Skills", kind: "list", known: ["Name"] },
  {
    file: "languages.csv",
    heading: "Languages",
    kind: "entries",
    titleKeys: ["Name"],
    known: ["Name", "Proficiency"],
  },
  {
    file: "certifications.csv",
    heading: "Certifications",
    kind: "entries",
    titleKeys: ["Name", "Authority"],
    known: ["Name", "Authority", "Started On", "Finished On", "License Number", "Url"],
  },
  {
    file: "projects.csv",
    heading: "Projects",
    kind: "entries",
    titleKeys: ["Title"],
    known: ["Title", "Description", "Url", "Started On", "Finished On"],
  },
  {
    file: "volunteering.csv",
    heading: "Volunteering",
    kind: "entries",
    titleKeys: ["Role", "Organization"],
    known: ["Organization", "Role", "Cause", "Started On", "Finished On", "Description"],
  },
];

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1].toLowerCase();
}

/** Drop any preamble ("Notes: ...") before the real header line. */
function stripPreamble(text: string): string {
  const t = text.replace(/^﻿/, "");
  const lines = t.split(/\r?\n/);
  let openQuote = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startedInQuote = openQuote;
    const quotes = (line.match(/"/g) ?? []).length;
    if (quotes % 2 === 1) openQuote = !openQuote;
    if (startedInQuote) continue;
    if ((line.match(/,/g) ?? []).length < 2) continue;
    if (/^notes:/i.test(line.trim())) continue;
    const parsed = Papa.parse<string[]>(line, { header: false });
    if ((parsed.data[0]?.length ?? 0) >= 2) return lines.slice(i).join("\n");
  }
  return t;
}

function parseCsv(text: string): Row[] {
  const res = Papa.parse<Row>(stripPreamble(text), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  return res.data
    .map((r) => {
      const out: Row = {};
      for (const [k, v] of Object.entries(r)) {
        if (!k || k.startsWith("__parsed")) continue;
        const val = typeof v === "string" ? v.replace(/\r\n/g, "\n").trim() : "";
        if (val) out[k] = val;
      }
      return out;
    })
    .filter((r) => Object.keys(r).length > 0);
}

function orderedKeys(row: Row, known: string[]): string[] {
  const first = known.filter((k) => k in row);
  const rest = Object.keys(row).filter((k) => !known.includes(k));
  return [...first, ...rest];
}

function indentValue(v: string): string {
  return v.includes("\n") ? "\n" + v.split("\n").map((l) => `  ${l}`).join("\n") : ` ${v}`;
}

function renderRow(row: Row, known: string[], skip: string[] = []): string[] {
  return orderedKeys(row, known)
    .filter((k) => !skip.includes(k))
    .map((k) => `- ${k}:${indentValue(row[k])}`);
}

function renderSection(spec: FileSpec, rows: Row[]): string {
  const out: string[] = [`## ${spec.heading}`, ""];
  if (spec.kind === "single") {
    for (const row of rows) out.push(...renderRow(row, spec.known), "");
  } else if (spec.kind === "list") {
    const names = rows.map((r) => r["Name"] ?? Object.values(r)[0]).filter(Boolean);
    out.push(names.join(", "), "");
  } else {
    for (const row of rows) {
      const titleParts = (spec.titleKeys ?? []).map((k) => row[k]).filter(Boolean);
      const heading = titleParts.length ? titleParts.join(" at ") : Object.values(row)[0];
      const period = [row["Started On"] ?? row["Start Date"], row["Finished On"] ?? row["End Date"]];
      const periodText = period[0] || period[1] ? ` (${period[0] ?? "?"} - ${period[1] ?? "present"})` : "";
      out.push(`### ${heading}${periodText}`);
      const skip = [...(spec.titleKeys ?? []), "Started On", "Finished On", "Start Date", "End Date"];
      out.push(...renderRow(row, spec.known, skip), "");
    }
  }
  return out.join("\n");
}

/** Convert a LinkedIn "Get a copy of your data" zip into a markdown profile. */
export function linkedinZipToMarkdown(buf: Uint8Array, t: Translator = tEn): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf);
  } catch {
    throw new Error(t("linkedin.badZip"));
  }
  const byName = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(files)) {
    const name = basename(path);
    if (name && !byName.has(name)) byName.set(name, data);
  }

  const dec = new TextDecoder("utf-8");
  const sections: string[] = [];
  for (const spec of SPECS) {
    const data = byName.get(spec.file);
    if (!data) continue;
    const rows = parseCsv(dec.decode(data));
    if (rows.length) sections.push(renderSection(spec, rows));
  }
  if (!sections.length) {
    throw new Error(t("linkedin.noData"));
  }
  return ["# LinkedIn profile", "", ...sections].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
