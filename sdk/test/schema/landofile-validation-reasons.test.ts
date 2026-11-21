import { expect, test } from "bun:test";
import { LandofileAuthoringFragment, LandofileShape, validationIssuesFromCause } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

test.each([
  [{ environment: ["FOO"] }, ["environment", 0], "environment.bare-entry"],
  [{ environment: { "": "value" } }, ["environment", ""], "environment.empty-name"],
  [{ environment: { ["__proto__"]: "value" } }, ["environment", "__proto__"], "environment.reserved-name"],
  [{ environment: { FOO: null } }, ["environment", "FOO"], "environment.null-value"],
  [{ build: { dockerfileInline: "FROM alpine" } }, ["build", "dockerfileInline"], "build.unsupported-key"],
  [{ build: { context: ".", app: "echo ok" } }, ["build"], "build.mixed-families"],
  [
    { build: { dockerfile: "Dockerfile", dockerfile_inline: "FROM alpine" } },
    ["build"],
    "build.dockerfile-conflict",
  ],
  [{ build: {} }, ["build"], "build.empty"],
] as const)("projects %j as one classified issue in both validation roles", (service, path, reason) => {
  const input = { name: "diagnostic-reasons", services: { web: service } };
  const options = { errors: "all", onExcessProperty: "error" } as const;
  const decoded: readonly Result.Result<unknown, Schema.SchemaError>[] = [
    Schema.decodeUnknownResult(LandofileAuthoringFragment)(input, options),
    Schema.decodeUnknownResult(LandofileShape)(input, options),
  ];
  for (const result of decoded) {
    if (Result.isSuccess(result)) throw new Error("Expected an invalid Landofile");
    expect(validationIssuesFromCause(result.failure, { input })).toEqual([
      expect.objectContaining({ path: ["services", "web", ...path], reason }),
    ]);
  }
});
