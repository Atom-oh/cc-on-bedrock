import { describe, expect, it } from "vitest";
import { ccdashLinks } from "../ccdash";

describe("ccdashLinks", () => {
  it("strips the trailing slash and derives the collector link", () => {
    expect(ccdashLinks("https://ccdash.example.com/")).toEqual({
      home: "https://ccdash.example.com",
      collector: "https://ccdash.example.com/collector",
    });
  });

  it("keeps a path prefix", () => {
    expect(ccdashLinks("https://example.com/ccdash")).toEqual({
      home: "https://example.com/ccdash",
      collector: "https://example.com/ccdash/collector",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(ccdashLinks("  https://ccdash.example.com ")?.home).toBe("https://ccdash.example.com");
  });

  it("returns null for empty, blank, undefined, non-https or host-less values", () => {
    expect(ccdashLinks("")).toBeNull();
    expect(ccdashLinks("   ")).toBeNull();
    expect(ccdashLinks(undefined)).toBeNull();
    expect(ccdashLinks("http://x")).toBeNull();
    expect(ccdashLinks("https://")).toBeNull();
    expect(ccdashLinks("ccdash.example.com")).toBeNull();
  });
});
