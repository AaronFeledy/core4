import { describe, expect, test } from "bun:test";

import {
  publicTranscriptRelativePath,
  publicTranscriptSuffixFromVariantString,
  publicTranscriptVariantSuffix,
} from "../../../scripts/build-guide-scenarios.ts";

describe("build-guide-scenarios public transcript helpers", () => {
  test("publicTranscriptVariantSuffix maps guide variants to the public transcript suffix", () => {
    expect(publicTranscriptVariantSuffix(undefined)).toBe("");
    expect(publicTranscriptVariantSuffix({ pairs: [{ axis: "php", value: "8.3" }] })).toBe(".8.3");
    expect(
      publicTranscriptVariantSuffix({
        pairs: [
          { axis: "php", value: "8.3" },
          { axis: "db", value: "mysql" },
        ],
      }),
    ).toBe(".8.3.mysql");
  });

  test("publicTranscriptRelativePath builds the expected transcript path", () => {
    expect(publicTranscriptRelativePath("php", "happy-path", undefined)).toBe(
      "dist/transcripts/public/guides/php/happy-path.json",
    );
    expect(
      publicTranscriptRelativePath("svc", "s1", {
        pairs: [
          { axis: "a", value: "x" },
          { axis: "b", value: "y" },
        ],
      }),
    ).toBe("dist/transcripts/public/guides/svc/s1.x.y.json");
  });

  test("publicTranscriptSuffixFromVariantString maps a variant string to the public transcript suffix", () => {
    expect(publicTranscriptSuffixFromVariantString("")).toBe("");
    expect(publicTranscriptSuffixFromVariantString("php=8.3")).toBe(".8.3");
    expect(publicTranscriptSuffixFromVariantString("php=8.3 db=mysql")).toBe(".8.3.mysql");
  });
});
