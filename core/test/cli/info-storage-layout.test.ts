import { describe, expect, test } from "bun:test";

import { displayWidth, stripAnsi } from "@lando/renderer/console-layout";
import { formatSummary } from "@lando/renderer/summary";

import { buildInfoSummary, renderInfoAppResult } from "../../src/cli/commands/info-render.ts";
import { connections } from "./connection-fixtures";
import {
  HEX_VOLUME,
  decorated,
  planned,
  remedyLines,
  result,
  runtimeVolume,
  service,
} from "./info-storage-fixtures";

const ESC = String.fromCharCode(27);

const expectFramed = (text: string, width: number): ReadonlyArray<string> => {
  const lines = stripAnsi(text)
    .split("\n")
    .filter((line) => line.length > 0);
  for (const line of lines) expect(displayWidth(line)).toBe(width);
  expect(lines[0]?.startsWith("╭─")).toBe(true);
  expect(lines[lines.length - 1]?.endsWith("╯")).toBe(true);
  return lines;
};

const squash = (text: string): string =>
  stripAnsi(text)
    .split("\n")
    .map((line) => (line.startsWith("│") && line.endsWith("│") ? line.slice(1, -1) : ""))
    .join("")
    .replace(/\s+/gu, "");

describe("narrow and wide widths", () => {
  const LONG_TARGET = "/var/lib/postgresql/data/very/long/nested/path/that/keeps/going/and/going";
  const wide = service(
    "postgres",
    [
      planned({ type: "volume", target: LONG_TARGET, source: "pgdata", lifetime: "retained" }),
      planned({
        type: "volume",
        target: "/var/lib/mysql",
        source: "database",
        lifetime: "retained",
        observation: "missing",
      }),
      planned({ type: "tmpfs", target: "/run", lifetime: "container" }),
      runtimeVolume("/meili_data", HEX_VOLUME),
    ],
    { connections: connections(["postgresql://lando@localhost:5432/appdb"]) },
  );

  test("keeps every target intact on one line at 100 columns", () => {
    const out = renderInfoAppResult(result(wide), decorated(100));
    const lines = expectFramed(out, 100);
    expect(lines.some((line) => line.includes(`retained    : ${LONG_TARGET} `))).toBe(true);
    expect(lines.some((line) => line.includes("/var/lib/mysql (store, not mounted)"))).toBe(true);
    expect(lines.some((line) => line.includes("temporary   : /run (memory)"))).toBe(true);
    expect(lines.some((line) => line.includes("unverified  : /meili_data (runtime volume)"))).toBe(true);
    expect(remedyLines(out)).toHaveLength(1);
  });

  test("wraps instead of truncating at 36 columns", () => {
    const out = renderInfoAppResult(result(wide), decorated(36));
    const lines = expectFramed(out, 36);
    for (const line of lines.slice(1, -1)) expect(line).not.toContain("…");
    const flat = squash(out);
    expect(flat).toContain(`${LONG_TARGET}(store)`);
    expect(flat).toContain("/var/lib/mysql(store,notmounted)");
    expect(flat).toContain("/meili_data(runtimevolume)");
    expect(flat).toContain("Tokeep/meili_dataacrosscontainerreplacement");
    expect(remedyLines(out)).toHaveLength(1);
  });

  test("measures CJK targets in cells so the frame stays square", () => {
    const cjk = service("数据库", [
      planned({ type: "volume", target: "/데이터/数据", source: "数据", lifetime: "retained" }),
      runtimeVolume("/キャッシュ", "一時"),
    ]);
    for (const columns of [36, 100]) {
      const out = renderInfoAppResult(result(cjk), decorated(columns));
      expectFramed(out, columns);
      expect(squash(out)).toContain("/데이터/数据(store)");
      expect(squash(out)).toContain("/キャッシュ(runtimevolume)");
    }
  });
});

describe("control characters in runtime-reported text", () => {
  const hostile = service("hostile", [runtimeVolume(`/data${ESC}[31m\n\tinjected`, `vol${ESC}[0m\u0007`)]);

  test("escapes control bytes so a volume cannot paint or break the frame", () => {
    const out = renderInfoAppResult(result(hostile), decorated(100));
    const lines = expectFramed(out, 100);
    expect(out).not.toContain(`${ESC}[31m`);
    expect(out).not.toContain("\u0007");
    expect(
      lines.some((line) => line.includes("/data\\u001b[31m\\u000a\\u0009injected (runtime volume)")),
    ).toBe(true);
    expect(remedyLines(out)).toHaveLength(1);
  });

  test("keeps plain rows one line and nine columns wide", () => {
    const rows = renderInfoAppResult(result(hostile)).split("\n");
    const mountRow = rows.find((row) => row.startsWith("hostile\tmount\t"));
    expect(mountRow?.split("\t")).toEqual([
      "hostile",
      "mount",
      "/data\\u001b[31m\\u000a\\u0009injected",
      "runtime volume",
      "vol\\u001b[0m\\u0007",
      "unverified",
      "mounted",
      "-",
      "-",
    ]);
    expect(rows.filter((row) => row.startsWith("hostile\t"))).toHaveLength(3);
    expect(rows.join("\n")).not.toContain(ESC);
  });
});

describe("plain renderer rows", () => {
  const search = service("search", [
    planned({
      type: "bind",
      target: "/app",
      source: "/home/user/projects/demo-app",
      lifetime: "retained",
      readOnly: false,
    }),
    planned({
      type: "volume",
      target: "/var/lib/mysql",
      source: "database",
      lifetime: "retained",
      observation: "missing",
      readOnly: true,
    }),
    planned({ type: "tmpfs", target: "/tmp", lifetime: "container", observation: "unknown" }),
    runtimeVolume("/meili_data", HEX_VOLUME),
  ]);

  test("lists target, kind, source, lifetime, observation, access, and provenance for every mount", () => {
    const rows = renderInfoAppResult(result(search)).split("\n");
    expect(rows.filter((row) => row.startsWith("search\tmount\t"))).toEqual([
      "search\tmount\t/app\thost files\t/home/user/projects/demo-app\tretained\tmounted\tread-write\t-",
      "search\tmount\t/var/lib/mysql\tstore\tdatabase\tretained\tnot mounted\tread-only\t-",
      "search\tmount\t/tmp\tmemory\t-\ttemporary\tunconfirmed\t-\t-",
      `search\tmount\t/meili_data\truntime volume\t${HEX_VOLUME}\tunverified\tmounted\t-\t-`,
    ]);
  });

  test("adds a single mount-note row carrying the remediation", () => {
    const rows = renderInfoAppResult(result(search)).split("\n");
    const notes = rows.filter((row) => row.startsWith("search\tmount-note\t"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("/meili_data");
    expect(notes[0]).toContain("`storage:`");
    expect(rows.join("\n")).not.toMatch(/anonymous/iu);
  });

  test("emits no mount rows for empty or unavailable storage", () => {
    const out = renderInfoAppResult(result(service("empty", []), service("none", undefined)));
    expect(out).not.toContain("\tmount");
    expect(out).toContain("empty\trunning\t");
    expect(out).toContain("none\trunning\t");
  });
});

describe("formatSummary round trip", () => {
  test("renders the same storage facts through the standalone formatter", () => {
    const summary = buildInfoSummary(
      result(
        service("db", [
          planned({ type: "volume", target: "/var/lib/mysql", source: "database", lifetime: "retained" }),
        ]),
      ),
    );
    const out = formatSummary(summary, { columns: 60 });
    expectFramed(out, 60);
    expect(stripAnsi(out)).toContain("retained    : /var/lib/mysql (store)");
  });
});
