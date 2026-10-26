import { describe, expect, test } from "bun:test";

import { stripAnsi } from "@lando/renderer/console-layout";

import { buildInfoSummary, renderInfoAppResult } from "../../src/cli/commands/info-render.ts";
import {
  HEX_VOLUME,
  appMount,
  decorated,
  planned,
  remedyLines,
  result,
  runtimeVolume,
  service,
} from "./info-storage-fixtures";

const storageFieldsOf = (summary: ReturnType<typeof buildInfoSummary>, index = 0) =>
  summary.sections[0]?.rows[index]?.fields
    ?.filter((field) => ["retained", "temporary", "unverified"].includes(field.label))
    .map((field) => `${field.label}=${field.value}`);

describe("storage fields in the info summary", () => {
  const node = service(
    "node",
    [
      planned({ type: "bind", target: "/app", source: appMount.source, lifetime: "retained" }),
      planned({
        type: "volume",
        target: "/app/node_modules",
        source: "demo-app-node-app-node-modules-1a2b",
        lifetime: "retained",
      }),
      planned({
        type: "bind",
        target: "/etc/app.toml",
        source: "/home/user/projects/demo-app/app.toml",
        lifetime: "retained",
        readOnly: true,
      }),
      planned({ type: "tmpfs", target: "/tmp", lifetime: "container" }),
      runtimeVolume("/meili_data", HEX_VOLUME),
    ],
    { appMount },
  );

  test("groups mounts by lifetime under human labels and names each kind", () => {
    const summary = buildInfoSummary(result(node));
    expect(storageFieldsOf(summary)).toEqual([
      "retained=/app (app source), /app/node_modules (store), /etc/app.toml (host files, read-only)",
      "temporary=/tmp (memory)",
      "unverified=/meili_data (runtime volume)",
    ]);
  });

  test("places storage after the connection fields and before log sources", () => {
    const withLogs = service(
      "db",
      [planned({ type: "volume", target: "/data", source: "db", lifetime: "retained" })],
      {
        logSources: [
          { id: "slow", path: "/var/log/slow.log", strategy: "follow", availability: "available" },
        ],
      },
    );
    const labels = buildInfoSummary(result(withLogs)).sections[0]?.rows[0]?.fields?.map(
      (field) => field.label,
    );
    expect(labels).toEqual(["type", "provider", "Host", "App Network", "retained", "log sources"]);
  });

  test("keeps host paths and volume names out of the default summary", () => {
    const visible = stripAnsi(renderInfoAppResult(result(node), decorated(100)));
    expect(visible).not.toContain("/home/user/projects/demo-app");
    expect(visible).not.toContain(HEX_VOLUME);
    expect(visible).toContain("Run `lando info --format=json` for mount sources.");
  });

  test("never calls an unmatched runtime volume anonymous", () => {
    const visible = stripAnsi(renderInfoAppResult(result(node), decorated(100)));
    expect(visible).not.toMatch(/anonymous/iu);
    expect(visible).toContain("unverified  : /meili_data (runtime volume)");
  });

  test("leaves the health tone alone when a lifetime is unverified", () => {
    const summary = buildInfoSummary(result(node));
    expect(summary.sections[0]?.rows[0]?.tone).toBe("ok");
    expect(summary.tone).toBe("ok");
    expect(stripAnsi(renderInfoAppResult(result(node), decorated(100)))).not.toContain("[WARN]");
  });

  test("combines the JSON pointer with the log-source note instead of adding a second bullet", () => {
    const withLogs = service(
      "db",
      [planned({ type: "volume", target: "/data", source: "db", lifetime: "retained" })],
      {
        logSources: [
          { id: "slow", path: "/var/log/slow.log", strategy: "follow", availability: "available" },
        ],
      },
    );
    expect(buildInfoSummary(result(withLogs)).sections[0]?.notes).toEqual([
      "Run `lando info --format=json` for log paths, strategies, and mount sources.",
    ]);
  });
});

