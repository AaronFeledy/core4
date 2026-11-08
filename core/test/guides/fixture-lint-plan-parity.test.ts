import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { appConfigLint } from "@lando/engine/operations/app-config-lint";
import { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";
import * as Plugins from "@lando/engine/plugins/registry";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { lintLandofileSnapshot } from "@lando/engine/services/landofile-live";
import * as Planner from "@lando/engine/services/planner";
import type { ProviderCapabilities, ProviderId } from "@lando/sdk/schema";
import { AppPlanner, PluginRegistry } from "@lando/sdk/services";
import { makeTestCertificateAuthority } from "@lando/sdk/test";
import { Effect, Layer, Result } from "effect";
import { classifyFixtureLandofileName } from "../../../scripts/lint-guides-yaml-fixtures.ts";
import { testStateStoreLayer } from "../_support/landofile-layer.ts";
import { withCwd } from "../_support/temp-cwd.ts";

const root = resolve(import.meta.dir, "../../..");
const fixtures = [
  ...new Bun.Glob("docs/guides/**/fixtures/**/.lando*.{yml,yaml}").scanSync({ cwd: root, dot: true }),
].sort();
const catalog = Plugins.layerWith({ user: false, app: false });
let lintCleanFixtures = 0;

for (const fixture of fixtures) {
  const path = resolve(root, fixture);
  const form = classifyFixtureLandofileName(path.split("/").at(-1) ?? "");
  if (form !== "full") {
    test.skip(`${fixture}: layer fragment, not a complete Landofile`, () => {});
    continue;
  }
  const content = await Bun.file(path).text();
  const invalid = /^\s*# lando-lint: expect-invalid\b(.*)$/m.exec(content);
  if (invalid !== null) {
    test.skip(`${fixture}: authored expect-invalid marker${invalid[1]}`, () => {});
    continue;
  }
  if (await Bun.file(resolve(dirname(path), ".lando.ts")).exists()) {
    test.skip(`${fixture}: intentional YAML/TypeScript dual-form conflict`, () => {});
    continue;
  }
  const { lint, declaration } = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      const declarations: Array<{
        readonly provider: ProviderId;
        readonly capabilities: ProviderCapabilities | undefined;
      }> = [];
      const lint = yield* appConfigLint({ cwd: dirname(path) }).pipe(
        Effect.provideService(PluginRegistry, {
          ...registry,
          declaredProviderCapabilities: (provider, platform) => {
            const capabilities = registry.declaredProviderCapabilities?.(provider, platform);
            declarations.push({ provider, capabilities });
            return capabilities;
          },
        }),
        Effect.result,
      );
      return { lint, declaration: declarations.at(-1) };
    }).pipe(Effect.provide(catalog), Effect.provide(testStateStoreLayer)),
  );
  if (Result.isSuccess(lint) && !lint.success.valid) {
    const reasons = lint.success.violations
      .filter((issue) => issue.severity === "error")
      .map((issue) => `${issue.rule} at ${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    test.skip(`${fixture}: lint rejected configuration: ${reasons}`, () => {});
    continue;
  }

  if (Result.isSuccess(lint) && declaration?.capabilities === undefined) {
    test.skip(`${fixture}: provider ${declaration?.provider} has no offline capability declaration`, () => {});
    continue;
  }

  lintCleanFixtures += 1;
  test(`lint-clean guide fixture plans: ${fixture}`, async () => {
    expect(Result.isSuccess(lint), fixture).toBe(true);
    if (Result.isFailure(lint)) throw lint.failure;
    const planned = await withCwd(
      dirname(path),
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const snapshot = yield* lintLandofileSnapshot({ cwd: dirname(path) });
            if (snapshot.resolved === undefined)
              throw new Error(`${fixture}: valid lint has no resolved Landofile`);
            const capabilities = declaration?.capabilities;
            if (capabilities === undefined)
              throw new Error(`${fixture}: valid lint has no captured capabilities`);
            const planner = yield* AppPlanner;
            return yield* planner.plan(snapshot.resolved, capabilities).pipe(Effect.result);
          }).pipe(
            Effect.provide(
              Planner.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    catalog,
                    BunFileSystem.layer,
                    Layer.succeed(CertificateAuthorityResolver, {
                      resolve: Effect.succeed(makeTestCertificateAuthority()),
                    }),
                  ),
                ),
              ),
            ),
            Effect.provide(catalog),
            Effect.provide(testStateStoreLayer),
          ),
        ),
      [dirname(path)],
    );
    expect(
      Result.isSuccess(planned),
      Result.isFailure(planned) ? `${fixture}: ${planned.failure.message}` : fixture,
    ).toBe(true);
  });
}

test("fixture parity exercises lint-clean configurations", () => {
  expect(lintCleanFixtures).toBeGreaterThan(0);
});
