import { describe, expect, test } from "bun:test";
import type { EngineHttpApi, EngineHttpResponse } from "@lando/container-runtime/engine-api";
import { HEALTH_START_INTERVAL_LABEL } from "@lando/container-runtime/labels";
import {
  managedHealthRunKey,
  managedHealthUnitName,
  managedHealthUnitPrefix,
} from "@lando/container-runtime/podman/managed-health-units";
import type { ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { type UserSystemd, makeNativeHealthTimers } from "../src/native-health-timers.ts";

const dataRoot = "/home/u/.local/share/lando";
const prefix = managedHealthUnitPrefix("/run/user/1000/lando-0123456789abcdef");
// TestClock starts at the epoch, so a container started then is still inside its start period.
const startedAt = "1970-01-01T00:00:00Z";
const idA = "a".repeat(64);
const idB = "b".repeat(64);
const keyA = managedHealthRunKey(idA, startedAt);

interface FakeContainer {
  readonly id: string;
  readonly startedAt?: string;
  readonly owned?: boolean;
  readonly startInterval?: boolean;
}

/** A user manager that keeps transient units by name and answers list/stop like systemctl. */
const fakeSystemd = (failUnit?: string) => {
  const units = new Map<string, boolean>();
  const calls: ReadonlyArray<string>[] = [];
  const matches = (name: string, pattern: string) =>
    pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
  const systemd: UserSystemd = {
    run: (argv) =>
      Effect.sync(() => {
        calls.push(argv);
        const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
        if (argv[2] === "list-units") {
          return ok(
            [...units]
              .map(([name, active]) => `${name} loaded ${active ? "active" : "inactive"} x`)
              .join("\n"),
          );
        }
        if (argv[2] === "stop") {
          for (const name of [...units.keys()])
            if (argv.slice(3).some((p) => matches(name, p))) units.delete(name);
          return ok();
        }
        const unit = argv.find((arg) => arg.startsWith("--unit="))?.slice("--unit=".length) ?? "";
        if (unit === failUnit)
          return { exitCode: 1, stdout: "", stderr: "Failed to start transient timer unit" };
        units.set(`${unit}.timer`, true);
        units.set(`${unit}.service`, false);
        return ok();
      }),
  };
  return { systemd, units, calls };
};

const fakeApi = (containers: ReadonlyArray<FakeContainer>): EngineHttpApi => ({
  request: (request) =>
    Effect.sync((): EngineHttpResponse => {
      if (request.path.startsWith("/libpod/containers/json?")) {
        const labels = (container: FakeContainer) =>
          container.owned === false
            ? { "dev.lando.data-root": dataRoot }
            : {
                "dev.lando.data-root": dataRoot,
                "dev.lando.app": "app",
                "dev.lando.app-root": "/srv/app",
                "dev.lando.service": "web",
              };
        return {
          status: 200,
          body: JSON.stringify(
            containers.map((container) => ({ Id: container.id, Labels: labels(container) })),
          ),
        };
      }
      const container = containers.find((entry) => request.path === `/libpod/containers/${entry.id}/json`);
      if (container === undefined) return { status: 404, body: "{}" };
      return {
        status: 200,
        body: JSON.stringify({
          Id: container.id,
          State: { Running: true, StartedAt: container.startedAt ?? startedAt },
          Config: {
            Labels: container.startInterval === true ? { [HEALTH_START_INTERVAL_LABEL]: "1000000000" } : {},
            Healthcheck: { Test: ["CMD", "true"], Interval: 30e9, Timeout: 2e9, StartPeriod: 20e9 },
          },
        }),
      };
    }),
});

const failingApi: EngineHttpApi = { request: () => Effect.succeed({ status: 500, body: "" }) };

const timers = (containers: ReadonlyArray<FakeContainer>, failUnit?: string, api = fakeApi(containers)) => {
  const fake = fakeSystemd(failUnit);
  const warnings: ProviderUnavailableError[] = [];
  let held = false;
  const unlockedCalls: ReadonlyArray<string>[] = [];
  const health = makeNativeHealthTimers({
    systemd: {
      run: (argv) =>
        Effect.suspend(() => {
          if (!held) unlockedCalls.push(argv);
          return fake.systemd.run(argv);
        }),
    },
    tools: {
      systemdRun: "/usr/bin/systemd-run",
      systemctl: "/usr/bin/systemctl",
      userRuntimeDir: "/run/user/1000",
    },
    api,
    prefix,
    runtimeBinDir: `${dataRoot}/runtime/bin`,
    socketPath: `${dataRoot}/runtime/run/podman.sock`,
    runtimeConfigDir: `${dataRoot}/runtime/config`,
    dataRoot,
    scope: Effect.succeed("run-p7-i9.scope"),
    withLock: (body) =>
      Effect.sync(() => {
        held = true;
      }).pipe(
        Effect.andThen(body),
        Effect.ensuring(
          Effect.sync(() => {
            held = false;
          }),
        ),
      ),
    warn: (error) => Effect.sync(() => warnings.push(error)),
  });
  return { ...fake, health, warnings, unlockedCalls };
};

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())));
const created = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.flatMap((argv) => argv.filter((arg) => arg.startsWith("--unit=")).map((arg) => arg.slice(7)));

