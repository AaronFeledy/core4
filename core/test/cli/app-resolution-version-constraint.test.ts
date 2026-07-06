import { describe, expect, test } from "bun:test";

import { type Context, Effect, Layer } from "effect";

import type { LandofileShape } from "@lando/sdk/schema";
import type { LandofileService } from "@lando/sdk/services";
import { Renderer } from "@lando/sdk/services";

import { assertLandoVersionConstraint, loadUserLandofile } from "../../src/cli/app-resolution.ts";

const landofile = (lando?: string): LandofileShape =>
  (lando === undefined ? {} : { lando }) as unknown as LandofileShape;

const fakeLandofileService = (shape: LandofileShape): Context.Tag.Service<typeof LandofileService> =>
  ({ discover: Effect.succeed(shape) }) as Context.Tag.Service<typeof LandofileService>;

const capturingRendererLayer = (sink: { warnings: string[] }): Layer.Layer<Renderer> =>
  Layer.succeed(Renderer, {
    id: "test",
    message: {
      info: () => Effect.void,
      warn: (body: string) =>
        Effect.sync(() => {
          sink.warnings.push(body);
        }),
      error: () => Effect.void,
    },
    output: { stdout: () => Effect.void, stderr: () => Effect.void },
  } as Context.Tag.Service<typeof Renderer>);

describe("assertLandoVersionConstraint", () => {
  test("passes when the running version satisfies the constraint", async () => {
    await Effect.runPromise(assertLandoVersionConstraint(landofile("<5"), { runningVersion: "4.2.0" }));
  });

  test("passes when no lando constraint is declared", async () => {
    await Effect.runPromise(assertLandoVersionConstraint(landofile(), { runningVersion: "4.2.0" }));
  });

  test("passes a prerelease within the numeric range", async () => {
    await Effect.runPromise(
      assertLandoVersionConstraint(landofile(">=4.1 <5"), { runningVersion: "4.1.0-beta.2" }),
    );
  });

  test("fails closed with LandofileVersionConstraintError when unsatisfied", async () => {
    const error = await Effect.runPromise(
      Effect.flip(assertLandoVersionConstraint(landofile(">=4.1"), { runningVersion: "4.0.0" })),
    );

    expect(error._tag).toBe("LandofileVersionConstraintError");
    if (error._tag !== "LandofileVersionConstraintError") throw new Error("wrong error tag");
    expect(error.runningVersion).toBe("4.0.0");
    expect(error.constraints).toEqual([{ range: ">=4.1", source: ".lando.yml" }]);
    expect(error.remediation).toContain("lando update");
    expect(error.message).toContain(">=4.1");
  });

  test("rejects an unparseable range with LandofileParseError", async () => {
    const error = await Effect.runPromise(
      Effect.flip(assertLandoVersionConstraint(landofile("not-a-range"), { runningVersion: "4.2.0" })),
    );

    expect(error._tag).toBe("LandofileParseError");
    expect(error.message.toLowerCase()).toContain("semver range");
  });

  test("LANDO_SKIP_VERSION_CONSTRAINT=1 downgrades the failure to a renderer warning", async () => {
    const sink = { warnings: [] as string[] };

    await Effect.runPromise(
      assertLandoVersionConstraint(landofile(">=4.1"), {
        runningVersion: "4.0.0",
        env: { LANDO_SKIP_VERSION_CONSTRAINT: "1" },
      }).pipe(Effect.provide(capturingRendererLayer(sink))),
    );

    expect(sink.warnings).toHaveLength(1);
    expect(sink.warnings[0]).toContain(">=4.1");
  });

  test("skip path is a no-op when no Renderer is provided", async () => {
    await Effect.runPromise(
      assertLandoVersionConstraint(landofile(">=4.1"), {
        runningVersion: "4.0.0",
        env: { LANDO_SKIP_VERSION_CONSTRAINT: "1" },
      }),
    );
  });
});

describe("lando: is a distinct surface from runtime: and api:", () => {
  test("runtime: and service api: alone never trigger the version-constraint check", async () => {
    const shape = {
      runtime: 4,
      services: { web: { api: 4, type: "lando" } },
    } as unknown as LandofileShape;
    await Effect.runPromise(assertLandoVersionConstraint(shape, { runningVersion: "0.0.1" }));
  });

  test("only lando: drives the constraint while runtime:/api: coexist untouched", async () => {
    const shape = {
      runtime: 4,
      lando: ">=99",
      services: { web: { api: 4, type: "lando" } },
    } as unknown as LandofileShape;
    const error = await Effect.runPromise(
      Effect.flip(assertLandoVersionConstraint(shape, { runningVersion: "4.0.0" })),
    );

    expect(error._tag).toBe("LandofileVersionConstraintError");
  });
});

describe("loadUserLandofile version-constraint enforcement", () => {
  test("rejects a Landofile whose constraint the running core version fails", async () => {
    const error = await Effect.runPromise(
      Effect.flip(loadUserLandofile(fakeLandofileService(landofile(">=4.1")))),
    );

    expect(error._tag).toBe("LandofileVersionConstraintError");
  });

  test("returns the Landofile when the constraint is satisfied", async () => {
    const result = await Effect.runPromise(loadUserLandofile(fakeLandofileService(landofile(">=0.0.0"))));

    expect(result.lando).toBe(">=0.0.0");
  });
});
