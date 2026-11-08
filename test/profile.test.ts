import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { LlmClient, TextRequest } from "../src/core/llm/client";
import { linkedinPdfToMarkdown } from "../src/core/profile/linkedin-pdf";
import { linkedinZipToMarkdown } from "../src/core/profile/linkedin-zip";
import { DEFAULT_SETTINGS } from "../src/shared/types";

function makeZip(files: Record<string, string>): Uint8Array {
  const o: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) o[k] = strToU8(v);
  return zipSync(o);
}

const PROFILE = `First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers
Jane,Peeters,,,,Maatschappelijk werker,"Ervaren in jeugdhulp, graag mensgericht.",Hospitals and Health Care,9000,"Gent, Vlaanderen, Belgie",,,
`;
const POSITIONS = `Company Name,Title,Description,Location,Started On,Finished On
OCMW Gent,Maatschappelijk werker,"Begeleiding van cliënten.
- Huisbezoeken
- Dossierbeheer",Gent,Jan 2019,
Jeugdhulp vzw,Begeleider,"Groepswerking, met jongeren",Brugge,Sep 2016,Dec 2018
`;
const SKILLS = `Name
Casemanagement
Motiverende gespreksvoering
`;
const CONNECTIONS = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing, due to privacy settings."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Bob,Jansen,https://linkedin.com/in/bob,,Acme,Dev,01 Jan 2020
`;

describe("linkedinZipToMarkdown", () => {
  const zip = makeZip({
    "Profile.csv": PROFILE,
    "Positions.csv": POSITIONS,
    "Skills.csv": SKILLS,
    "Connections.csv": CONNECTIONS,
    "messages.csv": "a,b,c\n1,2,3\n",
  });
  const md = linkedinZipToMarkdown(zip);

  it("renders the profile with known keys first", () => {
    expect(md).toContain("Jane");
    expect(md).toContain("Headline: Maatschappelijk werker");
    expect(md.indexOf("First Name")).toBeLessThan(md.indexOf("Headline"));
    expect(md.indexOf("Headline")).toBeLessThan(md.indexOf("Summary"));
    expect(md).toContain("Geo Location: Gent, Vlaanderen, Belgie");
    expect(md).not.toContain("Maiden Name");
  });

  it("renders positions including the multi-line description", () => {
    expect(md).toContain("OCMW Gent");
    expect(md).toContain("Huisbezoeken");
    expect(md).toContain("Dossierbeheer");
    expect(md).toContain("Jeugdhulp vzw");
    expect(md).toContain("Jan 2019");
    expect(md.indexOf("Maatschappelijk werker at OCMW Gent")).toBeLessThan(md.indexOf("Begeleider at Jeugdhulp vzw"));
  });

  it("renders skills", () => {
    expect(md).toContain("Casemanagement, Motiverende gespreksvoering");
  });

  it("ignores irrelevant files", () => {
    expect(md).not.toContain("Bob");
    expect(md).not.toContain("Acme");
  });

  it("matches files by basename, case-insensitively, inside folders", () => {
    const m = linkedinZipToMarkdown(makeZip({ "export/skills.CSV": SKILLS }));
    expect(m).toContain("Casemanagement");
  });

  it("skips a Notes: preamble in a recognised file", () => {
    const m = linkedinZipToMarkdown(makeZip({ "Skills.csv": 'Notes:\n"Some, note, with commas"\n\nName,Level\nZorg,3\n' }));
    expect(m).toContain("Zorg");
  });

  it("renders unknown columns generically", () => {
    const m = linkedinZipToMarkdown(makeZip({ "Positions.csv": "Title,Company Name,Weird Column\nDev,Acme,hello\n" }));
    expect(m).toContain("Weird Column: hello");
  });

  it("throws a clear error when nothing is recognised", () => {
    expect(() => linkedinZipToMarkdown(makeZip({ "Connections.csv": CONNECTIONS }))).toThrow(/No LinkedIn profile data/);
    expect(() => linkedinZipToMarkdown(new Uint8Array([1, 2, 3]))).toThrow(/zip/);
  });
});

describe("linkedinPdfToMarkdown", () => {
  it("sends a document block before the instruction using the utility model", async () => {
    let seen: TextRequest | null = null;
    const llm: LlmClient = {
      async structured() {
        throw new Error("unused");
      },
      async text(req) {
        seen = req;
        return { text: "\n# Headline\nX\n", usage: { model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } };
      },
    };
    const md = await linkedinPdfToMarkdown(llm, DEFAULT_SETTINGS, new Uint8Array([37, 80, 68, 70]));
    expect(md).toBe("# Headline\nX");
    const req = seen as unknown as TextRequest;
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.maxTokens).toBe(8000);
    expect(req.purpose).toBe("profile_import");
    const blocks = req.user as { type: string; source?: { data: string; media_type: string } }[];
    expect(blocks[0].type).toBe("document");
    expect(blocks[0].source?.media_type).toBe("application/pdf");
    expect(blocks[0].source?.data).toBe(Buffer.from([37, 80, 68, 70]).toString("base64"));
    expect(blocks[1].type).toBe("text");
  });
});
