import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import capture from "./fixtures/x-extension-authoring-projection.delta.json";
import {
  REVIEWED_COMPOSITE_EXPRESSION_PATTERN,
  REVIEWED_WHOLE_EXPRESSION_PATTERN,
  authoringProjectionBytes,
} from "./x-extension-authoring-projection-proof.ts";

test("pins the independently produced authoring delta and its source provenance", () => {
  const digest = createHash("sha256").update(authoringProjectionBytes).digest("hex");
  expect(digest).toBe("64c8684615b18cd022ef0997b4d60a8aa742205c1e1d461d178afd1ea79d530c");
  expect(capture.sha256).toBe(digest);
  expect(capture.provenance).toEqual({
    commit: "15e5119094f0d10f0af967a42880a0b881d621a8",
    sdkTree: "87abecf0ef3d6e70824ee9f554f38ef1923c430f",
    expressionBefore: "2230dc6577e5918115a831612fe1e974aec54d4d",
    expressionAfter: "d75c3c03228cf9264613b26a27605d1a401071d4",
    nativeInit: "6e0864cc0ce187aa16193b489da9a7e1219b4e3f",
  });
});

test("the reviewed expression branches reject plain or comment-only text", () => {
  const whole = new RegExp(REVIEWED_WHOLE_EXPRESSION_PATTERN);
  const composite = new RegExp(REVIEWED_COMPOSITE_EXPRESSION_PATTERN);
  for (const value of ["plain", "", "{{# comment #}}", "{{# a #}}{{# b #}}"])
    expect([whole.test(value), composite.test(value)]).toEqual([false, false]);
  for (const value of ["{{ env.VALUE }}", "{{- env.VALUE -}}"])
    expect([whole.test(value), composite.test(value)]).toEqual([true, true]);
  for (const value of ["prefix {{ env.VALUE }}", "$VALUE", "${secret:token}", "{{# a #}}$VALUE"])
    expect([whole.test(value), composite.test(value)]).toEqual([false, true]);
});
