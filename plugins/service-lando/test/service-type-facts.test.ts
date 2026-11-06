import { expect, test } from "bun:test";
import { ServiceConfig } from "@lando/sdk/schema";
import { Schema } from "effect";
import { serviceTypeFacts, serviceTypes } from "../src/index.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const baseIds = [...new Set([...serviceTypes.keys()].map((id) => id.split(":")[0] ?? id))];

test("includes every registered base type without constructing shared facts", () => {
  // Given / When
  const first = serviceTypeFacts();
  const second = serviceTypeFacts();
  // Then
  expect(Object.keys(first).sort()).toEqual([...baseIds].sort());
  expect(first).toEqual(second);
  expect(first).not.toBe(second);
});

test.each(baseIds)("matches composed default features and endpoints for %s", async (base) => {
  // Given
  const facts = serviceTypeFacts()[base];
  const entry =
    [...serviceTypes].find(([id]) => id === (base === "node" ? "node:lts" : base)) ??
    [...serviceTypes].find(([id]) => id.startsWith(`${base}:`));
  if (entry === undefined || facts === undefined) throw new Error(`Missing bundled facts/type: ${base}`);
  const [id, serviceType] = entry;
  const service = Schema.decodeUnknownSync(ServiceConfig)({
    type: id,
    ...(base === "varnish" ? { backend: "web" } : {}),
    ...(facts.configTargets === undefined
      ? {}
      : {
          config: Object.fromEntries(
            Object.keys(facts.configTargets).map((slot) => [slot, `/srv/apps/facts/custom-${slot}`]),
          ),
        }),
    ...(["lando", "compose", "minio"].includes(base) ? { image: "example.test/facts:fixture" } : {}),
  });
  // When
  const plan = await composeServicePlan({
    serviceType,
    service,
    appRoot: "/srv/apps/facts",
    appName: "facts",
    metadata: { resolvedAt: "2026-05-18T08:00:00Z", source: "/srv/apps/facts/.lando.yml", runtime: 4 },
  });
  // Then
  expect(
    plan.mounts
      .filter((mount) => mount.type === "bind" && mount.role === "app")
      .map(({ target }) => String(target)),
  ).toEqual(facts.appMountTarget === undefined ? [] : [facts.appMountTarget]);
  if (facts.listener !== undefined) {
    expect(
      plan.endpoints.some(
        (endpoint) => endpoint.protocol !== "unix" && endpoint.port === facts.listener?.port,
      ),
    ).toBe(true);
    if (facts.listener.variable !== undefined)
      expect(plan.environment[facts.listener.variable]).toBe(String(facts.listener.port));
  } else expect(plan.endpoints).toEqual([]);
  const http = plan.endpoints.filter(({ protocol }) => protocol === "http" || protocol === "https");
  if (facts.httpPort === undefined) expect(http).toEqual([]);
  else
    expect(http.some((endpoint) => endpoint.protocol !== "unix" && endpoint.port === facts.httpPort)).toBe(
      true,
    );
  const versions = new Set(
    [...serviceTypes].flatMap(([registered, type]) =>
      registered.split(":")[0] === base ? [...(type.versions ?? []), ...registered.split(":").slice(1)] : [],
    ),
  );
  expect(facts.versions).toEqual([...versions]);
  for (const target of Object.values(facts.configTargets ?? {})) {
    expect(plan.mounts).toContainEqual(expect.objectContaining({ type: "bind", target, readOnly: true }));
  }
});
