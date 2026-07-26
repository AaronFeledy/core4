import { expect, test } from "bun:test";

import { Schema } from "effect";

import { ArtifactBuildSpec } from "@lando/sdk/schema";

test("ArtifactBuildSpec accepts specInline", () => {
  const decoded = Schema.decodeUnknownSync(ArtifactBuildSpec)({
    kind: "build",
    context: "/abs/ctx",
    specInline: "FROM alpine:3.20",
  });
  expect(decoded.specInline).toBe("FROM alpine:3.20");
});

test("ArtifactBuildSpec still accepts spec without specInline", () => {
  const decoded = Schema.decodeUnknownSync(ArtifactBuildSpec)({
    kind: "build",
    context: "/abs/ctx",
    spec: "Dockerfile",
  });
  expect(decoded.specInline).toBeUndefined();
});

test("ArtifactBuildSpec rejects spec together with specInline", () => {
  const input = {
    kind: "build",
    context: "/abs/ctx",
    spec: "Dockerfile",
    specInline: "FROM alpine:3.20",
  };

  for (const options of [{}, { onExcessProperty: "error" }] as const) {
    expect(() => Schema.decodeUnknownSync(ArtifactBuildSpec)(input, options)).toThrow();
  }
});
