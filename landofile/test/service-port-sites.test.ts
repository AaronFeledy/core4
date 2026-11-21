import { expect, test } from "bun:test";
import { Effect } from "effect";
import { loadAuthoredDocuments } from "../src/root-compile.ts";

const file = "/app/.lando.yml";
const self = "{{ service.port }}";
const load = (service: Record<string, unknown>, overlay?: Record<string, unknown>) =>
  Effect.runPromise(
    loadAuthoredDocuments(
      [
        { file, value: { name: "demo", services: { web: { type: "redis", ...service } } } },
        ...(overlay === undefined
          ? []
          : [{ file: "/app/.lando.local.yml", value: { services: { web: overlay } } }]),
      ],
      { appRoot: "/app", file },
    ),
  );

test.each([
  [{ command: self }, ["command"]],
  [{ command: ["server", self] }, ["command", 1]],
  [{ entrypoint: self }, ["entrypoint"]],
  [{ entrypoint: ["server", self] }, ["entrypoint", 1]],
  [{ healthcheck: self }, ["healthcheck", "command"]],
  [{ healthcheck: { test: ["CMD", "probe", self] } }, ["healthcheck", "command", 1]],
  [{ readiness: { test: ["CMD-SHELL", self] } }, ["readiness", "command"]],
] as const)("records a pending self port at the decoded process leaf %#", async (service, path) => {
  expect((await load(service)).pendingSites.map((site) => site.path)).toEqual([["services", "web", ...path]]);
});

test.each([
  [{ port: self }, ["port"]],
  [{ type: self }, ["type"]],
  [{ environment: { PORT: self } }, ["environment", "PORT"]],
  [{ healthcheck: { test: [self, "probe"] } }, ["healthcheck", "test", 0]],
  [{ command: "{{ service.name }}" }, ["command"]],
  [{ command: '{{ service["port"] }}' }, ["command"]],
  [{ command: "{{ service }}" }, ["command"]],
] as const)("rejects a self scope outside the contract %#", async (service, path) => {
  await expect(load(service)).rejects.toMatchObject({
    _tag: "LandofileValidationError",
    issues: [
      expect.objectContaining({
        rule: "unsupported-expression",
        path: ["services", "web", ...path],
        suggestion: expect.stringContaining("service.port"),
      }),
    ],
  });
});

test("checks the readiness target after overlays compose", async () => {
  await expect(
    load({ readiness: { command: self } }, { readiness: { target: "host" } }),
  ).rejects.toMatchObject({
    _tag: "LandofileValidationError",
    issues: [
      expect.objectContaining({
        path: ["services", "web", "readiness", "command"],
        source: expect.objectContaining({ file }),
      }),
    ],
  });
  expect(
    (await load({ readiness: { target: "host", command: self } }, { readiness: { target: "service" } }))
      .pendingSites,
  ).toHaveLength(1);
});

test("does not record an escaped expression or a launcher replaced by an overlay", async () => {
  const compiled = await load({ command: self }, { command: "{{{{ service.port }}" });
  expect(compiled.document.services).toMatchObject({ web: { command: self } });
  expect(compiled.pendingSites).toEqual([]);
});

test.each([
  [{ events: { "pre-start": [{ cmd: self, service: "web" }] } }, "LandofileValidationError"],
  [{ tooling: { probe: { cmd: self, service: "web" } } }, "NotImplementedError"],
] as const)("preserves expression admission outside services %#", async (section, tag) => {
  await expect(
    Effect.runPromise(
      loadAuthoredDocuments(
        [{ file, value: { name: "demo", services: { web: { type: "redis" } }, ...section } }],
        { appRoot: "/app", file },
      ),
    ),
  ).rejects.toMatchObject({ _tag: tag });
});
