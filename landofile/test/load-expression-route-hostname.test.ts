import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";

import { NotImplementedError } from "@lando/sdk/errors";

import { DEFAULT_LANDOFILE_LOAD_POLICY } from "../src/load-expression-file.ts";
import { resolveLandofileLoadExpressions } from "../src/load-expression.ts";
import { loadLandofileLayers } from "../src/service.ts";

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

  test("keeps an env expression unevaluated for the post-merge materializer", async () => {
    await withApp(async (appRoot) => {
      // Given
      const value = { image: "node:{{ default(env.LANDO_NODE_VERSION, 'lts') }}" };

      // When
      const resolved = await Effect.runPromise(resolveValue(appRoot, value));

      // Then
      expect(resolved.value).toEqual(value);
    });
  });

  test("keeps an exact service environment secret reference for provider input resolution", async () => {
    await withApp(async (appRoot) => {
      // Given
      const value = { services: { appserver: { environment: { API_TOKEN: "${secret:API_TOKEN}" } } } };

      // When
      const resolved = await Effect.runPromise(resolveValue(appRoot, value));

      // Then
      expect(resolved.value).toEqual(value);
    });
  });

  test("loads an authored exact service environment secret reference unchanged", async () => {
    await withApp(async (appRoot) => {
      // Given
      await writeFile(
        join(appRoot, ".lando.yml"),
        'name: secret-app\nservices:\n  appserver:\n    type: node\n    environment:\n      API_TOKEN: "${secret:API_TOKEN}"\n',
      );

      // When
      const landofile = await Effect.runPromise(loadLandofileLayers(appRoot, join(appRoot, ".lando.yml")));

      // Then
      const services = landofile.services as
        | Readonly<Record<string, { readonly environment: Readonly<Record<string, string>> }>>
        | undefined;
      expect(services?.appserver?.environment.API_TOKEN).toBe("${secret:API_TOKEN}");
    });
  });

  test("rejects secret references outside a service environment value", async () => {
    await withApp(async (appRoot) => {
      // Given
      const value = { services: { appserver: { image: "${secret:IMAGE}" } } };

      // When
      const exit = await Effect.runPromiseExit(resolveValue(appRoot, value));

      // Then
      if (Exit.isSuccess(exit)) throw new Error("expected unsupported expression rejection");
      expect(Option.getOrThrow(Cause.failureOption(exit.cause))).toBeInstanceOf(NotImplementedError);
    });
  });

  test("still rejects expressions that reach the host", async () => {
    await withApp(async (appRoot) => {
      // Given
      const value = { hostname: "{{ which('php') }}" };

      // When
      const exit = await Effect.runPromiseExit(resolveValue(appRoot, value));

      // Then
      if (Exit.isSuccess(exit)) throw new Error("expected unsupported expression rejection");
      const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
      expect(failure).toBeInstanceOf(NotImplementedError);
      expect(failure).toMatchObject({ _tag: "NotImplementedError" });
      if (failure instanceof NotImplementedError) {
        expect(failure.message).not.toMatch(/\b(?:Alpha|Beta)\b/);
      }
    });
  });
});
