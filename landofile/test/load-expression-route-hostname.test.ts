import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";

import { NotImplementedError } from "@lando/sdk/errors";

import { DEFAULT_LANDOFILE_LOAD_POLICY } from "../src/load-expression-file.ts";
import { resolveLandofileLoadExpressions } from "../src/load-expression.ts";

const withApp = async <A>(run: (appRoot: string) => Promise<A>): Promise<A> => {
  const appRoot = await mkdtemp(join(tmpdir(), "lando-route-hostname-"));
  try {
    return await run(appRoot);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
};

const resolveValue = (appRoot: string, value: unknown) =>
  resolveLandofileLoadExpressions({
    value,
    source: {
      appRoot,
      sourcePath: join(appRoot, ".lando.yml"),
      sourceRoot: appRoot,
      layer: "canonical",
    },
    policy: DEFAULT_LANDOFILE_LOAD_POLICY,
  });

describe("landofile load-time route hostname expressions", () => {
  test("keeps an app/proxy hostname template unevaluated", async () => {
    await withApp(async (appRoot) => {
      // Given
      const hostname = "{{ app.name }}.{{ proxy.defaultDomain }}";
      const value = {
        services: {
          appserver: {
            routes: [{ hostname }],
          },
        },
      };

      // When
      const resolved = await Effect.runPromise(resolveValue(appRoot, value));

      // Then
      expect(resolved.value).toEqual(value);
    });
  });

  test("still Alpha-blocks env expressions", async () => {
    await withApp(async (appRoot) => {
      // Given
      const value = { hostname: "{{ env.HOME }}" };

      // When
      const exit = await Effect.runPromiseExit(resolveValue(appRoot, value));

      // Then
      if (Exit.isSuccess(exit)) throw new Error("expected Alpha-block");
      const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
      expect(failure).toBeInstanceOf(NotImplementedError);
    });
  });
});
