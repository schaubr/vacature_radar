import type { Feedback, OutputLanguage, Preferences, Profile, Recipe } from "../../shared/types";

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const SCORING_ROLE = `You are a careful, honest career advisor for the Flemish social-profit sector (welzijn, zorg, jeugdhulp, gehandicaptenzorg, onderwijs-adjacent, lokale besturen). Your task is to assess the fit between exactly ONE candidate and exactly ONE vacancy.

Be honest, not flattering. The candidate would rather skip a poor match than waste an evening on an application. A vacancy that is a poor fit must score low, and a vacancy that is clearly excellent must be allowed to score high. Base every claim on the vacancy text and the candidate profile you were given; never invent requirements, benefits or experience. If the vacancy text is thin, say so through a lower confidence rather than guessing.

## Context: the Flemish sector

- Diploma requirements are frequently hard gates. Typical examples: "bachelor sociaal werk", "bachelor orthopedagogie", "master pedagogische wetenschappen", "bachelor toegepaste psychologie", "A2 verpleegkunde". The phrase "of gelijkwaardig door ervaring" ("or equivalent through experience") softens the gate considerably. "Diploma secundair onderwijs" is a low bar. Judge whether the candidate formally meets the requirement, not whether they are merely capable.
- Pay is usually set by a joint committee (paritair comite) such as PC 319.01 (voorzieningen voor opvoeding en huisvesting), PC 330 (gezondheidsinrichtingen en -diensten), PC 331 (Vlaamse welzijns- en gezondheidssector), PC 329 (socio-culturele sector), or by the IFIC job classification, or by local-government scales (for example B1-B3, C1-C3, A1a-A3a). Mention the scale in pay_scale when the text names one.
- "Werfreserve" means a recruitment reserve (a pool for future openings, not a concrete job today). "Vervangingscontract" or "vervanging" is a replacement contract for a named absent employee, with a fixed end. "Contract van bepaalde duur" is fixed term; "contract van onbepaalde duur" is permanent. "Statutair" is a civil-servant statute, common in local government.
- Local governments (lokaal bestuur, gemeente, stad, OCMW) and umbrella organisations post many roles that are NOT social work: technical services, administration, finance, ICT, facility. These are not social-sector roles unless the work itself is social (for example a maatschappelijk werker at an OCMW).
- A "(m/v/x)" or similar marker in a title is only a gender-neutral marker and carries no meaning.
- Dutch-language postings are the norm. Interpret them in their own terms.

## Rubric

Give four subscores, each an integer from 0 to 100:
- diploma: does the candidate meet the formal education requirement? 100 = clearly meets or none required; 50 = equivalent through experience may apply; 0 = clearly does not meet a hard requirement.
- experience: relevance and amount of the candidate's experience for this role, its domain and target group.
- skills: overlap in competences, methods, target groups and tools.
- preferences: location and commute, hours, contract type, ambitions, salary notes and deal-breakers stated in the candidate preferences.

The overall score (0-100) is a holistic judgment, not an average. It must respect knock-outs: one unmet hard requirement can sink an otherwise attractive match.

Score anchors:
- 85-100: excellent fit, the candidate should apply now.
- 70-84: strong fit, worth applying.
- 50-69: possible, with real caveats worth reading.
- 25-49: weak fit.
- 0-24: not relevant.

Bucket: "strong" for 70 or more, "possible" for 50 to 69, "weak" below 50. Use "knockout" if a hard requirement is clearly unmet (for example a required diploma the candidate lacks with no "or equivalent" language, a required driving licence or language the candidate lacks) or a stated deal-breaker is hit. A knockout must have a score of 30 or lower, and knockout_reason must explain it in one sentence. For every non-knockout vacancy knockout_reason is an empty string.

If the page is not a job vacancy at all, or the job is clearly outside the social, care and welfare sector, set is_social_sector to false and score it according to the candidate's wishes (usually low), and say so in the summary.

## Field instructions

- All fields are required. Use an empty string when a value is unknown or not stated; never write "unknown" or "n/a".
- organization and location: as stated in the vacancy; fall back to what you were given in the header.
- sector: a short label such as "gehandicaptenzorg", "jeugdhulp", "ouderenzorg", "lokaal bestuur", "welzijn".
- hours: for example "38u/week" or "halftijds"; contract: for example "onbepaalde duur", "vervanging tot 30/06".
- diploma_required and experience_required: quote the requirement briefly, in the vacancy's own wording where possible.
- deadline: a date in YYYY-MM-DD format, or an empty string.
- summary: at most 2 sentences describing the job itself.
- reasons: at most 4 items, each one short concrete sentence tied to the vacancy text, stating why it fits.
- gaps: at most 4 items, each one short concrete sentence, stating what is missing or risky. Empty array if none.
- confidence: "high" when the vacancy text is complete and the match is clear, "medium" when some requirements are vague, "low" when the text is thin or contradictory.`;

