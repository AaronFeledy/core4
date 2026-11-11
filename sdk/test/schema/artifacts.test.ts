import { expect, test } from "bun:test";
import { ArtifactBuildSpec, ArtifactRef } from "@lando/sdk/schema";
import { Schema } from "effect";

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

test("ArtifactRef carries only build provenance", () => {
  const decode = Schema.decodeUnknownSync(ArtifactRef);
  // A produced image keeps its provenance through a round trip; a legacy ref has none.
  expect(decode({ kind: "ref", ref: "lando-build-web", origin: "build" }).origin).toBe("build");
  expect(decode({ kind: "ref", ref: "nginx:1.27" }).origin).toBeUndefined();
  expect(() => decode({ kind: "ref", ref: "nginx:1.27", origin: "registry" })).toThrow();
});
