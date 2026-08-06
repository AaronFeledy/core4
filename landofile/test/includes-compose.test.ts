import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { ComposeKeyRejectedError, LandofileParseError } from "@lando/sdk/errors";
import type { LandofileShape } from "@lando/sdk/schema";

import { composeServiceDispositions } from "../src/compose/dispositions.ts";
import { resolveLandofileIncludes } from "../src/includes.ts";
import { makeTestLandofilePorts } from "./support.ts";

const resolve = (landofile: LandofileShape, appRoot: string) =>
  Effect.runPromise(
    resolveLandofileIncludes({
      landofile,
      appRoot,
      cacheRoot: join(appRoot, ".cache"),
      ports: makeTestLandofilePorts(join(appRoot, ".cache")),
    }),
  );

const reject = (landofile: LandofileShape, appRoot: string) =>
  Effect.runPromise(
    Effect.flip(
      resolveLandofileIncludes({
        landofile,
        appRoot,
        ports: makeTestLandofilePorts(join(appRoot, ".cache")),
      }),
    ),
  ).then((error) => {
    if (error._tag !== "ComposeKeyRejectedError") throw error;
    return error;
  });

describe("Compose include fragments", () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "lando-compose-includes-"));
  });

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  test("rejects a Compose-key violation with the authored fragment source when kind is compose", async () => {
    // Given
    await writeFile(
      join(appRoot, "compose-frag.yml"),
      "services:\n  web:\n    image: nginx\n    container_name: fixed-web\n",
      "utf8",
    );

    // When
    const error = await reject({ includes: [{ source: "./compose-frag.yml", kind: "compose" }] }, appRoot);

    // Then
    expect(error._tag).toBe("ComposeKeyRejectedError");
    expect(error.keyPath).toBe("container_name");
    expect(error.source).toBe("./compose-frag.yml");
    const remediation = composeServiceDispositions.container_name?.remediation;
    if (remediation === undefined) throw new Error("container_name must declare remediation");
    expect(error.remediation).toBe(remediation);
  });

  test("merges a top-level Compose include when the fragment declares a service", async () => {
    // Given
    await writeFile(join(appRoot, "frag.yml"), "services:\n  cache:\n    type: redis\n", "utf8");

    // When
    const result = await resolve({ include: ["./frag.yml"] }, appRoot);

    // Then
    expect(result).toMatchObject({ services: { cache: { type: "redis" } } });
  });

  test.each(["landofile", "compose"] as const)(
    "resolves YAML anchors and merge keys in a %s include fragment",
    async (kind) => {
      await writeFile(
        join(appRoot, "anchored.yml"),
        [
          "x-service-defaults: &service-defaults",
          "  type: node:22",
          "  environment:",
          "    MODE: included",
          "services:",
          "  web:",
          "    <<: *service-defaults",
        ].join("\n"),
        "utf8",
      );

      const result = await resolve({ includes: [{ source: "./anchored.yml", kind }] }, appRoot);

      expect(result).toMatchObject({
        services: {
          web: { type: "node:22", environment: { MODE: "included" } },
        },
      });
    },
  );

  test.each(["landofile", "compose"] as const)(
    "keeps an unknown alias in a %s include on the parser error surface",
    async (kind) => {
      await writeFile(join(appRoot, "alias-error.yml"), "services:\n  web: *missing\n", "utf8");

      const error = await Effect.runPromise(
        Effect.flip(
          resolveLandofileIncludes({
            landofile: { includes: [{ source: "./alias-error.yml", kind }] },
            appRoot,
            ports: makeTestLandofilePorts(join(appRoot, ".cache")),
          }),
        ),
      );

      expect(error).toBeInstanceOf(LandofileParseError);
      expect(error).not.toBeInstanceOf(ComposeKeyRejectedError);
      expect(error).toMatchObject({ _tag: "LandofileParseError", line: 2, column: 8 });
    },
  );

  test("appends top-level Compose includes after authored includes", async () => {
    // Given
    await writeFile(join(appRoot, "authored.yml"), "services:\n  web:\n    type: node\n", "utf8");
    await writeFile(join(appRoot, "compose.yml"), "services:\n  web:\n    type: nginx\n", "utf8");

    // When
    const result = await resolve({ includes: ["./authored.yml"], include: ["./compose.yml"] }, appRoot);

    // Then
    expect(result).toMatchObject({ services: { web: { type: "nginx" } } });
  });

  test("attributes a rejected key in a top-level Compose include to that fragment", async () => {
    // Given
    await writeFile(
      join(appRoot, "compose.yml"),
      "services:\n  web:\n    image: nginx\n    container_name: fixed-web\n",
      "utf8",
    );

    // When
    const error = await reject({ include: ["./compose.yml"] }, appRoot);

    // Then
    expect(error._tag).toBe("ComposeKeyRejectedError");
    expect(error.keyPath).toBe("container_name");
    expect(error.source).toBe("./compose.yml");
  });

  test("rejects the same key and remediation when kind is landofile", async () => {
    // Given
    await writeFile(
      join(appRoot, "lando-frag.yml"),
      "services:\n  web:\n    type: nginx\n    container_name: fixed-web\n",
      "utf8",
    );

    // When
    const error = await reject({ includes: [{ source: "./lando-frag.yml", kind: "landofile" }] }, appRoot);

    // Then
    expect(error._tag).toBe("ComposeKeyRejectedError");
    expect(error.keyPath).toBe("container_name");
    const remediation = composeServiceDispositions.container_name?.remediation;
    if (remediation === undefined) throw new Error("container_name must declare remediation");
    expect(error.remediation).toBe(remediation);
  });

  test("rejects a reset tag with the authored fragment source", async () => {
    // Given
    await writeFile(join(appRoot, "reset.yml"), "services:\n  web: !reset\n", "utf8");

    // When
    const error = await reject({ includes: ["./reset.yml"] }, appRoot);

    // Then
    expect(error._tag).toBe("ComposeKeyRejectedError");
    expect(error.keyPath).toBe("!reset");
    expect(error.source).toBe("./reset.yml");
  });

  test("attributes a nested Compose fragment rejection to its own authored source", async () => {
    // Given an outer fragment that includes a sibling carrying the rejected key.
    await mkdir(join(appRoot, "nested"), { recursive: true });
    await writeFile(join(appRoot, "nested", "outer.yml"), "includes:\n  - ./inner.yml\n", "utf8");
    await writeFile(
      join(appRoot, "nested", "inner.yml"),
      "services:\n  web:\n    image: nginx\n    container_name: fixed-web\n",
      "utf8",
    );

    // When
    const error = await reject({ includes: [{ source: "./nested/outer.yml", kind: "compose" }] }, appRoot);

    // Then the inner fragment owns the rejection, not the outer one that pulled it in.
    expect(error._tag).toBe("ComposeKeyRejectedError");
    expect(error.keyPath).toBe("container_name");
    expect(error.source).toBe("./inner.yml");
  });
});