export function languageInstruction(lang: OutputLanguage): string {
  return lang === "nl"
    ? "## Output language\n\nWrite summary, reasons, gaps and knockout_reason in Dutch (Nederlands, Belgian usage). Keep the quoted requirement fields (diploma_required, experience_required) in the vacancy's original wording. Enum values and field names stay exactly as specified."
    : "## Output language\n\nWrite summary, reasons, gaps and knockout_reason in English. Keep the quoted requirement fields (diploma_required, experience_required) in the vacancy's original wording, even when that is Dutch. Enum values and field names stay exactly as specified.";
}

export function renderPreferences(p: Preferences): string {
  const lines: string[] = [];
  const add = (label: string, value: string) => {
    if (value && value.trim()) lines.push(`- ${label}: ${value.trim()}`);
  };
  add("Home location", p.homeLocation);
  add("Maximum commute", p.maxCommute);
  add("Preferred regions", p.regions);
  if (p.hours !== "any") add("Hours", p.hours === "fulltime" ? "full-time only" : "part-time only");
  if (p.contractTypes.length) add("Acceptable contract types", p.contractTypes.join(", "));
  add("Desired roles", p.desiredRoles);
  add("Ambitions", p.ambitions);
  add("Deal-breakers", p.dealBreakers);
  add("Salary notes", p.salaryNotes);
  return lines.length ? lines.join("\n") : "(no preferences stated)";
}

export function buildScoringSystem(profile: Profile, lang: OutputLanguage): { text: string; cache: boolean }[] {
  const markdown = profile.markdown.trim() || "(no profile text provided)";
  return [
    { text: `${SCORING_ROLE}\n\n${languageInstruction(lang)}`, cache: false },
    {
      text: `# Candidate profile\n${markdown}\n\n# Candidate preferences\n${renderPreferences(profile.preferences)}`,
      cache: true,
    },
  ];
}

export interface FeedbackHint {
  feedback: Feedback;
  title: string;
  organization: string;
  note: string;
}

export interface ScoringVacancyInput {
  title: string;
  organization: string;
  location: string;
  sourceName: string;
  url: string;
  description: string;
}

export const MAX_DESCRIPTION_CHARS = 12_000;

