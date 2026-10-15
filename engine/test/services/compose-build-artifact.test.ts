import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { BuildArgSecretReferenceError } from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";

import {
  buildArgSecretReferenceError,
  buildArgSecretReferenceErrors,
  composeBuildToArtifact,
  firstBuildArgSecretReferenceError,
} from "../../src/services/compose-build-artifact.ts";

describe("build arg secret references", () => {
  test("composeBuildToArtifact copies literal args and does not resolve them", () => {
    const artifact = composeBuildToArtifact(
      { context: ".", args: { TOKEN: "${secret:TOKEN}" } },
      "/srv/project",
    );

    expect(artifact.args).toEqual({ TOKEN: "${secret:TOKEN}" });
  });

  test("rejects an exact or embedded ${secret:...} in a build arg", () => {
    const exact = buildArgSecretReferenceError("web", "TOKEN", "${secret:TOKEN}");
    const embedded = firstBuildArgSecretReferenceError("web", {
      NODE_ENV: "production",
      TOKEN: "prefix-${secret:TOKEN}",
    });

    expect(exact).toBeInstanceOf(BuildArgSecretReferenceError);
    expect(exact).toMatchObject({
      _tag: "BuildArgSecretReferenceError",
      service: "web",
      arg: "TOKEN",
      reference: "${secret:TOKEN}",
    });
    expect(embedded).toMatchObject({
      _tag: "BuildArgSecretReferenceError",
      arg: "TOKEN",
      reference: "${secret:TOKEN}",
    });
    expect(firstBuildArgSecretReferenceError("web", { NODE_ENV: "production" })).toBeUndefined();
  });

  test("collects every secret-bearing build arg on a landofile", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "secret-args",
      runtime: 4,
      services: {
        web: {
          home: false,
          image: "alpine:3",
          build: { context: ".", args: { TOKEN: "${secret:TOKEN}", OTHER: "prefix-${secret:OTHER}" } },
        },
        ok: {
          home: false,
          image: "alpine:3",
          build: { context: ".", args: { NODE_ENV: "production" } },
        },
      },
    });

    expect(buildArgSecretReferenceErrors(landofile)).toMatchObject([
      { service: "web", arg: "TOKEN", reference: "${secret:TOKEN}" },
      { service: "web", arg: "OTHER", reference: "${secret:OTHER}" },
    ]);
  });
});
