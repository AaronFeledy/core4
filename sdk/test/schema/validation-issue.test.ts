import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";

import {
  LandofileShape,
  formatValidationIssueLine,
  suggestionForUnknownKey,
  validationIssuesFromSchemaIssue,
} from "@lando/sdk/schema";

const authoredDecode = { onExcessProperty: "error", errors: "all" } as const;

describe("validation issues", () => {
  test("suggests image for imgae and stays silent past distance 2", () => {
    expect(suggestionForUnknownKey("imgae", ["image", "type"])).toBe('Did you mean "image"?');
    expect(suggestionForUnknownKey("zzzzzz", ["image", "type"])).toBeUndefined();
  });

  test("matches Standard Schema paths and messages for the same decode options", () => {
    const input = {
      name: "demo",
      services: { web: { imgae: "nginx", type: 1, image: "nginx" } },
    };
    const decoded = Schema.decodeUnknownResult(LandofileShape)(input, authoredDecode);
    if (!Result.isFailure(decoded)) throw new Error("expected schema failure");
    const standard = Schema.toStandardSchemaV1(LandofileShape.annotate({}), { parseOptions: authoredDecode });
    const validated = standard["~standard"].validate(input);
    if (validated instanceof Promise) throw new Error("expected a synchronous Standard Schema result");
    if (!("issues" in validated) || validated.issues === undefined)
      throw new Error("expected Standard Schema issues");

    const ours = validationIssuesFromSchemaIssue(decoded.failure.issue);
    expect(ours.map(({ path, message }) => ({ path, message }))).toEqual(
      validated.issues.map((issue) => ({
        path: (issue.path ?? []).map((segment) => (typeof segment === "number" ? segment : String(segment))),
        message: issue.message,
      })),
    );
    const image = ours.find((issue) => issue.path.at(-1) === "imgae");
    expect(image?.suggestion).toBe('Did you mean "image"?');
    expect(formatValidationIssueLine(image ?? { path: [], message: "" })).toContain("services.web.imgae:");
  });
});
