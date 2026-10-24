import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mssqlHealthcheck, mssqlStartupCommand } from "../src/services/mssql-startup.ts";

const server = `#!/bin/bash
trap 'printf "stopped\\n" >> "$RECORD"; exit 0' TERM INT
printf '%s' "$$" > "$PIDFILE"
printf 'server\\n' >> "$RECORD"
while :; do sleep 0.01; done
`;
const client = `#!/bin/bash
printf '%s\\n' "$SQLCMDPASSWORD" >> "$PASSWORD_RECORD"
printf '%s\\n' "$@" >> "$RECORD"
query="\${!#}"
if [[ "$query" == 'SELECT 1' ]]; then
  if [[ ! -f "$PIDFILE" ]]; then exit 8; fi
  if [[ "$FAIL_READY" == yes ]]; then exit 8; fi
  exit 0
fi
if [[ -n "$DATABASE_ACCESS" && "$query" == *'HAS_DBACCESS(name) = 1'* && "$DATABASE_ACCESS" != 1 ]]; then exit 9; fi
printf 'initialized\\n'
if [[ "$SIGNAL_INIT" == yes ]]; then kill -TERM "$PPID"; fi
if [[ "$FAIL_INIT" == yes ]]; then exit 9; fi
if [[ "$KEEP_RUNNING" != yes ]]; then kill -TERM "$(cat "$PIDFILE")"; fi
`;

const linuxTest = test.skipIf(process.platform === "win32");