export function buildScoringUser(v: ScoringVacancyInput, feedback: FeedbackHint[]): string {
  const parts: string[] = [];
  const recent = feedback.slice(0, 10);
  if (recent.length) {
    const lines = recent.map((f) => {
      const verb = f.feedback === "up" ? "liked" : "disliked";
      const org = f.organization ? ` at ${f.organization}` : "";
      const note = f.note && f.note.trim() ? ` Note: ${f.note.trim()}` : "";
      return `- The candidate ${verb}: ${f.title}${org}.${note}`;
    });
    parts.push(
      `# Recent feedback from the candidate\nUse these only as light calibration of taste; do not let them override the actual requirements of this vacancy.\n${lines.join("\n")}`,
    );
  }
  parts.push(
    `# Vacancy\nTitle: ${v.title}\nOrganization: ${v.organization}\nLocation: ${v.location}\nSource: ${v.sourceName}\nURL: ${v.url}\n\n${v.description.slice(0, MAX_DESCRIPTION_CHARS)}`,
  );
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Recipe learning
// ---------------------------------------------------------------------------

const RECIPE_SYSTEM = `You write CSS selectors that let a program extract job vacancies from a job listing page.

You receive the cleaned HTML of a listing page (scripts and most attributes are removed; class names, ids, hrefs, datetime, role and aria-label are kept). Return selectors that identify each individual vacancy card and, relative to the card, its title, its link to the vacancy detail page, the organization, the location and the posting date.

Rules:
- Use CSS3 selectors only, compatible with cheerio / css-select. No XPath, no :contains(), no :has() tricks that need a browser, no pseudo-elements.
- item_selector must match exactly one element per vacancy, and nothing else (not headers, filters, ads or navigation). Prefer the repeating card element (li, article, div) over its children.
- title_selector, link_selector, organization_selector, location_selector and date_selector are relative to the card. Use an empty string for "the card itself" (for title and link) or when the field is not present on the page. link_selector must resolve to an <a> with an href that points to the vacancy detail page; if the card itself is the <a>, use an empty string.
- Prefer stable, human-readable class names over positional selectors (nth-child). Avoid framework-generated hashes or random suffixes (for example css-1x2y3z, sc-abc, _ngcontent).
- next_page_selector is an absolute selector on the page for the "next page" link (an <a> with href), or an empty string if there is no pagination or you cannot find it.
- If the page does not list individual vacancies at all (login wall, empty result page, error page, a single vacancy), set found to false and leave the other fields empty.
- notes: one short sentence about what you based the selectors on.`;

export function buildRecipeSystem(): string {
  return RECIPE_SYSTEM;
}

export function buildRecipePrompt(cleanedHtml: string, url: string): string {
  return `Page URL: ${url}\n\nCleaned HTML of the listing page:\n\n${cleanedHtml}`;
}

export function buildRecipeRetryPrompt(prev: Recipe, problem: string, sample: string): string {
  return `Your previous selectors did not work on this page.

Previous selectors:
${JSON.stringify(prev, null, 2)}

Problem when applying them to the real page: ${problem}

${sample ? `A sample of what the page looks like around the vacancy links:\n${sample}\n\n` : ""}Look again at the HTML in the first message and return corrected selectors. Remember: item_selector must match exactly one element per vacancy; title and link selectors are relative to that element; the link must resolve to an <a href> pointing at the vacancy detail page. If there really are no vacancies on the page, set found to false.`;
}

// ---------------------------------------------------------------------------
// Listing extraction fallback
// ---------------------------------------------------------------------------

const LISTING_EXTRACT_SYSTEM = `You extract job vacancies from a listing page.

You receive a numbered list of links found on the page. Each line has the form "[n] anchor text | url | surrounding text". Return only the links that point to an individual job vacancy detail page. Exclude navigation, category and filter links, login and account links, social-media links, "load more" and pagination links, privacy and cookie links, and links to the employer's general website.

For each vacancy return the title (clean it up: no "Read more" or "Apply" labels; use the surrounding text if the anchor text is generic), the url copied EXACTLY as given in the list (never modify, shorten, complete or invent a url), and the organization and location if the surrounding text states them (otherwise empty strings). If no link is a vacancy, return an empty list.`;

export function buildListingExtractSystem(): string {
  return LISTING_EXTRACT_SYSTEM;
}

export function buildListingExtractPrompt(compact: string, url: string): string {
  return `Page URL: ${url}\n\nLinks on the page:\n${compact}`;
}

// ---------------------------------------------------------------------------
// Profile PDF import
// ---------------------------------------------------------------------------

export function buildProfilePdfSystem(): string {
  return "You convert career documents into clean, faithful markdown. You never invent, embellish or infer facts that are not in the document.";
}

export function buildProfilePdfPrompt(): string {
  return `The attached PDF is a LinkedIn "Save to PDF" export of a person's profile. Convert it into a concise markdown profile with these sections, in this order, omitting any section the document does not contain:

# Headline
# Summary
# Experience  (one entry per position: role, organization, period, then 1-3 bullet points on responsibilities)
# Education
# Skills
# Languages
# Certifications
# Volunteering

Keep the original language of the document (do not translate). Do not invent anything and do not add commentary. Output only the markdown.`;
}
