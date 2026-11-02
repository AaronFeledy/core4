import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { compileInvocationSites, instantiateInvocation } from "../src/compiled-sites.ts";
import { loadAuthoredDocuments } from "../src/root-compile.ts";
import { loadLandofileLayers } from "../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

test.each(["canonical", "shorthand"] as const)(
  "carries %s include vars through namespace aliases by original winner",
  async (form) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-invocation-sites-"));
    try {
      await Bun.write(
        join(root, "tasks.yml"),
        `tooling:
  inherited:
    cmd: "{{ vars.value }}"
  overridden:
    cmd: "{{ vars.value }}"
    vars:
      value: "{{{{ event.CANARY }}"
`,
      );
      const include =
        form === "canonical"
          ? 'includes:\n  - source: ./tasks.yml\n    kind: tooling\n    namespace: ns\n    aliases: [alias]\n    vars:\n      value: "{{ event.CANARY }}"\n'
          : 'toolingIncludes:\n  ns:\n    file: ./tasks.yml\n    aliases: [alias]\n    vars:\n      value: "{{ event.CANARY }}"\n';
      await Bun.write(join(root, ".lando.yml"), include);
      // When
      const compiled = await Effect.runPromise(
        loadLandofileLayers(root, join(root, ".lando.yml"), {
          ports: makeTestLandofilePorts(join(root, "cache")),
          stateStore: makeTestLandofileStateStore(),
          templates: { modules: [] },
        }),
      );
      const sites = await Effect.runPromise(
        compileInvocationSites(compiled.pendingSites, {}, compiled.document),
      );
      const instantiated = await Effect.runPromise(
        instantiateInvocation({
          value: compiled.document,
          sites,
          context: { event: { CANARY: "active" }, vars: { value: "copied" } },
        }),
      );
      // Then
      expect(instantiated).toMatchObject({
        tooling: {
          "ns:inherited": { vars: { value: "active" } },
          "alias:inherited": { vars: { value: "active" } },
          "ns:overridden": { vars: { value: "{{ event.CANARY }}" } },
          "alias:overridden": { vars: { value: "{{ event.CANARY }}" } },
        },
      });
      const inherited = sites.filter((site) => site.path[2] === "vars");
      expect(inherited.map((site) => site.path)).toEqual([
        ["tooling", "ns:inherited", "vars", "value"],
        ["tooling", "alias:inherited", "vars", "value"],
      ]);
      expect(inherited[0]?.source).toMatchObject({
        file: join(root, ".lando.yml"),
        path:
          form === "canonical"
            ? ["includes", 0, "vars", "value"]
            : ["toolingIncludes", "ns", "vars", "value"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("preserves noncanonical authored expression text in runtime errors", async () => {
  // Given
  const expression = "prefix {{default(env.MISSING, event.missing)}} suffix";
  const file = "/app/.lando.yml";
  const compiled = await Effect.runPromise(
    loadAuthoredDocuments([{ file, value: { tooling: { check: { cmd: expression } } } }], {
      appRoot: "/app",
      file,
    }),
  );
  const sites = await Effect.runPromise(compileInvocationSites(compiled.pendingSites, {}, compiled.document));
  // When
  const result = await Effect.runPromise(
    instantiateInvocation({ value: compiled.document, sites, context: {} }).pipe(Effect.result),
  );
  // Then
  expect(sites[0]?.path).toEqual(["tooling", "check", "cmd"]);
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ConfigExpressionError", expression, filePath: file },
  });
});