linuxTest.each(["startup", "healthcheck"] as const)("keeps hostile %s values inert", async (surface) => {
  // Given: database and password values contain shell syntax targeting unique sentinel files.
  const root = await mkdtemp(join(tmpdir(), "lando-mssql-launch-"));
  try {
    const dbSubstitution = join(root, "db-substitution");
    const dbBacktick = join(root, "db-backtick");
    const passwordSubstitution = join(root, "password-substitution");
    const passwordBacktick = join(root, "password-backtick");
    const sentinels = [dbSubstitution, dbBacktick, passwordSubstitution, passwordBacktick];
    const databaseShellText = `"quoted" $(touch ${dbSubstitution}) \`touch ${dbBacktick}\``;
    const database = `a]'quoted${databaseShellText}`;
    const password = `"quoted" 'password $(touch ${passwordSubstitution}) \`touch ${passwordBacktick}\``;
    const paths = { server: join(root, "sqlservr"), client: join(root, "sqlcmd") };
    await Bun.write(paths.server, server);
    await Bun.write(paths.client, client);
    await chmod(paths.server, 0o700);
    await chmod(paths.client, 0o700);
    const builder = surface === "startup" ? mssqlStartupCommand : mssqlHealthcheck;
    const command = builder(database, 14330).map((part) =>
      part
        .replaceAll("/opt/mssql/bin/sqlservr", paths.server)
        .replaceAll("/opt/mssql-tools18/bin/sqlcmd", paths.client),
    );
    // When: the actual generated shell command executes against the recording client.
    const child = Bun.spawn([...command], {
      env: {
        ...process.env,
        BASH_ENV: "",
        SA_PASSWORD: password,
        KEEP_RUNNING: surface === "healthcheck" ? "yes" : "no",
        RECORD: join(root, "calls"),
        PIDFILE: join(root, "pid"),
        PASSWORD_RECORD: join(root, "passwords"),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    // Then: SQL stays one argv value, the password stays environment text, and no syntax executes.
    expect(await child.exited).toBe(0);
    const calls = await Bun.file(join(root, "calls")).text();
    const expectedQuery =
      surface === "startup"
        ? `IF DB_ID(N'a]''quoted${databaseShellText}') IS NULL EXEC(N'CREATE DATABASE [a]]''quoted${databaseShellText}]');`
        : `IF NOT EXISTS (SELECT 1 FROM sys.databases WHERE name = N'a]''quoted${databaseShellText}' AND state_desc = 'ONLINE' AND HAS_DBACCESS(name) = 1) THROW 50000, 'Database is not accessible', 1;`;
    expect(calls.split("\n")).toContain(expectedQuery);
    expect(calls).not.toContain(password);
    const passwords = (await Bun.file(join(root, "passwords")).text()).trimEnd().split("\n");
    expect(passwords.length).toBeGreaterThanOrEqual(surface === "startup" ? 2 : 1);
    for (const recordedPassword of passwords) expect(recordedPassword).toBe(password);
    for (const sentinel of sentinels) expect(await Bun.file(sentinel).exists()).toBe(false);
    if (surface === "startup") {
      expect(calls).toContain("server\n");
      expect(calls).toContain("SELECT 1\n");
      expect(calls).toContain("stopped\n");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

linuxTest.each(["failure", "signal", "timeout"] as const)("reaps the server on %s", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "lando-mssql-reap-"));
  try {
    const serverPath = join(root, "sqlservr");
    const clientPath = join(root, "sqlcmd");
    await Bun.write(serverPath, server);
    await Bun.write(clientPath, client);
    await chmod(serverPath, 0o700);
    await chmod(clientPath, 0o700);
    if (mode === "timeout") {
      await Bun.write(
        join(root, "sleep"),
        '#!/bin/sh\nif [ "$1" = 1 ]; then exit 0; fi\nexec /bin/sleep "$@"\n',
      );
      await chmod(join(root, "sleep"), 0o700);
    }
    const child = Bun.spawn(
      mssqlStartupCommand("app", 1433).map((part) =>
        part
          .replaceAll("/opt/mssql/bin/sqlservr", serverPath)
          .replaceAll("/opt/mssql-tools18/bin/sqlcmd", clientPath),
      ),
      {
        env: {
          ...process.env,
          BASH_ENV: "",
          SA_PASSWORD: "private",
          FAIL_INIT: mode === "failure" ? "yes" : "no",
          SIGNAL_INIT: mode === "signal" ? "yes" : "no",
          KEEP_RUNNING: "yes",
          FAIL_READY: mode === "timeout" ? "yes" : "no",
          PATH: `${root}:${process.env.PATH ?? ""}`,
          RECORD: join(root, "calls"),
          PIDFILE: join(root, "pid"),
          PASSWORD_RECORD: join(root, "passwords"),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      },
    );
    expect(await child.exited).toBe(mode === "failure" ? 9 : mode === "signal" ? 143 : 1);
    const calls = await Bun.file(join(root, "calls")).text();
    expect(calls).toContain("stopped\n");
    if (mode === "timeout") {
      expect(calls.match(/SELECT 1/gu)?.length).toBe(60);
      expect(calls).not.toContain("CREATE DATABASE");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

linuxTest.each(["1", "0", "NULL"])("checks access to an ONLINE database (%s)", async (access) => {
  // Given: the recording SQL client models an ONLINE database with the supplied access verdict.
  const root = await mkdtemp(join(tmpdir(), "lando-mssql-access-"));
  try {
    const clientPath = join(root, "sqlcmd");
    await Bun.write(clientPath, client);
    await chmod(clientPath, 0o700);
    const command = mssqlHealthcheck("app", 1433).map((part) =>
      part.replaceAll("/opt/mssql-tools18/bin/sqlcmd", clientPath),
    );
    // When: the generated master-connected healthcheck executes.
    const child = Bun.spawn([...command], {
      env: {
        ...process.env,
        BASH_ENV: "",
        SA_PASSWORD: "private",
        DATABASE_ACCESS: access,
        KEEP_RUNNING: "yes",
        RECORD: join(root, "calls"),
        PASSWORD_RECORD: join(root, "passwords"),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    // Then: only an accessible target is ready, including fail-closed NULL handling.
    expect(await child.exited).toBe(access === "1" ? 0 : 9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("healthcheck uses master and only observes target database state", () => {
  const argv = mssqlHealthcheck("a]'quoted", 14330);
  expect(argv).toContain("master");
  expect(argv).toContain("localhost,14330");
  expect(argv).not.toContain("-P");
  expect(argv.at(-1)).toContain("name = N'a]''quoted'");
  expect(argv.at(-1)).toContain("state_desc = 'ONLINE'");
  expect(argv.at(-1)).not.toContain("CREATE");
});
