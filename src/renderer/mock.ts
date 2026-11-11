/**
 * In-memory fake of the main-process API so the UI can run in a plain browser
 * (used for design review screenshots). Installed only when `window.radar` is
 * missing; only reachable from mock-entry.tsx, never from the real bundle.
 */
import type { RadarApi, RadarBridge, RadarEvents } from "../shared/ipc";
import type {
  AppStatus, LogEntry, Profile, Settings, Source, SourceTestResult, UsageSummary, VacancyDetail, VacancyFilter, VacancyListItem,
} from "../shared/types";
import { DEFAULT_PREFERENCES, DEFAULT_SETTINGS } from "../shared/types";
import { formatUsd, translatorFor } from "../shared/i18n";

if (typeof window !== "undefined" && !(window as { radar?: RadarBridge }).radar) install();

function install() {
  const H = 3600_000;
  const D = 24 * H;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // UI-side texts of the fake backend follow the language setting, like the real main process.
  const t = translatorFor(() => settings.outputLanguage);

  const sources: Source[] = [
    src(1, "VDAB: maatschappelijk werker", "https://www.vdab.be/vindeenjob/vacatures?trefwoord=maatschappelijk%20werker", "browser", "browser", "recipe", "ok", 20, 0.4 * H),
    src(2, "VVSG (lokale besturen)", "https://www.vvsg.be/vacatures/overzicht-vacatures", "static", "static", "jsonld", "ok", 18, 0.5 * H),
    src(3, "Jobsolutions", "https://www.jobsolutions.be/", "auto", "static", "recipe", "empty", 0, 5 * H),
    src(4, "CAW (cawpro.be)", "https://www.cawpro.be/jobs/?caw-type=job", "auto", null, null, "error", 0, 5 * H, "@caw"),
    { ...src(5, "Fiola vzw", "https://fiolavzw.be/vacatures/", "static", "static", "recipe", "never", 0, 0), lastScanAt: null, lastSuccessAt: null, notes: "Vacancy list on fiolavzw.be, detail pages on Jobtoolz (fiola-vzw.jobtoolz.com). Verified 2026-11-09." },
  ];
  function src(id: number, name: string, url: string, renderMode: Source["renderMode"], detectedMode: Source["detectedMode"], strategy: Source["strategy"], lastStatus: Source["lastStatus"], lastFound: number, since: number, lastError: string | null = null): Source {
    return {
      id, name, url, enabled: id !== 3, renderMode, detectedMode, scanIntervalHours: id === 1 ? 3 : null, maxPages: id === 1 ? 2 : 1, strategy,
      recipe: null, lastScanAt: ago(since), lastSuccessAt: lastStatus === "error" ? ago(3 * D) : ago(since), lastStatus, lastError, lastFound,
      lastPageHash: null, consecutiveFailures: lastStatus === "error" ? 3 : 0, notes: id === 4 ? "Seeded 2026-11-08. Use Test before enabling." : "", createdAt: ago(9 * D),
    };
  }

  const text1 = `Functie\nAls maatschappelijk werker bied je laagdrempelige hulp- en dienstverlening aan inwoners van Lendelede. Je onthaalt en onderzoekt hulpvragen, werkt samen met huisartsen, het CAW en thuiszorg en volgt dossiers op binnen het sociaal huis.\n\nProfiel\n- Bachelor in het sociaal werk of maatschappelijk werk\n- Ervaring met sociale dienstverlening is een troef\n- Je bent stressbestendig, empathisch en werkt zelfstandig\n\nAanbod\n- Contract van onbepaalde duur, voltijds (38u)\n- Weddeschaal B1-B3\n- Maaltijdcheques, fietsvergoeding, hospitalisatieverzekering\n\nSolliciteren kan tot 30 november 2026 via de website van de gemeente.`;

  interface Seed { id: number; sourceId: number; title: string; org: string; loc: string; status: VacancyDetail["status"]; score: number | null; bucket: VacancyDetail["bucket"]; state: VacancyDetail["scoreState"]; seen: number; deadline?: string; dups?: number; sub?: [number, number, number, number]; reasons?: string[]; gaps?: string[]; ko?: string; conf?: "high" | "medium" | "low"; summary?: string; fields?: Partial<NonNullable<VacancyDetail["fields"]>>; prefilter?: string; err?: string }
  const seeds: Seed[] = [
    { id: 1, sourceId: 2, title: "Maatschappelijk werker", org: "OCMW Lendelede", loc: "Lendelede", status: "new", score: 88, bucket: "strong", state: "scored", seen: 0.3 * H, deadline: "2026-11-30", dups: 2, sub: [95, 82, 90, 78], conf: "high",
      reasons: ["Requires a bachelor in social work, which matches your degree.", "Your 4 years in local social services map directly onto the intake and follow-up tasks.", "Permanent full-time contract in the West Flanders region you listed.", "Pay scale B1-B3 fits your salary expectations."],
      gaps: ["Lendelede is about 55 minutes from Gent by car, above your commute limit.", "Experience with housing files is mentioned but not on your profile."],
      summary: "Social worker for the social house of Lendelede: intake, assessment of help requests and case follow-up with local partners.", fields: { sector: "Local government, social services", hours: "Full-time (38h)", contract: "Permanent", diplomaRequired: "Bachelor social work", experienceRequired: "Relevant experience is an asset", payScale: "B1-B3", deadline: "2026-11-30", isSocialSector: true } },
    { id: 2, sourceId: 1, title: "Begeleider jeugdhulp", org: "Vzw Jeugdzorg Emmaüs", loc: "Gent", status: "new", score: 76, bucket: "strong", state: "scored", seen: 1.2 * H, deadline: "2026-12-15", sub: [90, 70, 80, 74], conf: "medium",
      reasons: ["Residential youth care is close to your 2022 internship and volunteering.", "Located in Gent, your home town.", "Orthopedagogy or social work degrees are both accepted."],
      gaps: ["Includes night and weekend shifts, which you marked as undesirable.", "Two years of group-work experience requested; you have about one."],
      summary: "Educator in a residential group for teenagers, working in a rota including nights.", fields: { sector: "Youth care", hours: "Full-time, rota", contract: "Permanent", diplomaRequired: "Bachelor orthopedagogy or social work", experienceRequired: "2 years preferred", payScale: "PC 331 / IFIC", deadline: "2026-12-15", isSocialSector: true } },
    { id: 3, sourceId: 1, title: "Sociaal-cultureel werker", org: "GC De Linde", loc: "Zwevegem", status: "seen", score: 64, bucket: "possible", state: "scored", seen: 1 * D, sub: [80, 55, 70, 50], conf: "medium",
      reasons: ["Community work with vulnerable groups relates to your volunteering.", "Part-time option available."],
      gaps: ["Focus is on cultural programming, not casework.", "Zwevegem is far from your home location."], summary: "Organises neighbourhood activities and participation projects for the community centre.", fields: { sector: "Socio-cultural work", hours: "Part-time (24h)", contract: "Replacement", diplomaRequired: "Bachelor", experienceRequired: "None specified", payScale: "PC 329", deadline: "", isSocialSector: true } },
    { id: 4, sourceId: 2, title: "Diensthoofd welzijn", org: "Lokaal bestuur Deinze", loc: "Deinze", status: "interested", score: 58, bucket: "possible", state: "scored", seen: 2 * D, deadline: "2026-12-01", sub: [85, 30, 60, 70], conf: "high",
      reasons: ["Close to Gent and well paid (A1a).", "Matches your ambition to grow into coordination."], gaps: ["Asks for 5 years of management experience.", "Selection includes a leadership assessment."], summary: "Leads the welfare department of the municipality and its team of 14.", fields: { sector: "Local government", hours: "Full-time", contract: "Permanent", diplomaRequired: "Master", experienceRequired: "5 years leadership", payScale: "A1a-A3a", deadline: "2026-12-01", isSocialSector: true } },
    { id: 5, sourceId: 1, title: "Poetsvrouw / schoonmaker (m/v/x)", org: "Zorgbedrijf Antwerpen", loc: "Antwerpen", status: "new", score: null, bucket: null, state: "filtered", seen: 3 * H, prefilter: "@poets", dups: 0 },
    { id: 6, sourceId: 2, title: "Psychologisch consulent", org: "CGG Ahasverus", loc: "Brussel", status: "seen", score: 22, bucket: "knockout", state: "scored", seen: 3 * D, sub: [5, 40, 60, 70], conf: "high", ko: "Requires a master in psychology and a clinical licence, which you do not hold.",
      reasons: ["Mental health setting overlaps with your interest."], gaps: ["Diploma requirement is a hard gate.", "Brussels commute exceeds your limit."], summary: "Psychological consultant in a mental health centre.", fields: { sector: "Mental health care", hours: "Part-time", contract: "Permanent", diplomaRequired: "Master psychology + licence", experienceRequired: "1 year", payScale: "IFIC 4.28", deadline: "2026-11-20", isSocialSector: true } },
    { id: 7, sourceId: 1, title: "Huisbezoeker thuislozenzorg", org: "CAW Oost-Vlaanderen", loc: "Gent", status: "applied", score: 81, bucket: "strong", state: "scored", seen: 5 * D, sub: [90, 80, 85, 70], conf: "high",
      reasons: ["Direct match with your homeless-care internship.", "Based in Gent."], gaps: ["Occasional evening visits."], summary: "Outreach worker visiting people in precarious housing situations.", fields: { sector: "Welfare work", hours: "Full-time", contract: "Permanent", diplomaRequired: "Bachelor social work", experienceRequired: "1 year", payScale: "PC 319.01", deadline: "", isSocialSector: true } },
    { id: 8, sourceId: 1, title: "Administratief medewerker", org: "Stad Kortrijk", loc: "Kortrijk", status: "seen", score: 31, bucket: "weak", state: "scored", seen: 4 * D, sub: [40, 25, 30, 45], conf: "medium", reasons: ["Municipal employer."], gaps: ["Pure administrative role, no social work content.", "Wrong region."], summary: "General administrative support for the city archives.", fields: { sector: "Public administration", hours: "Full-time", contract: "Permanent", diplomaRequired: "Secondary education", experienceRequired: "None", payScale: "C1-C3", deadline: "2026-11-25", isSocialSector: false } },
    { id: 9, sourceId: 2, title: "Wijkwerker", org: "Samenlevingsopbouw Gent", loc: "Gent", status: "new", score: null, bucket: null, state: "pending", seen: 0.1 * H },
    { id: 10, sourceId: 3, title: "Pedagogisch medewerker kinderopvang", org: "Kind & Gezin Opvang vzw", loc: "Aalst", status: "dismissed", score: 45, bucket: "weak", state: "scored", seen: 6 * D, sub: [55, 40, 45, 40], conf: "low", reasons: ["Childcare is adjacent to youth work."], gaps: ["Different target group."], summary: "Childcare worker for a group of 18 toddlers.", fields: { sector: "Childcare", hours: "Part-time", contract: "Permanent", diplomaRequired: "Secondary + childcare diploma", experienceRequired: "None", payScale: "PC 331", deadline: "", isSocialSector: true } },
    { id: 11, sourceId: 1, title: "Sociaal werker eerstelijnszone", org: "Eerstelijnszone Meetjesland", loc: "Eeklo", status: "new", score: null, bucket: null, state: "error", seen: 2 * H, err: "@503" },
  ];

  type Geo = Pick<VacancyDetail, "travelMinutes" | "travelKm" | "geoState" | "geoQuery" | "geoLabel" | "geoError">;
  const ok = (q: string, label: string, travelMinutes: number, travelKm: number): Geo => ({ travelMinutes, travelKm, geoState: "ok", geoQuery: q, geoLabel: label, geoError: null });
  const geoById: Record<number, Geo> = {
    1: ok("Lendelede", "Lendelede, West-Vlaanderen, BE", 52, 63),
    2: ok("Gent", "Gent, Oost-Vlaanderen, BE", 6, 4.1),
    3: { travelMinutes: null, travelKm: null, geoState: "unavailable", geoQuery: "Zwevegem", geoLabel: "", geoError: null },
    4: ok("Deinze", "Deinze, Oost-Vlaanderen, BE", 22, 19),
    5: ok("Antwerpen", "Antwerpen, BE", 61, 72),
    6: ok("Brussel", "Brussel, BE", 48, 57),
    7: ok("Gent", "Gent, Oost-Vlaanderen, BE", 8, 5.5),
    8: ok("Kortrijk", "Kortrijk, West-Vlaanderen, BE", 41, 52),
    9: { travelMinutes: 38, travelKm: 42, geoState: "approximate", geoQuery: "Oost-Vlaanderen", geoLabel: "Oost-Vlaanderen, BE", geoError: null },
    10: ok("Aalst", "Aalst, Oost-Vlaanderen, BE", 32, 30),
    11: { travelMinutes: null, travelKm: null, geoState: "not_found", geoQuery: "Meetjesland Zuid", geoLabel: "", geoError: null },
  };
  const vacancies: VacancyDetail[] = seeds.map((s) => ({
    ...geoById[s.id],
    id: s.id, sourceId: s.sourceId, sourceName: sources.find((x) => x.id === s.sourceId)!.name, title: s.title, organization: s.org, location: s.loc,
    url: `https://example.org/vacature/${s.id}`, status: s.status, score: s.score, bucket: s.bucket, firstSeenAt: ago(s.seen), deadline: s.deadline ?? "", feedback: s.id === 7 ? "up" : null,
    scoreState: s.state, duplicateCount: s.dups ?? 0,
    description: s.id === 1 ? text1 : s.state === "pending" ? "" : `${s.title} bij ${s.org} in ${s.loc}.\n\nWe zoeken een gemotiveerde collega om ons team te versterken. Je werkt nauw samen met collega's en externe partners.\n\nWat bieden wij?\n- Een afwisselende job met ruimte voor initiatief\n- Verloning volgens de geldende barema's\n- Hospitalisatieverzekering en maaltijdcheques`,
    snippet: `${s.title} ${s.org}`, fields: s.fields ? { summary: s.summary ?? "", sector: "", isSocialSector: true, hours: "", contract: "", diplomaRequired: "", experienceRequired: "", payScale: "", deadline: "", ...s.fields } : null,
    scoreResult: s.score != null && s.sub ? { score: s.score, bucket: s.bucket!, subscores: { diploma: s.sub[0], experience: s.sub[1], skills: s.sub[2], preferences: s.sub[3] }, reasons: s.reasons ?? [], gaps: s.gaps ?? [], knockoutReason: s.ko ?? "", confidence: s.conf ?? "medium" } : null,
    scoreModel: s.score != null ? "claude-opus-5-5" : null, scoredAt: s.score != null ? ago(s.seen - 60_000) : null, scoreError: s.err ?? null, prefilterReason: s.prefilter ?? null,
    feedbackNote: s.id === 7 ? "Exactly the kind of job I want." : "", duplicates: s.dups ? [{ id: 101, url: "https://vdab.be/x", sourceName: "VDAB: maatschappelijk werker" }, { id: 102, url: "https://jobsolutions.be/y", sourceName: "Jobsolutions" }] : [], lastSeenAt: ago(0.4 * H),
  }));
  vacancies.find((v) => v.id === 9)!.location = "Oost-Vlaanderen";


  // Dutch versions of the fake AI output (summary, reasons, gaps, extracted fields), served when the language is "nl"
  // (as if the vacancy had been re-scored after switching language).
  type AiNl = { summary?: string; reasons?: string[]; gaps?: string[]; ko?: string; fields?: Partial<NonNullable<VacancyDetail["fields"]>> };
  const aiNl: Record<number, AiNl> = {
    1: { summary: "Maatschappelijk werker voor het sociaal huis van Lendelede: onthaal, onderzoek van hulpvragen en dossieropvolging met lokale partners.",
      reasons: ["Vereist een bachelor in het sociaal werk, wat overeenkomt met jouw diploma.", "Je 4 jaar in lokale sociale dienstverlening sluiten rechtstreeks aan bij de taken rond onthaal en opvolging.", "Vast voltijds contract in West-Vlaanderen, een van je gekozen regio's.", "Barema B1-B3 past bij je loonwensen."],
      gaps: ["Lendelede ligt ongeveer 55 minuten van Gent, boven je maximale pendeltijd.", "Ervaring met huisvestingsdossiers wordt vermeld maar staat niet in je profiel."],
      fields: { sector: "Lokale besturen, sociale dienstverlening", hours: "Voltijds (38u)", contract: "Vast", diplomaRequired: "Bachelor sociaal werk", experienceRequired: "Relevante ervaring is een troef", payScale: "B1-B3" } },
    2: { summary: "Begeleider in een residentiële groep voor tieners, met een beurtrol inclusief nachtdiensten.",
      reasons: ["Residentiële jeugdhulp sluit aan bij je stage uit 2022 en je vrijwilligerswerk.", "Gelegen in Gent, je woonplaats.", "Een diploma orthopedagogie of sociaal werk is allebei aanvaard."],
      gaps: ["Omvat nacht- en weekenddiensten, die je als ongewenst hebt aangeduid.", "Twee jaar groepswerkervaring gevraagd; jij hebt er ongeveer één."],
      fields: { sector: "Jeugdhulp", hours: "Voltijds, beurtrol", contract: "Vast", diplomaRequired: "Bachelor orthopedagogie of sociaal werk", experienceRequired: "2 jaar bij voorkeur" } },
    3: { summary: "Organiseert buurtactiviteiten en participatieprojecten voor het gemeenschapscentrum.",
      reasons: ["Gemeenschapsvorming met kwetsbare groepen sluit aan bij je vrijwilligerswerk.", "Deeltijdse invulling mogelijk."],
      gaps: ["De focus ligt op cultureel programmeren, niet op casework.", "Zwevegem ligt ver van je woonplaats."],
      fields: { sector: "Sociaal-cultureel werk", hours: "Deeltijds (24u)", contract: "Vervanging", diplomaRequired: "Bachelor", experienceRequired: "Niet vermeld" } },
    4: { summary: "Leidt de welzijnsdienst van de gemeente en een team van 14 medewerkers.",
      reasons: ["Dicht bij Gent en goed verloond (A1a).", "Past bij je ambitie om door te groeien naar coördinatie."],
      gaps: ["Vraagt 5 jaar leidinggevende ervaring.", "De selectie omvat een assessment rond leiderschap."],
      fields: { sector: "Lokale besturen", hours: "Voltijds", contract: "Vast", diplomaRequired: "Master", experienceRequired: "5 jaar leidinggevende ervaring" } },
    6: { summary: "Psychologisch consulent in een centrum voor geestelijke gezondheidszorg.",
      ko: "Vereist een master in de psychologie en een klinische erkenning, die je niet hebt.",
      reasons: ["De geestelijke gezondheidszorg sluit aan bij je interesses."],
      gaps: ["De diplomavereiste is een harde drempel.", "Brussel ligt boven je maximale pendeltijd."],
      fields: { sector: "Geestelijke gezondheidszorg", hours: "Deeltijds", contract: "Vast", diplomaRequired: "Master psychologie + erkenning", experienceRequired: "1 jaar" } },
    7: { summary: "Outreachwerker die mensen in precaire woonsituaties thuis bezoekt.",
      reasons: ["Rechtstreekse match met je stage in de thuislozenzorg.", "Gevestigd in Gent."],
      gaps: ["Af en toe avondbezoeken."],
      fields: { sector: "Welzijnswerk", hours: "Voltijds", contract: "Vast", diplomaRequired: "Bachelor sociaal werk", experienceRequired: "1 jaar" } },
    8: { summary: "Algemene administratieve ondersteuning voor het stadsarchief.",
      reasons: ["Werkgever is een stadsbestuur."],
      gaps: ["Louter administratieve functie, zonder inhoud rond sociaal werk.", "Verkeerde regio."],
      fields: { sector: "Openbaar bestuur", hours: "Voltijds", contract: "Vast", diplomaRequired: "Secundair onderwijs", experienceRequired: "Geen" } },
    10: { summary: "Kinderbegeleider voor een groep van 18 peuters.",
      reasons: ["Kinderopvang ligt dicht bij jeugdwerk."],
      gaps: ["Andere doelgroep."],
      fields: { sector: "Kinderopvang", hours: "Deeltijds", contract: "Vast", diplomaRequired: "Secundair + diploma kinderzorg", experienceRequired: "Geen" } },
  };
  /** Applies the Dutch AI text when the app language is Dutch. */
  const localized = (v: VacancyDetail): VacancyDetail => {
    const o = settings.outputLanguage === "nl" ? aiNl[v.id] : undefined;
    if (!o) return v;
    return {
      ...v,
      fields: v.fields ? { ...v.fields, ...(o.fields ?? {}), summary: o.summary ?? v.fields.summary } : v.fields,
      scoreResult: v.scoreResult ? { ...v.scoreResult, reasons: o.reasons ?? v.scoreResult.reasons, gaps: o.gaps ?? v.scoreResult.gaps, knockoutReason: o.ko ?? v.scoreResult.knockoutReason } : v.scoreResult,
    };
  };

  let profile: Profile = {
    markdown: `# Sam Peeters\n**Headline:** Maatschappelijk werker | Buurtgerichte zorg | Gent\n\n## Samenvatting\nGemotiveerd maatschappelijk werker met vier jaar ervaring in lokale sociale dienstverlening en thuislozenzorg. Sterk in onthaal, casemanagement en samenwerking met partners.\n\n## Ervaring\n- **Maatschappelijk werker**, OCMW Gent (2022 - heden)\n  - Onthaal en opvolging van hulpvragen\n  - Samenwerking met CAW en eerstelijnszorg\n- **Stagiair**, CAW Oost-Vlaanderen (2021)\n\n## Opleiding\n- Bachelor Sociaal Werk, Hogeschool Gent (2018 - 2021)\n\n## Vaardigheden\nCasemanagement, motiverende gespreksvoering, Nederlands (moedertaal), Engels (C1), Frans (B1)\n`,
    preferences: { ...DEFAULT_PREFERENCES, homeLocation: "Gent", maxCommute: "max. 45 min met de trein of 40 km", regions: "Oost-Vlaanderen, West-Vlaanderen, Brussel", hours: "fulltime", contractTypes: ["permanent"], desiredRoles: "Maatschappelijk werker, begeleider, coordinator welzijn", ambitions: "Binnen 5 jaar doorgroeien naar coördinatie.", dealBreakers: "Regelmatige nachtdiensten.", salaryNotes: "B1-B3 of gelijkwaardig", includeKeywords: [], excludeKeywords: ["poetsvrouw", "chauffeur"] },
    version: 4, importedFrom: "linkedin_zip", updatedAt: ago(2 * D),
    homeGeo: { label: "Gent, Oost-Vlaanderen, BE", lat: 51.054, lon: 3.717 }, homeGeoError: null,
  };
  let orsKey: string | null = "5b3ce3597851110001cf6248…";
  let settings: Settings = { ...DEFAULT_SETTINGS };
  let keyConfigured = true;
  let scanning = false;
  let currentSourceId: number | null = null;

  const log: LogEntry[] = [
    [0.3, 2, "info", "scan.finished|18|3|3"], [0.31, 2, "info", "mock.log.scored|3|claude-opus-5-5|$0.048"], [0.4, 1, "info", "scan.finished|20|2|2"],
    [0.5, 1, "info", "scan.started"], [5, 3, "warn", "mock.log.noItems"], [5.1, 4, "error", "mock.log.scanFailed"],
    [5.2, 4, "warn", "mock.log.robots"], [6, null, "info", "mock.log.appStarted"], [29, 1, "info", "mock.log.learned"], [30, 2, "info", "scan.finished|18|18|18"],
  ].map((r, i) => ({ id: 100 - i, at: ago((r[0] as number) * H), sourceId: r[1] as number | null, level: r[2] as LogEntry["level"], message: r[3] as string }));
  /** Log messages are stored as keys and rendered in the current language when listed. */
  const logMessage = (m: string): string => {
    const [key, ...a] = m.split("|");
    switch (key) {
      case "scan.finished": return t("scan.finished", { found: a[0], fresh: a[1], scored: a[2] });
      case "mock.log.scored": return t("mock.log.scored", { count: a[0], model: a[1], cost: formatUsd(settings.outputLanguage, 0.048) });
      case "mock.log.scanFailed": return t("mock.log.scanFailed", { error: t("mock.caw.error") });
      case "mock.log.robots": return t("mock.log.robots", { path: "/jobs/?caw-type=job" });
      case "mock.log.learned": return t("mock.log.learned", { name: "VDAB", selector: "li.c-vacature", count: 20 });
      default: return t(key as Parameters<typeof t>[0]);
    }
  };
  /** Fake stored texts ("@name") that the real backend would have written in the language of the day. */
  const stored = (m: string | null): string | null => {
    if (m === "@caw") return t("mock.caw.error");
    if (m === "@poets") return t("prefilter.excluded", { keyword: "poets" });
    if (m === "@503") return t("fetch.http", { status: 503, url: "https://example.org/vacature/11" });
    return m;
  };

  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emit = <E extends keyof RadarEvents>(e: E, p: RadarEvents[E]) => listeners.get(e)?.forEach((cb) => cb(p));
  const status = (): AppStatus => ({ scanning, currentSourceId, queueLength: scanning ? 1 : 0, nextScanAt: new Date(Date.now() + 2.5 * H).toISOString(), apiKeyConfigured: keyConfigured, budgetExceeded: false, profileReady: profile.markdown.trim() !== "", travelConfigured: orsKey !== null && profile.homeGeo !== null });

  const toItem = (v: VacancyDetail): VacancyListItem => {
    const { geoQuery, geoLabel, geoError, description, snippet, fields, scoreResult, scoreModel, scoredAt, scoreError, prefilterReason, feedbackNote, duplicates, lastSeenAt, ...rest } = v;
    void geoQuery; void geoLabel; void geoError; void description; void snippet; void fields; void scoreResult; void scoreModel; void scoredAt; void scoreError; void prefilterReason; void feedbackNote; void duplicates; void lastSeenAt;
    return rest;
  };
  const listFilter = (f: VacancyFilter) => {
    const q = f.search.toLowerCase();
    return vacancies
      .filter((v) => (f.statuses.length ? f.statuses.includes(v.status) : v.status !== "closed" && v.status !== "dismissed"))
      .filter((v) => f.minScore == null || (v.score ?? -1) >= f.minScore)
      .filter((v) => f.sourceId == null || v.sourceId === f.sourceId)
      .filter((v) => !q || `${v.title} ${v.organization} ${v.location}`.toLowerCase().includes(q))
      .filter((v) => f.includeUnscored || v.score != null)
      .filter((v) => f.maxTravelMinutes == null || v.travelMinutes == null || v.travelMinutes <= f.maxTravelMinutes)
      .sort((a, b) =>
        f.sort === "score" ? (b.score ?? -1) - (a.score ?? -1)
        : f.sort === "distance" ? (a.travelMinutes ?? Infinity) - (b.travelMinutes ?? Infinity) || (b.score ?? -1) - (a.score ?? -1)
        : Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt))
      .map(toItem);
  };

  const testItems = [
    ["Maatschappelijk werker", "OCMW Lendelede", "Lendelede"], ["Begeleider jeugdhulp", "Vzw Jeugdzorg Emmaüs", "Gent"], ["Sociaal-cultureel werker", "GC De Linde", "Zwevegem"],
    ["Diensthoofd welzijn", "Lokaal bestuur Deinze", "Deinze"], ["Wijkwerker", "Samenlevingsopbouw Gent", "Gent"], ["Psychologisch consulent", "CGG Ahasverus", "Brussel"],
  ].map(([title, organization, location], i) => ({ title, organization, location, url: `https://www.vvsg.be/vacatures/${i + 100}-${title.toLowerCase().replace(/\W+/g, "-")}`, dateText: "", snippet: "" }));

  let nextId = 50;
  const api: RadarApi = {
    "sources.list": () => sources.map((s) => ({ ...s, lastError: stored(s.lastError) })),
    "sources.create": (input) => { const s: Source = { ...src(nextId++, input.name, input.url, input.renderMode, null, null, "never", 0, 0), ...input, lastScanAt: null, lastSuccessAt: null }; sources.push(s); emit("sources.changed", {}); return s; },
    "sources.update": (id, patch) => { const s = sources.find((x) => x.id === id)!; Object.assign(s, patch); emit("sources.changed", {}); return { ...s }; },
    "sources.delete": (id) => { sources.splice(sources.findIndex((x) => x.id === id), 1); emit("sources.changed", {}); },
    "sources.test": async (input) => {
      await sleep(800);
      const modeUsed = input.renderMode === "browser" ? "browser" : "static";
      if (/fiolavzw\.be/i.test(input.url)) {
        const hint = t("diag.portal", { name: "Jobtoolz", host: "fiola-vzw.jobtoolz.com", url: "https://fiola-vzw.jobtoolz.com/nl" });
        const r: SourceTestResult = {
          ok: false, error: hint, modeUsed, strategy: null, recipe: null, items: [], robotsAllowed: true, llmCostUsd: 0,
          diagnostics: {
            modeUsed, visibleTextChars: 3150, linkCount: 41, frames: [], embeddedHosts: [], llmUsed: false, hint,
            portals: [{ name: "Jobtoolz", host: "fiola-vzw.jobtoolz.com", sampleUrl: "https://fiola-vzw.jobtoolz.com/nl/begeleider-inclusieve-kinderopvang-fie-ola-herzele", kind: "link", companySpecific: true, rootUrl: "https://fiola-vzw.jobtoolz.com/nl" }],
          },
        };
        return r;
      }
      if (/zorgneticuro/i.test(input.url)) {
        const hint = modeUsed === "static" ? t("diag.scriptStatic", { name: "Jobat" }) : t("diag.scriptBrowser", { name: "Jobat" });
        const r: SourceTestResult = {
          ok: false, error: hint, modeUsed, strategy: null, recipe: null, items: [], robotsAllowed: true, llmCostUsd: 0,
          diagnostics: {
            modeUsed, visibleTextChars: 4812, linkCount: 63, embeddedHosts: ["www.jobat.be"], portals: [{ name: "Jobat", host: "www.jobat.be", sampleUrl: "https://www.jobat.be/nl/widget", kind: "script", companySpecific: false, rootUrl: "https://www.jobat.be/nl" }], llmUsed: false, hint,
            frames: modeUsed === "browser" ? [{ url: "https://www.jobat.be/api/widget", included: true }, { url: "https://www.googletagmanager.com/ns.html", included: false }] : [],
          },
        };
        return r;
      }
      const r: SourceTestResult = {
        ok: true, error: null, modeUsed, strategy: "jsonld", recipe: null, items: testItems, robotsAllowed: true, llmCostUsd: 0,
        diagnostics: { modeUsed, visibleTextChars: 9120, linkCount: 118, frames: [], embeddedHosts: [], portals: [], llmUsed: false, hint: null },
      };
      return r;
    },
    "sources.resetRecipe": (id) => { const s = sources.find((x) => x.id === id)!; s.strategy = null; s.recipe = null; emit("sources.changed", {}); return { ...s }; },
    "scan.now": (sourceId) => { scanning = true; currentSourceId = sourceId ?? 2; emit("app.status", status()); setTimeout(() => { scanning = false; currentSourceId = null; emit("app.status", status()); emit("vacancies.changed", { newIds: [] }); }, 2500); },
    "vacancies.list": (f) => listFilter(f),
    "vacancies.get": (id) => { const v = vacancies.find((x) => x.id === id); if (!v) return null; if (v.status === "new") v.status = "seen"; const out = JSON.parse(JSON.stringify(localized(v))) as VacancyDetail; out.prefilterReason = stored(out.prefilterReason); out.scoreError = stored(out.scoreError); return out; },
    "vacancies.setStatus": (id, st) => { vacancies.find((x) => x.id === id)!.status = st; emit("vacancies.changed", { newIds: [] }); },
    "vacancies.setFeedback": (id, fb, note) => { const v = vacancies.find((x) => x.id === id)!; v.feedback = fb; v.feedbackNote = note; emit("vacancies.changed", { newIds: [] }); },
    "vacancies.rescore": async (id) => { await sleep(900); const v = vacancies.find((x) => x.id === id)!; if (v.score == null) { v.score = 52; v.bucket = "possible"; v.scoreState = "scored"; v.scoreResult = { score: 52, bucket: "possible", subscores: { diploma: 70, experience: 45, skills: 50, preferences: 40 }, reasons: [t("mock.rescore.reason")], gaps: [t("mock.rescore.gap")], knockoutReason: "", confidence: "low" }; v.scoreModel = "claude-opus-5-5"; v.scoredAt = new Date().toISOString(); } emit("vacancies.changed", { newIds: [] }); },
    "vacancies.openExternal": () => {},
    "vacancies.counts": () => ({ new: vacancies.filter((v) => v.status === "new").length, interested: vacancies.filter((v) => v.status === "interested").length, applied: vacancies.filter((v) => v.status === "applied").length, strongNew: vacancies.filter((v) => v.status === "new" && v.bucket === "strong").length, total: vacancies.length }),
    "profile.get": () => ({ ...profile }),
    "profile.save": (input) => {
      profile = { ...profile, ...input, version: profile.version + 1, updatedAt: new Date().toISOString() };
      const home = profile.preferences.homeLocation.trim();
      profile.homeGeo = home && !/^x/i.test(home) ? { label: `${home}, Oost-Vlaanderen, BE`, lat: 51, lon: 3.7 } : null;
      profile.homeGeoError = home && !profile.homeGeo ? t("geo.homeNotFound", { query: home }) : null;
      emit("app.status", status());
      return { ...profile };
    },
    "profile.import": async () => { await sleep(900); profile = { ...profile, importedFrom: "linkedin_zip", version: profile.version + 1, updatedAt: new Date().toISOString() }; return { ...profile }; },
    "settings.get": () => ({ ...settings }),
    "settings.save": (patch) => { const lang = settings.outputLanguage; settings = { ...settings, ...patch }; if (settings.outputLanguage !== lang) emit("vacancies.changed", { newIds: [] }); return { ...settings }; },
    "apiKey.status": () => ({ configured: keyConfigured, masked: keyConfigured ? "sk-ant-…x7Qd" : null }),
    "apiKey.set": async (k) => { await sleep(500); if (!k.startsWith("sk-")) return { ok: false, error: t("llm.invalidKey") }; keyConfigured = true; emit("app.status", status()); return { ok: true, error: null }; },
    "apiKey.clear": () => { keyConfigured = false; emit("app.status", status()); },
    "orsKey.status": () => ({ configured: orsKey !== null, masked: orsKey ? "5b3ce3…f6248" : null }),
    "orsKey.set": async (k) => { await sleep(600); if (k.trim().length < 20) return { ok: false, error: t("service.invalidOrsKey") }; orsKey = k; emit("app.status", status()); return { ok: true, error: null }; },
    "orsKey.clear": () => { orsKey = null; emit("app.status", status()); },
    "travel.recompute": async () => { await sleep(1500); return { updated: vacancies.filter((v) => v.geoState === "ok" || v.geoState === "approximate").length, failed: vacancies.filter((v) => v.geoState === "not_found").length }; },
    "usage.summary": (): UsageSummary => ({
      monthUsd: 1.846, budgetUsd: settings.monthlyBudgetUsd, budgetExceeded: false,
      byPurpose: [{ purpose: "score", usd: 1.52, calls: 61 }, { purpose: "learn_recipe", usd: 0.21, calls: 3 }, { purpose: "extract_listing", usd: 0.09, calls: 4 }, { purpose: "profile_import", usd: 0.026, calls: 1 }],
      cache: { readTokens: 118_400, writeTokens: 3_300, uncachedInputTokens: 24_700, hitShare: 118_400 / (118_400 + 3_300 + 24_700), savedUsd: 1.12 },
      last30Days: Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.now() - (29 - i) * D).toISOString().slice(0, 10), usd: i % 5 === 0 ? 0 : 0.02 + ((i * 37) % 11) / 60 })),
    }),
    "log.list": (limit) => log.slice(0, limit).map((l) => ({ ...l, message: logMessage(l.message) })),
    "app.status": () => status(),
  };

  const bridge: RadarBridge = {
    async invoke(method, ...args) {
      await sleep(30);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (api[method] as any)(...args);
    },
    on(event, cb) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(cb as (p: unknown) => void);
      return () => set!.delete(cb as (p: unknown) => void);
    },
  };
  (window as unknown as { radar: RadarBridge }).radar = bridge;
}
