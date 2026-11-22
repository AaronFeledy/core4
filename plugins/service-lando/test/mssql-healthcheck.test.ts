import { expect, test } from "bun:test";
import { mssqlHealthcheck } from "../src/services/mssql-healthcheck.ts";

test.skipIf(process.platform === "win32").each([
  [0, "", 0],
  [1, "Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Login failed for user 'sa'..", 0],
  [1, "Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Login failed for user 'other'..", 1],
  [1, "Login failed for user 'sa'", 1],
  [1, "Login timeout expired", 1],
  [127, "sqlcmd: not found", 1],
] as const)("classifies sqlcmd exit %s and diagnostic %s", async (status, message, expected) => {
  const argv = mssqlHealthcheck(1433);
  const proc = Bun.spawn(
    [
      ...argv.slice(0, 4),
      "/bin/sh",
      "-c",
      'test "$SQLCMDPASSWORD" = "$EXPECTED_PASSWORD" || exit 91; printf "%s\\n" "$CLIENT_DIAGNOSTIC" >&2; exit "$CLIENT_STATUS"',
    ],
    {
      env: {
        MSSQL_SA_PASSWORD: 'literal " password',
        CLIENT_STATUS: String(status),
        EXPECTED_PASSWORD: 'literal " password',
        CLIENT_DIAGNOSTIC: message,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect({ exit, stdout, stderr }).toEqual({ exit: expected, stdout: "", stderr: "" });
});