describe("native health enrollment", () => {
  test("schedules one main timer bound to the service scope, under the lock", async () => {
    const fake = timers([{ id: idA }]);
    await run(fake.health.enroll(idA));
    expect(created(fake.calls)).toEqual([managedHealthUnitName(prefix, keyA, "main")]);
    expect(fake.calls.at(-1)).toContain("--timer-property=BindsTo=run-p7-i9.scope");
    expect(fake.calls.at(-1)).toContain("--on-active=30000ms");
    expect(fake.unlockedCalls).toEqual([]);
  });

  test("a start interval adds a start timer that main takes over from when the period ends", async () => {
    const fake = timers([{ id: idA, startInterval: true }]);
    await run(fake.health.enroll(idA));
    const [start, main] = fake.calls.filter((argv) => argv[0] === "/usr/bin/systemd-run");
    expect(created(fake.calls)).toEqual([
      managedHealthUnitName(prefix, keyA, "start"),
      managedHealthUnitName(prefix, keyA, "main"),
    ]);
    expect(start).toContain("--on-unit-inactive=1000ms");
    expect(start?.some((arg) => arg.startsWith("Conflicts="))).toBe(false);
    expect(main).toContain("--on-active=20000ms");
    expect(main).toContain(`Conflicts=${managedHealthUnitName(prefix, keyA, "start")}.timer`);
  });

  test("a restart replaces the previous run's units of the same container", async () => {
    const fake = timers([{ id: idA, startedAt: "1970-01-01T00:00:00.5Z" }]);
    fake.units.set(`${managedHealthUnitName(prefix, keyA, "main")}.timer`, true);
    await run(fake.health.enroll(idA));
    expect([...fake.units.keys()]).toEqual([
      `${managedHealthUnitName(prefix, managedHealthRunKey(idA, "1970-01-01T00:00:00.5Z"), "main")}.timer`,
      `${managedHealthUnitName(prefix, managedHealthRunKey(idA, "1970-01-01T00:00:00.5Z"), "main")}.service`,
    ]);
  });

  test("a failed timer warns instead of failing a container with no start interval", async () => {
    const fake = timers([{ id: idA }], managedHealthUnitName(prefix, keyA, "main"));
    await run(fake.health.enroll(idA));
    expect(fake.warnings.map((warning) => warning.details)).toEqual([
      expect.objectContaining({ stderr: "Failed to start transient timer unit" }),
    ]);
  });

  test("a failed start-phase timer fails the activation instead of warning", async () => {
    const fake = timers([{ id: idA, startInterval: true }], managedHealthUnitName(prefix, keyA, "start"));
    const error = await run(Effect.flip(fake.health.enroll(idA)));
    expect(error).toMatchObject({
      _tag: "ProviderUnavailableError",
      operation: "nativeHealth",
      details: { stderr: "Failed to start transient timer unit" },
    });
    expect(fake.warnings).toEqual([]);
  });

  test("an unreadable container inspect warns instead of failing", async () => {
    const fake = timers([], undefined, failingApi);
    await run(fake.health.enroll(idA));
    expect(fake.warnings.map((warning) => warning.operation)).toEqual(["nativeHealth"]);
    expect(fake.calls).toEqual([]);
  });
});

