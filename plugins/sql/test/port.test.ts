import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { executeDbCommand } from "../src/execute.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";
import { sourcePlan } from "./support/source-plan.ts";

afterEach(cleanupSqlTestDeps);

for (const family of ["mysql", "mariadb", "postgres", "mongodb"] as const) {
  test(`${family} seed uses distinct source and target ports, including readiness probes`, async () => {
    const source = sourcePlan("/shop", `${family}:8.0`);
    const sourceServices = Object.fromEntries(
      Object.entries(source.services).map(([name, service]) => [
        name,
        { ...service, environment: { ...service.environment, LANDO_DB_PORT: "43210" } },
      ]),
    );
    const harness = makeSqlTestDeps({
      type: `${family}:8.0`,
      password: "test-secret",
      countStdout: "0",
      ...(family === "mariadb" ? { observedVersion: "8.0-MariaDB" } : {}),
      environment: { LANDO_DB_PORT: "43211" },
      appliedPlans: Effect.succeed([{ ...source, services: sourceServices }]),
    });
    const result = await Effect.runPromise(
      Effect.scoped(executeDbCommand(harness.deps, { action: "seed", fromApp: "shop", yes: false })),
    );
    expect(result.seedStatus).toBe("seeded");
    const transfer = harness.transfers()[0];
    if (transfer?.from._tag !== "serviceCmd" || transfer.to._tag !== "serviceCmd")
      throw new Error("expected command transfer");
    if (family === "mongodb") {
      expect(transfer.from.env?.MONGO_URI).toContain("127.0.0.1:43210/");
      expect(transfer.to.env?.MONGO_URI).toContain("127.0.0.1:43211/");
      for (const exec of harness.execs()) expect(exec.env?.MONGO_URI).toContain("127.0.0.1:43211/");
    } else {
      expect(transfer.from.command).toContain("43210");
      expect(transfer.to.command).toContain("43211");
      expect(harness.execs().length).toBeGreaterThan(0);
      for (const exec of harness.execs()) expect(exec.command).toContain("43211");
    }
  });
}
