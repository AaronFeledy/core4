import { expect, test } from "bun:test";
import { reset } from "@lando/sdk/landofile";
import { Effect } from "effect";
import { foldAuthoredOverlays } from "../../src/pipeline/fold.ts";
import { getOrigins, rememberOrigins } from "../../src/pipeline/origins.ts";
import { prepareOverlay } from "../../src/pipeline/prepare.ts";
import { validateLandofile } from "../../src/validation.ts";

test("authored composition replaces object shorthand before runtime defaults", async () => {
  // Given
  const lower = await Effect.runPromise(
    prepareOverlay(
      { services: { web: { appMount: { target: "/old", excludes: ["vendor"] } } } },
      { file: "/app/.lando.yml", layer: "canonical" },
    ),
  );
  const higher = await Effect.runPromise(
    prepareOverlay(
      { services: { web: { appMount: "/new" } } },
      { file: "/app/.lando.local.yml", layer: "local" },
    ),
  );
  // When
  const merged = foldAuthoredOverlays(
    [rememberOrigins(lower.value, lower.origins), rememberOrigins(higher.value, higher.origins)],
    lower.origins.source,
  );
  // Then
  expect(merged).toEqual({ services: { web: { appMount: "/new" } } });
});

test("composition retains native deletion origins for strict missing-member failures", async () => {
  // Given
  const lower = await Effect.runPromise(
    prepareOverlay(
      { services: { web: { appMount: { target: "/site" } } } },
      { file: "/app/.lando.yml", layer: "canonical" },
    ),
  );
  const higher = await Effect.runPromise(
    prepareOverlay(
      { services: { web: { appMount: { target: reset() } } } },
      { file: "/app/.lando.local.yml", layer: "local" },
    ),
  );
  const merged = foldAuthoredOverlays(
    [rememberOrigins(lower.value, lower.origins), rememberOrigins(higher.value, higher.origins)],
    lower.origins.source,
  );
  // When
  const error = await Effect.runPromise(validateLandofile("/app/.lando.yml", merged).pipe(Effect.flip));
  // Then
  expect(
    getOrigins(merged)
      ?.children.get("services")
      ?.children.get("web")
      ?.children.get("appMount")
      ?.children.get("target")?.deleted,
  ).toBe(true);
  expect(error).toMatchObject({
    _tag: "LandofileValidationError",
    file: "/app/.lando.local.yml",
    issues: expect.arrayContaining([
      expect.objectContaining({
        source: {
          file: "/app/.lando.local.yml",
          layer: "local",
          path: ["services", "web", "appMount", "target"],
        },
      }),
    ]),
  });
});
