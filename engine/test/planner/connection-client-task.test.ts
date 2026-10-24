import { expect, test } from "bun:test";
import { authoredInvocationSites, compileInvocationSites } from "@lando/landofile/compiled-sites";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { resolveConnectionClientTask } from "../../src/planner/connection-client-task.ts";
import {
  attachEffectiveTooling,
  compileEffectiveTooling,
  connectionClientOwners,
  connectionClientsForPlan,
} from "../../src/planner/effective-tooling.ts";
import { resolveToolingTaskShape } from "../../src/tooling/step-runner.ts";
import { appliedClientFixture } from "../operations/applied-client-fixture.ts";

test("winning generated client provenance survives attachment without credentials or authored overrides", () => {
  const services: Parameters<typeof connectionClientOwners>[0]["services"] = [
    { name: "zeta", tooling: { psql: { cmd: "zeta" } }, connectionClientNames: ["psql"] },
    {
      name: "alpha",
      tooling: { psql: { cmd: "alpha" }, custom: { cmd: "custom" } },
      connectionClientNames: ["psql"],
    },
  ];
  const owners = connectionClientOwners({ landofile: {}, services });
  const plan = attachEffectiveTooling(
    appliedClientFixture().plan,
    compileEffectiveTooling({ landofile: {}, services }),
    owners,
  );
  expect(connectionClientsForPlan(plan)).toEqual({ psql: ServiceName.make("alpha") });
  expect(connectionClientOwners({ landofile: { tooling: { psql: { cmd: "authored" } } }, services })).toEqual(
    {},
  );
});

test("applied replacement removes nested overwritten sites and preserves unrelated captures and fields", async () => {
  const f = appliedClientFixture();
  const task = {
    cmd: ["desired"],
    service: "database",
    dir: PortablePath.make("/current"),
    env: {
      KEEP: "{{ concat(env.PREFIX, event.value) }}",
      PGPASSWORD: { _tag: "BoundText" as const, parts: ["{{ event.bad }}"] },
    },
    vars: { mode: "current" },
  };
  const sites = await Effect.runPromise(
    compileInvocationSites(
      authoredInvocationSites(task, "/current/.lando.yml"),
      { env: { PREFIX: "captured-" } },
      task,
    ),
  );
  const client = await Effect.runPromise(
    resolveConnectionClientTask({ plan: f.plan, name: "psql", task, sites }).pipe(Effect.provide(f.layer)),
  );
  expect(client.sites).toEqual(
    sites.filter((site) => site.path[0] === "dir" || site.path[0] === "vars" || site.path[1] === "KEEP"),
  );
  const resolved = await Effect.runPromise(
    resolveToolingTaskShape(client.task, { event: { value: "runtime" } }, client.sites),
  );
  expect(resolved).toMatchObject({
    dir: "/current",
    vars: { mode: "current" },
    env: { KEEP: "captured-runtime", PGPASSWORD: { _tag: "SecretRef", reference: "APPLIED" } },
  });
});
