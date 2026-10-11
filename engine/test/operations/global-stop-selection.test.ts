import { expect, test } from "bun:test";
import { ProviderId, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { resolveGlobalStopSelection } from "../../src/operations/global-teardown.ts";
import { type Resolved, harness, id, root } from "./global-stop-selection-fixture.ts";

test("selected stop deduplicates requests without stopping dependencies or removing shared resources", async () => {
  // Given three active services with an explicit dependency.
  const h = harness();
  // When mail is selected repeatedly.
  const result = await h.run(["mail", "mail"]);
  // Then only mail is removed and active sibling routes survive.
  expect(result).toEqual({ changed: true, services: ["mail"] });
  expect(h.removed.map((service) => String(service.service))).toEqual(["mail"]);
  expect(h.states.get("database")).toBe("running");
  expect(h.published).toEqual([["database", "sibling"]]);
});

test("sequential selections and repeats never resurrect stopped sibling routes", async () => {
  // Given mail was already stopped through selection.
  const h = harness();
  await h.run(["mail"]);
  // When another service stops and the original selection repeats.
  await h.run(["database"]);
  const result = await h.run(["mail"]);
  // Then the repeated stop is unchanged and only the active route remains.
  expect(result).toEqual({ changed: false, services: [] });
  expect(h.removed.map((service) => String(service.service))).toEqual(["mail", "database"]);
  expect(h.published).toEqual([["database", "sibling"], ["sibling"], ["sibling"]]);
});

for (const options of [{ online: false }, { missing: true }]) {
  test(`selected stop reports no removal when ${JSON.stringify(options)}`, async () => {
    // Given offline runtime or an applied service without a container.
    const h = harness(options);
    // When the absent active service is selected.
    const result = await h.run(["mail"]);
    // Then offline stop stays observational, while online stop reconciles selected routes.
    expect(result).toEqual({ changed: false, services: [] });
    expect(h.removed).toEqual([]);
    expect(h.published).toEqual(options.online === false ? [] : [["database", "sibling"]]);
  });
}

test("unknown selection rejects the entire request before mutation", async () => {
  // Given a valid service followed by an unknown service.
  const h = harness();
  // When selection resolves.
  const result = await Effect.runPromise(
    resolveGlobalStopSelection(h.resolved, ["mail", "typo"]).pipe(Effect.result),
  );
  // Then the existing tagged error includes available services and remediation.
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ToolingExecError",
      tool: "meta:global:stop",
      remediation: "Example: lando global:stop --service database",
    },
  });
  expect(h.removed).toEqual([]);
  expect(h.published).toEqual([]);
});

for (const requested of ["mail", "unknown"]) {
  test(`orphan selection ${requested} fails closed without removing resources`, async () => {
    // Given observed owned containers without matching applied state.
    const h = harness();
    const evidence: Resolved["evidence"] = {
      kind: "orphans",
      groups: [
        {
          appId: id,
          providerId: ProviderId.make("lando"),
          volumes: [],
          services: [
            {
              app: id,
              appRoot: root,
              providerId: ProviderId.make("lando"),
              service: ServiceName.make("mail"),
              status: "running",
              containerId: "orphan",
            },
          ],
        },
      ],
    };
    // When a known or unknown orphan is selected.
    const result = await Effect.runPromise(
      resolveGlobalStopSelection({ ...h.resolved, evidence }, [requested]).pipe(Effect.result),
    );
    // Then neither an unsafe stop nor whole-app teardown is attempted.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: requested === "mail" ? "AppResolveError" : "ToolingExecError",
      },
    });
    expect(h.removed).toEqual([]);
    expect(h.published).toEqual([]);
  });
}

test("selecting every applied service removes containers and publishes an empty route set", async () => {
  // Given all global services are active.
  const h = harness();
  // When every service is explicitly selected.
  const result = await h.run(["mail", "sibling", "database"]);
  // Then even an all-service selection never falls back to destructive teardown.
  expect(result).toEqual({ changed: true, services: ["sibling", "database", "mail"] });
  expect(h.published).toEqual([[]]);
});