describe("strict native health enrollment", () => {
  test("fails on a timer failure that enroll only warns about", async () => {
    const fake = timers([{ id: idA }], managedHealthUnitName(prefix, keyA, "main"));
    const error = await run(Effect.flip(fake.health.enrollStrictly(idA)));
    expect(error.details).toMatchObject({ stderr: "Failed to start transient timer unit" });
    expect(fake.warnings).toEqual([]);
  });

  test("fails for a container with no scheduled healthcheck", async () => {
    const fake = timers([]);
    const error = await run(Effect.flip(fake.health.enrollStrictly(idA)));
    expect(error._tag).toBe("ProviderUnavailableError");
    expect(fake.calls).toEqual([]);
  });
});

describe("native health reconcile", () => {
  test("stops stale runs in one call and creates only the role a failed attempt left missing", async () => {
    // Given a start interval run whose main timer failed to start, plus a removed container's timer
    const failing = timers([{ id: idA, startInterval: true }], managedHealthUnitName(prefix, keyA, "main"));
    await run(Effect.flip(failing.health.enroll(idA)));
    const stale = managedHealthUnitName(prefix, managedHealthRunKey(idB, startedAt), "main");
    const fake = timers([{ id: idA, startInterval: true }]);
    for (const [name, active] of failing.units) fake.units.set(name, active);
    fake.units.set(`${stale}.timer`, true);
    // When
    await run(fake.health.reconcile);
    // Then
    const stops = fake.calls.filter((argv) => argv[2] === "stop");
    expect(stops).toEqual([
      ["/usr/bin/systemctl", "--user", "stop", `${prefix}${managedHealthRunKey(idB, startedAt)}-*`],
    ]);
    expect(created(fake.calls)).toEqual([managedHealthUnitName(prefix, keyA, "main")]);
  });

  test("keeps an explicitly scheduled unowned container's current timers without creating any", async () => {
    // Given setup's smoke container, which Lando does not own, scheduled by another command
    const fake = timers([{ id: idA, owned: false }]);
    fake.units.set(`${managedHealthUnitName(prefix, keyA, "main")}.timer`, true);
    // When a concurrent lifecycle command reconciles
    await run(fake.health.reconcile);
    // Then its running timer survives and reconcile adds nothing for it
    expect(fake.calls.filter((argv) => argv[2] === "stop")).toEqual([]);
    expect(created(fake.calls)).toEqual([]);
  });

  test("sweeps the previous run of an unowned container that restarted", async () => {
    const fake = timers([{ id: idA, owned: false, startedAt: "1970-01-01T00:00:00.5Z" }]);
    fake.units.set(`${managedHealthUnitName(prefix, keyA, "main")}.timer`, true);
    await run(fake.health.reconcile);
    expect(fake.units.size).toBe(0);
    expect(created(fake.calls)).toEqual([]);
  });

  test("restarts a run whose missing role still has loaded units instead of colliding on its name", async () => {
    const fake = timers([{ id: idA, startInterval: true }]);
    fake.units.set(`${managedHealthUnitName(prefix, keyA, "start")}.timer`, false);
    fake.units.set(`${managedHealthUnitName(prefix, keyA, "main")}.timer`, true);
    await run(fake.health.reconcile);
    expect(fake.calls.filter((argv) => argv[2] === "stop")).toEqual([
      ["/usr/bin/systemctl", "--user", "stop", `${prefix}${keyA}-*`],
    ]);
    expect(created(fake.calls)).toEqual([
      managedHealthUnitName(prefix, keyA, "start"),
      managedHealthUnitName(prefix, keyA, "main"),
    ]);
  });

  test("an unreadable runtime API warns and sweeps no timers", async () => {
    const fake = timers([], undefined, failingApi);
    fake.units.set(`${managedHealthUnitName(prefix, keyA, "main")}.timer`, true);
    await run(fake.health.reconcile);
    expect(fake.warnings.map((warning) => warning.operation)).toEqual(["nativeHealth"]);
    expect([...fake.units.keys()]).toEqual([`${managedHealthUnitName(prefix, keyA, "main")}.timer`]);
  });
});
