import { assessServiceHome } from "@lando/engine/planner/home-assessment";
import { compareKeyPaths, isPlainRecord } from "@lando/sdk/landofile";
import {
  type ConfigTranslateDiagnostic,
  type ConfigTranslateExpectation,
  ServiceConfig,
} from "@lando/sdk/schema";
import { PluginRegistry } from "@lando/sdk/services";
import { Effect, Option, Result, Schema } from "effect";

export const orderTranslateDiagnostics = (
  diagnostics: readonly ConfigTranslateDiagnostic[],
  sources: readonly string[],
) =>
  diagnostics.toSorted(
    (a, b) =>
      sources.indexOf(a.sourceId) - sources.indexOf(b.sourceId) ||
      (a.span?.start.line ?? 0) - (b.span?.start.line ?? 0) ||
      (a.span?.start.column ?? 0) - (b.span?.start.column ?? 0) ||
      compareKeyPaths(a.keyPath, b.keyPath),
  );

export const assessTranslateExpectations = Effect.fn("ConfigTranslate.assessExpectations")(function* (
  expectations: readonly ConfigTranslateExpectation[] | undefined,
  context: Readonly<Record<string, unknown>>,
): Effect.fn.Return<readonly ConfigTranslateDiagnostic[]> {
  if (expectations === undefined || expectations.length === 0) return [];
  const suppliedRegistry = yield* Effect.serviceOption(PluginRegistry);
  const registry = Option.isSome(suppliedRegistry)
    ? suppliedRegistry.value
    : yield* Effect.gen(function* () {
        const registryModule = yield* Effect.promise(() => import("@lando/engine/plugins/registry"));
        return yield* PluginRegistry.pipe(
          Effect.provide(registryModule.layerWith({ user: false, app: false })),
        );
      });
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  const seen = new Set<string>();
  for (const expectation of expectations) {
    if (seen.has(expectation.service)) continue;
    seen.add(expectation.service);
    const services = isPlainRecord(context.services) ? context.services : {};
    const raw = services[expectation.service];
    if (
      isPlainRecord(raw) &&
      (raw.home === false || (isPlainRecord(raw.home) && raw.home.path !== undefined))
    )
      continue;
    const fields = isPlainRecord(raw)
      ? Object.fromEntries(
          ["type", "image", "user", "home", "build"]
            .filter((key) => Object.hasOwn(raw, key))
            .map((key) => [key, raw[key]]),
        )
      : raw;
    const decoded = Schema.decodeUnknownResult(ServiceConfig)(fields);
    const assessment = Result.isSuccess(decoded)
      ? yield* assessServiceHome(registry, expectation.service, decoded.success)
      : ({ kind: "unresolved", reason: "service configuration is expression-valued or incomplete" } as const);
    const location = {
      sourceId: expectation.sourceId,
      keyPath: expectation.keyPath,
      kind: "needs-review" as const,
    };
    switch (assessment.kind) {
      case "persisted":
        break;
      case "not-persisted": {
        const type = isPlainRecord(raw) && typeof raw.type === "string" ? raw.type : expectation.service;
        const reason =
          assessment.reason === "custom-image"
            ? "its image comes from the Landofile"
            : assessment.reason === "no-identity"
              ? `service type ${type} declares no image users`
              : `service type ${type} doesn't know where ${assessment.user}'s home is`;
        diagnostics.push({
          ...location,
          message: `Lando 3 kept this service's home, but Lando 4 won't keep it automatically: ${reason}.`,
          remediation: `Set services.${expectation.service}.home.path to keep a home.`,
        });
        break;
      }
      case "unresolved":
        diagnostics.push({
          ...location,
          message: `Lando 3 kept this service's home; Lando 4 can't confirm it will keep it automatically (${assessment.reason}).`,
          remediation: `After lando start, check the home row in lando info, or set services.${expectation.service}.home.path.`,
        });
        break;
      default:
        assessment satisfies never;
    }
  }
  return diagnostics;
});
