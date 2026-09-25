import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { type MachineSpawn, makeSystemPodmanMachineRunner, setupProviderLando } from "../src/setup.ts";

const output = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

const capturingSpawn = (vmType: string, rootful: boolean) => {
  const calls: string[][] = [];
  const spawn: MachineSpawn = (argv) => {
    calls.push([...argv]);
    const stdout =
      argv[1] === "machine" && argv[2] === "info"
        ? JSON.stringify({ Host: { VMType: vmType } })
        : argv[1] === "machine" && argv[2] === "inspect"
          ? JSON.stringify([{ Rootful: rootful }])
          : "";
    return { stdout: output(stdout), stderr: output(""), exited: Promise.resolve(0) };
  };
  return { spawn, calls };
};

describe("Windows managed machine API socket activation", () => {
  test("activates only a rootful WSL machine's guest socket", async () => {
    const { spawn, calls } = capturingSpawn("wsl", true);
    const runner = makeSystemPodmanMachineRunner("podman", "lando", "win32", spawn);
    await Effect.runPromise(runner.activateApiSocket ?? Effect.void);

    expect(calls.slice(0, 2)).toEqual([
      ["podman", "machine", "info", "--format", "json"],
      ["podman", "machine", "inspect", "lando"],
    ]);
    expect(calls[2]?.slice(0, 8)).toEqual([
      "wsl.exe",
      "--distribution",
      "podman-lando",
      "--user",
      "root",
      "--exec",
      "sh",
      "-c",
    ]);
    expect(calls[2]?.[8]).toContain("nsenter --target");
    expect(calls[2]?.[8]).toContain("systemctl enable --now podman.socket");
  });

  test("does not use WSL for a Hyper-V machine", async () => {
    const { spawn, calls } = capturingSpawn("hyperv", true);
    const runner = makeSystemPodmanMachineRunner("podman", "lando", "win32", spawn);
    await Effect.runPromise(runner.activateApiSocket ?? Effect.void);
    expect(calls).toEqual([["podman", "machine", "info", "--format", "json"]]);
  });

  test("does not activate a rootless existing machine's root socket", async () => {
    const { spawn, calls } = capturingSpawn("wsl", false);
    const runner = makeSystemPodmanMachineRunner("podman", "lando", "win32", spawn);
    await Effect.runPromise(runner.activateApiSocket ?? Effect.void);
    expect(calls).toEqual([
      ["podman", "machine", "info", "--format", "json"],
      ["podman", "machine", "inspect", "lando"],
    ]);
  });

  test("classifies Windows listeners only when every owner is the canonical WSL relay", async () => {
    const calls: string[][] = [];
    const spawn: MachineSpawn = (argv) => {
      calls.push([...argv]);
      return {
        stdout: output(
          JSON.stringify([
            { port: 38080, owner: "wslrelay" },
            { port: 28443, owner: "foreign" },
          ]),
        ),
        stderr: output(""),
        exited: Promise.resolve(0),
      };
    };
    const runner = makeSystemPodmanMachineRunner("podman", "lando", "win32", spawn);
    const owners = await Effect.runPromise(
      runner.hostPortOwners?.([38080, 28443]) ?? Effect.succeed(new Map()),
    );
    expect([...owners]).toEqual([
      [38080, "wslrelay"],
      [28443, "foreign"],
    ]);
    expect(calls[0]?.slice(0, 3)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive"]);
    expect(calls[0]?.[4]).toContain("CimInstance Win32_Process");
    expect(calls[0]?.[4]).toContain("WSL/wslrelay.exe");
  });
  test("fails closed when Windows listener enumeration fails", async () => {
    const spawn: MachineSpawn = () => ({
      stdout: output(""),
      stderr: output("access denied"),
      exited: Promise.resolve(1),
    });
    const runner = makeSystemPodmanMachineRunner("podman", "lando", "win32", spawn);
    const result = await Effect.runPromise(
      Effect.either(runner.hostPortOwners?.([38080]) ?? Effect.succeed(new Map())),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left._tag).toBe("ProviderUnavailableError");
  });
  test("reads only candidate TCP listeners in the owned running WSL machine", async () => {
    const calls: string[][] = [];
    const spawn: MachineSpawn = (argv) => {
      calls.push([...argv]);
      const stdout =
        argv[1] === "machine" && argv[2] === "info"
          ? JSON.stringify({ Host: { VMType: "wsl" } })
          : argv[1] === "machine" && argv[2] === "inspect"
            ? JSON.stringify([{ State: "running" }])
            : argv.includes("nft")
              ? JSON.stringify({ nftables: [{ metainfo: {} }] })
              : "LISTEN 0 4096 *:80 *:*\nLISTEN 0 4096 127.0.0.1:443 0.0.0.0:*\nLISTEN 0 4096 [::]:9999 [::]:*\n";
      return { stdout: output(stdout), stderr: output(""), exited: Promise.resolve(0) };
    };
    const runner = makeSystemPodmanMachineRunner("podman", "lando", "win32", spawn);
    const occupied = await Effect.runPromise(
      runner.occupiedPublishPorts?.([80, 443, 8443]) ?? Effect.succeed([]),
    );
    expect(occupied).toEqual([80, 443]);
    expect(calls[2]).toEqual([
      "wsl.exe",
      "--distribution",
      "podman-lando",
      "--user",
      "root",
      "--exec",
      "ss",
      "-H",
      "-ltn",
    ]);
  });

  test("reuses only DNAT claims that point exclusively to the current container IP", async () => {
    const nft = JSON.stringify({
      nftables: [
        {
          rule: {
            family: "inet",
            table: "netavark",
            chain: "NETAVARK-HOSTPORT-DNAT",
            expr: [
              { match: { op: "==", left: { payload: { protocol: "tcp", field: "dport" } }, right: 18080 } },
              { jump: { target: "current" } },
            ],
          },
        },
        {
          rule: {
            family: "inet",
            table: "netavark",
            chain: "current",
            expr: [
              { match: { op: "==", left: { payload: { protocol: "tcp", field: "dport" } }, right: 18080 } },
              { dnat: { family: "ip", addr: "10.89.1.2", port: 80 } },
            ],
          },
        },
        {
          rule: {
            family: "inet",
            table: "netavark",
            chain: "NETAVARK-HOSTPORT-DNAT",
            expr: [
              { match: { op: "==", left: { payload: { protocol: "tcp", field: "dport" } }, right: 8888 } },
              { jump: { target: "stale" } },
            ],
          },
        },
        {
          rule: {
            family: "inet",
            table: "netavark",
            chain: "stale",
            expr: [
              { match: { op: "==", left: { payload: { protocol: "tcp", field: "dport" } }, right: 8888 } },
              { dnat: { family: "ip", addr: "10.89.1.5", port: 80 } },
            ],
          },
        },
      ],
    });
    const spawn: MachineSpawn = (argv) => ({
      stdout: output(argv[1] === "machine" ? JSON.stringify({ Host: { VMType: "wsl" } }) : nft),
      stderr: output(""),
      exited: Promise.resolve(0),
    });
    const runner = makeSystemPodmanMachineRunner("podman", "lando", "win32", spawn);
    expect(
      await Effect.runPromise(
        runner.matchingPublishPorts?.([18080, 8888], ["10.89.1.2"]) ?? Effect.succeed([]),
      ),
    ).toEqual([18080]);
  });
  test("does not claim published ports on a non-WSL machine without an ownership probe", async () => {
    const hyperv = capturingSpawn("hyperv", true);
    const runner = makeSystemPodmanMachineRunner("podman", "lando", "win32", hyperv.spawn);
    const matching = await Effect.runPromise(
      runner.matchingPublishPorts?.([38080], ["10.89.1.2"]) ?? Effect.succeed([]),
    );
    expect(matching).toEqual([]);
    expect(hyperv.calls).toEqual([["podman", "machine", "info", "--format", "json"]]);
  });

  test("skips guest probes for Hyper-V and stopped machines", async () => {
    const hyperv = capturingSpawn("hyperv", true);
    const runner = makeSystemPodmanMachineRunner("podman", "lando", "win32", hyperv.spawn);
    expect(await Effect.runPromise(runner.occupiedPublishPorts?.([80]) ?? Effect.succeed([]))).toEqual([]);
    expect(hyperv.calls).toEqual([["podman", "machine", "info", "--format", "json"]]);
  });

  test("setup activates a newly created machine before API readiness", async () => {
    const calls: string[] = [];
    await Effect.runPromise(
      setupProviderLando({
        platform: "win32",
        podmanCommand: { version: Effect.succeed("podman version 6.0.2") },
        podmanApi: {
          info: Effect.sync(() => {
            calls.push("api-info");
            return { version: { Version: "6.0.2" } };
          }),
          ping: Effect.void,
        },
        podmanMachine: {
          inspect: Effect.succeed("missing"),
          create: Effect.sync(() => calls.push("create")).pipe(Effect.asVoid),
          start: Effect.sync(() => calls.push("start")).pipe(Effect.asVoid),
          activateApiSocket: Effect.sync(() => calls.push("activate")).pipe(Effect.asVoid),
          stop: Effect.void,
          upgrade: Effect.void,
          teardown: Effect.void,
        },
      }),
    );
    expect(calls).toEqual(["create", "start", "activate", "api-info"]);
  });

  test("setup retries activation for an existing Lando-owned machine", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-owned-machine-socket-"));
    const calls: string[] = [];
    try {
      await mkdir(join(stateDir, "provider-lando"), { recursive: true });
      await writeFile(
        join(stateDir, "provider-lando", "setup-state.json"),
        JSON.stringify({
          machine: { name: "lando", createdByLando: true, createdAt: "2026-09-22T00:00:00Z" },
        }),
      );
      await Effect.runPromise(
        setupProviderLando({
          platform: "win32",
          stateDir,
          podmanCommand: { version: Effect.succeed("podman version 6.0.2") },
          podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" } }), ping: Effect.void },
          podmanMachine: {
            inspect: Effect.succeed("running"),
            createdAt: Effect.succeed("2026-09-22T00:00:00Z"),
            create: Effect.void,
            start: Effect.void,
            activateApiSocket: Effect.sync(() => calls.push("activate")).pipe(Effect.asVoid),
            stop: Effect.void,
            upgrade: Effect.void,
            teardown: Effect.void,
          },
        }),
      );
      expect(calls).toEqual(["activate"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
  test("setup leaves an existing unowned machine's socket untouched", async () => {
    const calls: string[] = [];
    await Effect.runPromise(
      setupProviderLando({
        platform: "win32",
        podmanCommand: { version: Effect.succeed("podman version 6.0.2") },
        podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" } }), ping: Effect.void },
        podmanMachine: {
          inspect: Effect.succeed("running"),
          create: Effect.void,
          start: Effect.void,
          activateApiSocket: Effect.sync(() => calls.push("activate")).pipe(Effect.asVoid),
          stop: Effect.void,
          upgrade: Effect.void,
          teardown: Effect.void,
        },
      }),
    );
    expect(calls).toEqual([]);
  });
});
