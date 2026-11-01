import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tcpProbe, tcpThenProbe } from "../src/services/_tcp-probe.ts";

const modes = ["bash-timeout", "bash", "nc"] as const;
const outcomes = [
  { listening: true, trailing: false, exit: 0 },
  { listening: true, trailing: true, exit: 0 },
  { listening: true, trailing: true, exit: 37 },
  { listening: false, trailing: false, exit: 1 },
  { listening: false, trailing: true, exit: 1 },
] as const;

test
  .skipIf(process.platform === "win32")
  .each(modes.flatMap((mode) => outcomes.map((outcome) => ({ mode, ...outcome }))))(
  "$mode: listening=$listening trailing=$trailing exit=$exit",
  async (input) => {
    // Given: real tools on a restricted PATH and an ephemeral TCP listener.
    const root = await mkdtemp(join(tmpdir(), "lando-tcp-probe-"));
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data() {},
        open(socket) {
          socket.end();
        },
      },
    });
    const port = server.port;
    if (!input.listening) server.stop(true);
    try {
      const tools = input.mode === "nc" ? ["nc"] : input.mode === "bash" ? ["bash"] : ["bash", "timeout"];
      for (const tool of tools) {
        const executable = Bun.which(tool);
        if (executable === null) throw new Error(`Process test needs ${tool}`);
        await symlink(executable, join(root, tool));
      }
      const args = ["", "two words", "$(exit 99)", "single'quote", 'double"quote'];
      const trailing = ["/bin/sh", "-c", 'printf "<%s>\\n" "$@"; exit "$CLIENT_EXIT"', "client", ...args];
      const probe = input.trailing ? tcpThenProbe(port, trailing, 10) : tcpProbe(port, 10);
      const command = probe.command;
      if (command === undefined || typeof command === "string") throw new Error("Missing argv probe");
      // When: the generated POSIX script dials before optionally executing exact argv.
      const child = Bun.spawn(["/bin/sh", ...command.slice(1)], {
        env: {
          PATH: root,
          LANDO_PROBE_HOST: "127.0.0.1",
          LANDO_PROBE_PORT: String(port),
          CLIENT_EXIT: String(input.exit),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // Then: failed dials never run the client; successful dials preserve args and status.
      expect(exit).toBe(input.exit);
      expect(stdout).toBe(input.listening && input.trailing ? args.map((arg) => `<${arg}>\n`).join("") : "");
      expect(stderr).toBe(
        input.listening ? "" : `Lando's TCP probe could not connect to 127.0.0.1:${port}\n`,
      );
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "reports missing dial tools without running trailing argv",
  async () => {
    // Given: an empty PATH and a client that would otherwise succeed.
    const root = await mkdtemp(join(tmpdir(), "lando-tcp-no-tools-"));
    try {
      const probe = tcpThenProbe(1234, ["/bin/sh", "-c", "printf unexpected"], 10);
      const command = probe.command;
      if (command === undefined || typeof command === "string") throw new Error("Missing argv probe");
      // When
      const child = Bun.spawn(["/bin/sh", ...command.slice(1)], {
        env: { PATH: root, LANDO_PROBE_HOST: "127.0.0.1", LANDO_PROBE_PORT: "1234" },
        stdout: "pipe",
        stderr: "pipe",
      });
      // Then
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stdout).text()).toBe("");
      expect(await new Response(child.stderr).text()).toBe(
        "Lando's TCP probe needs bash or nc in this image\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")("bounds a stalled bash dial with timeout", async () => {
  // Given: a bash stand-in that never completes its dial within the budget.
  const root = await mkdtemp(join(tmpdir(), "lando-tcp-deadline-"));
  try {
    for (const tool of ["sleep", "timeout"]) {
      const executable = Bun.which(tool);
      if (executable === null) throw new Error(`Process test needs ${tool}`);
      await symlink(executable, join(root, tool));
    }
    await Bun.write(join(root, "bash"), "#!/bin/sh\nexec sleep 30\n");
    await chmod(join(root, "bash"), 0o755);
    const command = tcpProbe(1234, 10).command;
    // When: an independent test deadline guards against a broken in-container deadline.
    const child = Bun.spawn(["/bin/sh", ...command.slice(1)], {
      env: { PATH: root, LANDO_PROBE_HOST: "127.0.0.1", LANDO_PROBE_PORT: "1234" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 4000,
    });
    // Then: the script itself reports the failed dial rather than being killed by the test.
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toBe(
      "Lando's TCP probe could not connect to 127.0.0.1:1234\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves custom timing and a declared non-loopback target", () => {
  // Given / When
  const probe = tcpProbe(43210, 90, { intervalSeconds: 15, timeoutSeconds: 9, retries: 0 });
  // Then
  expect(probe).toMatchObject({
    kind: "command",
    target: { port: 43210, transport: "tcp", names: [], primary: false },
    startPeriodSeconds: 90,
    intervalSeconds: 15,
    timeoutSeconds: 9,
    retries: 0,
  });
  expect(probe.user).toBeUndefined();
});
