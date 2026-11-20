import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APPLIED_STATE_VERSION, makeAppliedPlanStore } from "@lando/container-runtime/applied-state";
import { taggedErrorJson } from "@lando/sdk/command-result";
import { AbsolutePath, AppId } from "@lando/sdk/schema";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeStateStore } from "@lando/state-store/service";
import { Effect } from "effect";

const secret = "applied-state-diagnostic-sentinel";
const app = AppId.make("demo");

test.each([
  {
    name: "corrupt per-app payload",
    layout: "per-app",
    data: { services: secret, routes: [] },
    coordinate: "services",
  },
  {
    name: "old endpoint key in a current envelope",
    layout: "per-app",
    data: { services: { web: { endpoints: [{ _tag: secret }] } }, routes: [] },
    coordinate: "services[0].endpoints[0]._tag",
  },
  {
    name: "corrupt second Podman entry during removal",
    layout: "record",
    data: { demo: { id: "demo", services: {}, routes: [] }, [secret]: secret },
    coordinate: "apps[1].id",
  },
] as const)("reports a safe current-envelope coordinate for $name", async ({ layout, data, coordinate }) => {
  const root = await mkdtemp(join(tmpdir(), "lando-applied-diagnostic-"));
  const access = { enforce: async () => undefined, verify: async () => undefined };
  const state = makePluginStateStore(
    makeStateStore({ privateFileAccess: access }),
    AbsolutePath.make(root),
    access,
  );
  const providerId = layout === "record" ? "podman" : "lando";
  const store =
    layout === "record"
      ? makeAppliedPlanStore({ providerId, layout })
      : makeAppliedPlanStore({ providerId, layout });
  const path = join(root, layout === "record" ? "applied-plans.json" : "applied-plans/demo.json");
  const bytes = `${JSON.stringify({ version: APPLIED_STATE_VERSION, data })}\n`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);

    const operation =
      layout === "record" ? store.removeAppliedPlan(state, app) : store.loadAppliedPlanStrict(state, app);
    const failure = await Effect.runPromise(Effect.flip(operation));

    const diagnostic = taggedErrorJson(failure);
    expect(diagnostic).toMatchObject({
      _tag: "ProviderUnavailableError",
      providerId,
      details: {
        path,
        foundVersion: APPLIED_STATE_VERSION,
        expectedVersion: APPLIED_STATE_VERSION,
        coordinate,
      },
    });
    expect(failure.message).toContain(coordinate);
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(await readFile(path, "utf8")).toBe(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
