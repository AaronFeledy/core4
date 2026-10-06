import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import {
  type ExecConmonProcess,
  type ExecConmonReaper,
  isLingeringExecConmon,
  managedConmonPath,
  managedConmonPathForPodman,
  reapLingeringExecConmons,
} from "../src/exec-conmon.ts";

const conmonPath = "/tmp/udr/runtime/bin/conmon";

const execArgv = (
  name: string,
  containerId = "c9b6470ff4a427d6560e64c0bebb75fd9ce5cecd",
): ReadonlyArray<string> => [
  conmonPath,
  "--api-version",
  "1",
  "-c",
  containerId,
  "-n",
  name,
  "--exec-attach",
  "--exit-delay",
  "300",
];

const monitorArgv = (name: string): ReadonlyArray<string> => [
  conmonPath,
  "-c",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "-n",
  name,
];

const reaperFor = (
  processes: ReadonlyArray<ExecConmonProcess>,
  killed: number[],
  killErrorPids: ReadonlySet<number> = new Set(),
): ExecConmonReaper => ({
  listArgv: Effect.succeed(processes),
  kill: (pid) =>
    killErrorPids.has(pid)
      ? Effect.fail(new Error("EPERM"))
      : Effect.sync(() => {
          killed.push(pid);
        }),
});

const run = <A>(effect: Effect.Effect<A, never>): Promise<A> => Effect.runPromise(effect);

describe("lingering exec conmon", () => {
  test("recognizes only this runtime's exec monitors", () => {
    expect(managedConmonPath("/tmp/udr/runtime/bin/")).toBe("/tmp/udr/runtime/bin/conmon");
    expect(managedConmonPathForPodman("/tmp/udr/runtime/bin/podman")).toBe("/tmp/udr/runtime/bin/conmon");
    expect(isLingeringExecConmon(execArgv("lando-global-traefik-diagnostics"), conmonPath)).toBe(true);
    expect(isLingeringExecConmon(monitorArgv("lando-global-traefik-diagnostics"), conmonPath)).toBe(false);
    expect(isLingeringExecConmon(["/usr/bin/conmon", "--exec-attach", "-n", "other"], conmonPath)).toBe(
      false,
    );
    expect(
      isLingeringExecConmon(execArgv("lando-app-database"), conmonPath, {
        names: new Set(["lando-global-traefik-diagnostics"]),
      }),
    ).toBe(false);
    expect(
      isLingeringExecConmon(
        execArgv("lando-global-traefik-diagnostics", "abcdef1234567890ffff"),
        conmonPath,
        {
          containerIds: new Set(["abcdef1234567890"]),
        },
      ),
    ).toBe(true);
  });

  test("SIGKILLs exec monitors for removed containers and leaves other conmon alone", async () => {
    const killed: number[] = [];
    const processes: ReadonlyArray<ExecConmonProcess> = [
      { pid: 10, argv: execArgv("lando-global-traefik-diagnostics") },
      { pid: 11, argv: execArgv("lando-global-traefik-diagnostics") },
      { pid: 12, argv: monitorArgv("lando-global-traefik-diagnostics") },
      { pid: 13, argv: execArgv("lando-app-appserver") },
      { pid: 14, argv: ["/usr/bin/conmon", "--exec-attach", "-n", "lando-global-traefik-diagnostics"] },
    ];

    const killedCount = await run(
      reapLingeringExecConmons({
        conmonPath,
        names: new Set(["lando-global-traefik-diagnostics"]),
        reaper: reaperFor(processes, killed),
      }),
    );

    expect(killedCount).toBe(2);
    expect(killed).toEqual([10, 11]);
  });

  test("on runtime stop, SIGKILLs every managed exec monitor and ignores a kill failure", async () => {
    const killed: number[] = [];
    const processes: ReadonlyArray<ExecConmonProcess> = [
      { pid: 21, argv: execArgv("lando-us-appserver") },
      { pid: 22, argv: execArgv("lando-global-ssh-agent") },
      { pid: 23, argv: monitorArgv("lando-global-ssh-agent") },
    ];

    const killedCount = await run(
      reapLingeringExecConmons({
        conmonPath,
        reaper: reaperFor(processes, killed, new Set([22])),
      }),
    );

    expect(killedCount).toBe(1);
    expect(killed).toEqual([21]);
  });
});
