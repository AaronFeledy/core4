import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phpXdebugTooling } from "../src/services/php-xdebug.ts";

const runStatus = async (options: {
  readonly host?: string;
  readonly address?: string;
  readonly gateway?: string;
  readonly kernel?: string;
  readonly result?: string;
  readonly command?: string;
  readonly realPhp?: boolean;
  readonly port?: number | string;
  readonly slowDns?: boolean;
}) => {
  const root = await mkdtemp(join(tmpdir(), "lando-xdebug-"));
  try {
    const scripts = {
      php: `#!/bin/sh
case "$2" in
  *stream_socket_client*)
    printf '%s\\n' "$@" > "$PROBE_ARGV"
    ${options.realPhp ? 'exec /usr/bin/php "$@"' : 'printf "Listener: %s\\n" "$PROBE_RESULT"; [ "$PROBE_RESULT" = "TCP listener reachable" ]'} ;;
  *xdebug.client_host*) printf '%s' "$CLIENT_HOST" ;;
  *xdebug.client_port*) printf '%s' "$CLIENT_PORT" ;;
  *) printf 'Xdebug enabled (debug)\\n' ;;
esac`,
      getent: `#!/bin/sh
if [ "$1" = -s ]; then shift 2; else
  ${options.slowDns ? "exec sleep 10" : ":"}
fi
shift
[ "$1" = -- ] && shift
case "$1" in
  host.lando.internal) address="$GATEWAY" ;;
  *) address="$CLIENT_ADDRESS" ;;
esac
[ -n "$address" ] && printf '%s alias\\n' "$address"`,
      uname: '#!/bin/sh\nprintf "%s\\n" "$KERNEL"',
    };
    for (const [name, script] of Object.entries(scripts)) {
      const path = join(root, name);
      await Bun.write(path, script);
      await chmod(path, 0o755);
    }
    const task = phpXdebugTooling("php", "cli", "debug").xdebug;
    if (!Array.isArray(task?.cmd) || typeof task.cmd[2] !== "string") {
      throw new TypeError("Missing tooling script");
    }
    const script = task.cmd[2].replace(
      'ini="/usr/local/etc/php/conf.d/zz-lando-xdebug.ini"',
      'ini="$TEST_INI"',
    );
    const child = Bun.spawn(
      [
        "sh",
        "-c",
        script,
        "xdebug",
        ...(options.command === "implicit" ? [] : [options.command ?? "status"]),
      ],
      {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          TEST_INI: join(root, "xdebug.ini"),
          PROBE_ARGV: join(root, "argv"),
          PROBE_RESULT: options.result ?? "TCP connection failed (Connection refused)",
          CLIENT_HOST: options.host ?? "debugger.lando.internal",
          CLIENT_PORT: String(options.port ?? 9003),
          CLIENT_ADDRESS: options.address ?? "",
          GATEWAY: options.gateway ?? "172.27.48.1",
          KERNEL: options.kernel ?? "linux",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const exit = await child.exited;
    const argv = Bun.file(join(root, "argv"));
    return { output, stderr, exit, argv: (await argv.exists()) ? await argv.text() : undefined };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

for (const address of ["172.27.48.1", "2001:db8::40", undefined]) {
  test(`status diagnoses ${address ?? "unresolved host"} without failing the command`, async () => {
    // Given / When
    const result = await runStatus({
      host: "custom-ide.internal",
      ...(address === undefined ? {} : { address }),
    });
    // Then
    expect(result.exit).toBe(0);
    expect(result.output).toContain(`Client: custom-ide.internal:9003${address ? ` (${address})` : ""}`);
    expect(result.output).toContain("Listener: TCP connection failed (Connection refused)");
    expect(result.argv?.split("\n").slice(-5)).toEqual([
      "--",
      "custom-ide.internal",
      "9003",
      address ?? "",
      "",
    ]);
    expect(result.output).toContain("If this is your IDE address");
    expect(result.output).not.toContain("IDE runs on Windows");
  });
}

test("status reports TCP reachability without claiming DBGp acceptance", async () => {
  // Given / When
  const result = await runStatus({ address: "172.27.48.1", result: "TCP listener reachable" });
  // Then
  expect(result.exit).toBe(0);
  expect(result.output).toContain("Listener: TCP listener reachable");
  expect(result.output).not.toContain("DBGp");
  expect(result.output).not.toContain("If ");
});

for (const command of ["on", "off", "implicit"]) {
  test(`${command} prints status without a listener probe`, async () => {
    // Given / When
    const result = await runStatus({ command, slowDns: true });
    // Then
    expect(result.exit).toBe(0);
    expect(result.output).toContain("Xdebug enabled (debug)");
    expect(result.output).not.toContain("Listener:");
    expect(result.argv).toBeUndefined();
  });
}

for (const [address, kernel, windowsHint] of [
  ["172.27.48.1", "6.6-microsoft-standard-WSL2", true],
  ["172.27.48.2", "6.6-microsoft-standard-WSL2", false],
  ["172.27.48.1", "linux", false],
] as const) {
  test(`status hint distinguishes gateway ${address} on ${kernel}`, async () => {
    // Given / When
    const result = await runStatus({ address, kernel });
    // Then
    expect(result.output.includes("If your IDE runs on Windows")).toBe(windowsHint);
    expect(result.output.includes("lando config set debugger.host windows, then lando start")).toBe(
      windowsHint,
    );
    expect(result.output.includes("If this is your IDE address")).toBe(address !== "172.27.48.1");
  });
}

test("command-looking host and port remain argv data", async () => {
  // Given
  const host = "$(exit 72);'\"\\ide";
  // When
  const result = await runStatus({ host });
  // Then
  expect(result.exit).toBe(0);
  expect(result.argv?.split("\n").slice(-5)).toEqual(["--", host, "9003", "", ""]);
});

const phpAvailable = Bun.which("php") === "/usr/bin/php";
for (const host of ["127.0.0.1", "::1", "[::1]"]) {
  test.skipIf(!phpAvailable)(`real PHP connects and closes a TCP listener at ${host}`, async () => {
    // Given
    let accepted = 0;
    const listener = Bun.listen({
      hostname: host === "127.0.0.1" ? host : "::1",
      port: 0,
      socket: {
        open(socket) {
          accepted++;
          socket.end();
        },
        data() {},
      },
    });
    try {
      // When
      const result = await runStatus({ realPhp: true, host, port: listener.port });
      // Then
      expect(result.exit).toBe(0);
      expect(result.output).toContain("Listener: TCP listener reachable");
      expect(accepted).toBe(1);
    } finally {
      listener.stop(true);
    }
  });
}

for (const host of ["127.0.0.1", "[::1]", "unresolved.invalid"]) {
  test.skipIf(!phpAvailable)(`real PHP handles failed destination ${host}`, async () => {
    // Given / When
    const result = await runStatus({ realPhp: true, host, port: 1 });
    // Then
    expect(result.exit).toBe(0);
    expect(result.output).toContain("Listener: TCP connection failed (");
    expect(result.stderr).toBe("");
    expect(result.output.includes("unresolved within one second")).toBe(host === "unresolved.invalid");
  });
}

test.skipIf(!phpAvailable)(
  "DNS timeout remains a successful diagnostic command",
  async () => {
    // Given / When
    const result = await runStatus({ realPhp: true, host: "slow.invalid", slowDns: true });
    // Then
    expect(result.exit).toBe(0);
    expect(result.output).toContain("host unresolved within one second");
  },
  4000,
);

test.skipIf(!phpAvailable)("real PHP rejects a command-looking port as data", async () => {
  const port = "9003;$(exit 72)'\"";
  const result = await runStatus({ realPhp: true, host: "127.0.0.1", port });
  expect(result.exit).toBe(0);
  expect(result.output).toContain("Listener: TCP connection failed (invalid port)");
  expect(result.argv?.split("\n").slice(-5)).toEqual(["--", "127.0.0.1", port, "", ""]);
});
