import { extractMainText } from "./html";
import { findJobPostings } from "./jsonld";

export interface DetailResult {
  text: string;
  organization: string;
  location: string;
  datePosted: string;
  validThrough: string;
}

export function extractDetail(html: string, _url: string): DetailResult {
  const posting = findJobPostings(html).find((p) => p.title || p.description);
  if (!posting) {
    return { text: extractMainText(html), organization: "", location: "", datePosted: "", validThrough: "" };
  }
  const lines: string[] = [];
  if (posting.title) lines.push(`Title: ${posting.title}`);
  if (posting.organization) lines.push(`Organization: ${posting.organization}`);
  if (posting.location) lines.push(`Location: ${posting.location}`);
  if (posting.employmentType) lines.push(`Employment type: ${posting.employmentType}`);
  if (posting.datePosted) lines.push(`Date posted: ${posting.datePosted}`);
  if (posting.validThrough) lines.push(`Valid through: ${posting.validThrough}`);
  if (posting.description) lines.push("", posting.description);
  let text = lines.join("\n");
  if (posting.description.length < 500) {
    const main = extractMainText(html);
    if (main) text += "\n\n" + main;
  }
  return {
    text,
    organization: posting.organization,
    location: posting.location,
    datePosted: posting.datePosted,
    validThrough: posting.validThrough,
  };
}
