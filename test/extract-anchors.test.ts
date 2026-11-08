import { describe, expect, it } from "vitest";
import { compactAnchors } from "../src/core/extract/anchors";
import { fixture, VVSG_URL, JOBSOLUTIONS_URL } from "./helpers";

describe("compactAnchors", () => {
  it("formats numbered lines, skips nav/header/footer, empty text and duplicates", () => {
    const html = `<body><header><a href="/home">Home</a></header><nav><a href="/n">Nav</a></nav>
      <ul><li><a href="/j/1?utm_source=a">Job one</a> <span>Org A, Gent</span></li>
      <li><a href="/j/1">Job one again</a></li><li><a href="/j/2"><img src=x></a></li><li><a href="/j/3">Job three</a></li></ul>
      <footer><a href="/f">Footer</a></footer></body>`;
    const out = compactAnchors(html, "https://x.be/").split("\n");
    expect(out).toEqual([
      "[1] Job one | https://x.be/j/1 | Job one Org A, Gent",
      "[2] Job three | https://x.be/j/3 | Job three",
    ]);
  });
  it("respects max and truncates context to 200 chars", () => {
    const html = `<ul>${Array.from({ length: 10 }, (_, i) => `<li><a href="/j/${i}">Job ${i}</a> ${"x".repeat(500)}</li>`).join("")}</ul>`;
    const lines = compactAnchors(html, "https://x.be/", 3).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0].split(" | ")[2]).toHaveLength(200);
  });
  it("lists the vacancy links of the static fixtures", () => {
    const vvsg = compactAnchors(fixture("vvsg_list.html"), VVSG_URL);
    expect(vvsg).toContain("Teamcoach samenleven | https://www.vvsg.be/vacatures/overzicht-vacatures/lokaal-bestuur-lommel-teamcoach-samenleven");
    expect(compactAnchors(fixture("jobsolutions_list.html"), JOBSOLUTIONS_URL)).toContain("https://www.jobsolutions.be/jobs/18042-");
  });
});