describe("storage remediation", () => {
  test("offers one remediation per service naming every unplanned volume", () => {
    const search = service("search", [
      planned({ type: "volume", target: "/data", source: "search", lifetime: "retained" }),
      runtimeVolume("/meili_data", HEX_VOLUME),
      runtimeVolume("/cache", "friendly-volume"),
    ]);
    const out = renderInfoAppResult(
      result(
        search,
        service("web", [planned({ type: "bind", target: "/app", source: "/host", lifetime: "retained" })]),
      ),
      decorated(100),
    );
    const remedy = buildInfoSummary(result(search)).sections[0]?.rows[0]?.remedy;
    expect(remedyLines(out)).toHaveLength(1);
    expect(remedy).toContain("/meili_data and /cache");
    expect(remedy).toContain("`storage:`");
    expect(remedy).toMatch(/does not move existing data/u);
    expect(remedy).not.toMatch(/migrat/iu);
  });

  test("stays quiet for empty, unavailable, and fully known storage", () => {
    const known = service("web", [
      planned({ type: "bind", target: "/app", source: "/host", lifetime: "retained" }),
      planned({ type: "tmpfs", target: "/tmp", lifetime: "container" }),
    ]);
    const summary = buildInfoSummary(result(service("empty", []), service("unavailable", undefined), known));
    for (const row of summary.sections[0]?.rows ?? []) expect(row.remedy).toBeUndefined();
    expect(storageFieldsOf(summary, 0)).toEqual([]);
    expect(storageFieldsOf(summary, 1)).toEqual([]);
    expect(storageFieldsOf(summary, 2)).toEqual(["retained=/app (host files)", "temporary=/tmp (memory)"]);
    expect(summary.sections[0]?.notes).toEqual(["Run `lando info --format=json` for mount sources."]);
  });

  test("points at `lando start` when an unplanned volume sits where a declared mount is missing", () => {
    const stale = service("search", [
      planned({
        type: "volume",
        target: "/meili_data",
        source: "meili-data",
        lifetime: "retained",
        observation: "missing",
      }),
      runtimeVolume("/meili_data", HEX_VOLUME),
    ]);
    const summary = buildInfoSummary(result(stale));
    expect(storageFieldsOf(summary)).toEqual([
      "retained=/meili_data (store, not mounted)",
      "unverified=/meili_data (runtime volume)",
    ]);
    const remedy = summary.sections[0]?.rows[0]?.remedy;
    expect(remedy).toContain("`lando start`");
    expect(remedy).toContain("/meili_data");
    expect(remedy).toMatch(/is not moved/u);
    expect(remedy).not.toContain("`storage:`");
  });

  test("gives no advice when the volume at a declared target is merely unconfirmed", () => {
    const ambiguous = service("db", [
      planned({
        type: "volume",
        target: "/data",
        source: "expected",
        lifetime: "retained",
        observation: "unknown",
      }),
      runtimeVolume("/data", "unlabeled"),
    ]);
    const summary = buildInfoSummary(result(ambiguous));
    expect(storageFieldsOf(summary)).toEqual([
      "retained=/data (store, unconfirmed)",
      "unverified=/data (runtime volume)",
    ]);
    expect(summary.sections[0]?.rows[0]?.remedy).toBeUndefined();
  });

  test("keeps both situations inside one remediation block", () => {
    const mixed = service("search", [
      planned({
        type: "volume",
        target: "/meili_data",
        source: "meili-data",
        lifetime: "retained",
        observation: "missing",
      }),
      runtimeVolume("/meili_data", HEX_VOLUME),
      runtimeVolume("/dumps", "dumps"),
    ]);
    const out = renderInfoAppResult(result(mixed), decorated(100));
    const remedy = buildInfoSummary(result(mixed)).sections[0]?.rows[0]?.remedy;
    expect(remedyLines(out)).toHaveLength(1);
    expect(remedy).toContain("To keep /dumps across container replacement");
    expect(remedy).toContain("`lando start` recreates this container with the declared mount at /meili_data");
    expect(
      renderInfoAppResult(result(mixed))
        .split("\n")
        .filter((row) => row.includes("\tmount-note\t")),
    ).toHaveLength(1);
  });

  test("does not point an unknown mount kind at the storage key", () => {
    const odd = service("odd", [
      { type: "unknown", target: "/mystery", origin: "runtime", observation: "present", lifetime: "unknown" },
    ]);
    const summary = buildInfoSummary(result(odd));
    expect(storageFieldsOf(summary)).toEqual(["unverified=/mystery (unknown mount)"]);
    expect(summary.sections[0]?.rows[0]?.remedy).toBeUndefined();
  });

  test("omits the storage note when no service reports mounts", () => {
    const summary = buildInfoSummary(result(service("web", undefined)));
    expect(summary.sections[0]?.notes).toBeUndefined();
  });
});

describe("observation wording", () => {
  test("marks an absent planned store as not mounted while keeping its declared lifetime", () => {
    const stopped = service(
      "db",
      [
        planned({
          type: "volume",
          target: "/var/lib/mysql",
          source: "database",
          lifetime: "retained",
          observation: "missing",
        }),
      ],
      {
        status: "stopped",
      },
    );
    const fields = storageFieldsOf(buildInfoSummary(result(stopped)));
    expect(fields).toEqual(["retained=/var/lib/mysql (store, not mounted)"]);
    expect(fields?.join(" ")).not.toMatch(/missing|lost|deleted/iu);
  });

  test("marks unavailable evidence as unconfirmed rather than absent", () => {
    const cache = service("cache", [
      planned({
        type: "volume",
        target: "/data",
        source: "cache",
        lifetime: "retained",
        observation: "unknown",
      }),
    ]);
    expect(storageFieldsOf(buildInfoSummary(result(cache)))).toEqual(["retained=/data (store, unconfirmed)"]);
  });
});
