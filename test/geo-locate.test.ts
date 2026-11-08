import { describe, expect, it } from "vitest";
import { classifyHit, locationQuery } from "../src/core/geo/locate";

const q = (location: string, organization = "") => locationQuery({ location, organization });

describe("locationQuery", () => {
  it("title-cases uppercase-only locations", () => {
    expect(q("LENDELEDE")).toEqual({ query: "Lendelede", fromOrganization: false });
    expect(q("SINT-NIKLAAS")).toEqual({ query: "Sint-Niklaas", fromOrganization: false });
  });

  it("strips Provincie/Regio/Arrondissement prefixes", () => {
    expect(q("Provincie Oost-Vlaanderen")).toEqual({ query: "Oost-Vlaanderen", fromOrganization: false });
    expect(q("Regio Gent")?.query).toBe("Gent");
    expect(q("Arrondissement Aalst")?.query).toBe("Aalst");
  });

  it("drops parenthesised text", () => {
    expect(q("Gent (Sint-Amandsberg)")?.query).toBe("Gent");
    expect(q("Brugge (hybride) ")?.query).toBe("Brugge");
  });

  it("prefers the location over the organization", () => {
    expect(q("Gent", "Stad Nieuwpoort - Nieuwpoort")).toEqual({ query: "Gent", fromOrganization: false });
  });

  it("derives from public-body organizations when the location is empty", () => {
    expect(q("", "Lokaal bestuur Aalst")).toEqual({ query: "Aalst", fromOrganization: true });
    expect(q("", "Stad Nieuwpoort - Nieuwpoort")).toEqual({ query: "Nieuwpoort", fromOrganization: true });
    expect(q("", "VGC - Brussel")).toEqual({ query: "Brussel", fromOrganization: true });
    expect(q("", "OCMW Sint-Niklaas")?.query).toBe("Sint-Niklaas");
    expect(q("", "Gemeente Lendelede")?.query).toBe("Lendelede");
  });

  it("accepts bare municipality-like organization names", () => {
    expect(q("", "Lennik")).toEqual({ query: "Lennik", fromOrganization: true });
    expect(q("", "Sint-Pieters-Leeuw")?.query).toBe("Sint-Pieters-Leeuw");
    expect(q("", "Ham")?.query).toBe("Ham");
  });

  it("rejects organization names with org-type tokens or digits", () => {
    for (const o of ["Vzw Jeugdzorg Emmaüs", "Zorggroep Zusters", "Huis Perrekes", "CAW Oost-Vlaanderen", "Team 7", "Acme BV"]) {
      expect(q("", o), o).toBeNull();
    }
  });

  it("never derives from other organization names", () => {
    expect(q("", "Vzw Jeugdzorg Emmaüs")).toBeNull();
    expect(q("", "")).toBeNull();
    expect(q("", "Stad")).toBeNull();
    expect(q("", "Stad Sint Maria Hemelvaart Ter Zee Kerk")).toBeNull();
    expect(q("   ", "Caritas Vlaanderen vzw")).toBeNull();
  });
});

describe("classifyHit", () => {
  const hit = (confidence: number, layer: string) => ({ confidence, layer });
  it("rejects missing or low-confidence hits", () => {
    expect(classifyHit(null, false)).toBe("not_found");
    expect(classifyHit(hit(0.59, "locality"), false)).toBe("not_found");
    expect(classifyHit(hit(0.6, "locality"), false)).toBe("ok");
  });
  it("marks region-like layers approximate", () => {
    for (const l of ["region", "macroregion", "county"]) expect(classifyHit(hit(0.9, l), false)).toBe("approximate");
    for (const l of ["address", "street", "venue", "postalcode", "locality", "localadmin"]) {
      expect(classifyHit(hit(0.9, l), false)).toBe("ok");
    }
  });
  it("requires a locality-like layer for organization-derived queries", () => {
    for (const l of ["locality", "localadmin", "borough"]) expect(classifyHit(hit(0.9, l), true)).toBe("ok");
    for (const l of ["venue", "street", "address", "region", "county"]) expect(classifyHit(hit(0.9, l), true)).toBe("not_found");
  });
});
