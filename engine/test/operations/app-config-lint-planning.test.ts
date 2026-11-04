import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestCertificateAuthority } from "@lando/sdk/test";
import { Effect } from "effect";
import * as PlanCache from "../../src/cache/app-plan.ts";
import * as Cache from "../../src/cache/service.ts";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as Assemble from "../../src/planner/assemble.ts";
import { CertificateAuthorityResolver } from "../../src/plugins/certificate-authority-resolver.ts";
import * as Plugins from "../../src/plugins/registry.ts";

test("lint rejects a generated route hostname that fails final planning", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-lint-plan-"));
  const service = "a".repeat(64);
  try {
    await writeFile(
      join(root, ".lando.yml"),
      `name: route-plan\nservices:\n  ${service}:\n    type: nginx\n`,
    );

    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(Plugins.layer)));

    expect(result.valid).toBe(false);
    expect(result.violations).toMatchObject([{ severity: "error", path: ["routes", 0, "hostname"] }]);
    expect(result.violations[0]?.message).toContain(service);
    expect(result.violations[0]?.message).toContain(`${service}.route-plan.lndo.site`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lint retains authored source coordinates for final certificate validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-lint-plan-source-"));
  const file = join(root, ".lando.yml");
  try {
    await writeFile(file, "name: lint-certs\nservices:\n  web:\n    type: nginx\n    certs: missing.crt\n");
    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(Plugins.layer)));
    expect(result.valid).toBe(false);
    expect(result.violations).toMatchObject([
      {
        rule: "landofile.validation",
        severity: "error",
        path: ["services", "web", "certs"],
        line: 5,
        source: { file, path: ["services", "web", "certs"] },
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lint does not plan after earlier error findings", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-lint-plan-earlier-"));
  const plan = spyOn(Assemble, "planApp");
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: invalid\nruntime: 4\nservices:\n  web:\n    type: nginx\n",
    );
    await writeFile(join(root, ".lando.base.yml"), "runtime: wrong\n");
    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(Plugins.layer)));
    expect(result.valid).toBe(false);
    expect(plan).toHaveBeenCalledTimes(0);
  } finally {
    plan.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("lint validates certificate intent without plan cache access or certificate issuance", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-lint-plan-effects-"));
  const ca = makeTestCertificateAuthority();
  const read = spyOn(PlanCache, "readCachedAppPlan");
  const write = spyOn(PlanCache, "writeCachedAppPlan");
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: lint-certs\nservices:\n  web:\n    type: nginx\n    certs: true\n",
    );

    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(
        Effect.provideService(CertificateAuthorityResolver, { resolve: Effect.succeed(ca) }),
        Effect.provide(Cache.layer),
        Effect.provide(Plugins.layer),
      ),
    );

    expect(result.valid).toBe(true);
    expect(read).toHaveBeenCalledTimes(0);
    expect(write).toHaveBeenCalledTimes(0);
    expect(ca.calls).toEqual([]);
  } finally {
    read.mockRestore();
    write.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
