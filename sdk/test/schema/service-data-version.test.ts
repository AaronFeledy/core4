import { expect, test } from "bun:test";
import {
  PortablePath,
  type ServiceDataVersion,
  classifyDataVersionRefusal,
  compareDataSeries,
  parseDataVersionRecords,
} from "@lando/sdk/schema";

const target = PortablePath.make("/var/lib/mysql");
const contract = {
  target,
  label: "MariaDB",
  series: {
    depth: 2,
    upgrade: "in-place",
    records: ["mariadb_upgrade_info", "mysql_upgrade_info"].map((file) => ({
      path: PortablePath.make(`${target}/${file}`),
      pattern: String.raw`^(\d+\.\d+\.\d+)`,
    })),
  },
  refusals: [],
} satisfies ServiceDataVersion;

test("reads the highest series across stale and current records", () => {
  const contents = new Map([
    [`${target}/mariadb_upgrade_info`, "11.4.13-MariaDB\n"],
    [`${target}/mysql_upgrade_info`, "10.11.19-MariaDB\n"],
  ]);
  expect(parseDataVersionRecords(contents, contract)).toBe("11.4");
});

test.each([
  ["10.9.21", "10.11", -1],
  ["11.4.13", "11.4", 0],
  ["11.10", "11.4", 1],
  ["11", "11.4", undefined],
  ["latest", "11.4", undefined],
] as const)("compares the series of %s to %s numerically", (data, image, comparison) => {
  expect(compareDataSeries(data, image, 2)).toBe(comparison);
});

test("recognizes a guarded server downgrade without a vendor pattern", () => {
  const lines = ["lando-data-version-refused data=11.4 image=10.11: MariaDB cannot open the data."];
  expect(classifyDataVersionRefusal(contract, { exitCode: 1, lines })).toEqual({
    finding: { direction: "downgrade", evidence: "guard", dataVersion: "11.4", imageVersion: "10.11" },
  });
  expect(classifyDataVersionRefusal(contract, { exitCode: 0, lines })).toBeUndefined();
});

test("prefers the newest refusal within each evidence class, with guard evidence first", () => {
  const patterns = {
    ...contract,
    refusals: [
      { pattern: "downgrade (?<data>[\\d.]+)", direction: "downgrade" },
      { pattern: "upgrade (?<data>[\\d.]+)", direction: "upgrade" },
    ],
  } satisfies ServiceDataVersion;
  const lines = ["downgrade 11.4", "upgrade 10.6"];
  expect(classifyDataVersionRefusal(patterns, { exitCode: 1, lines })?.finding).toEqual({
    direction: "upgrade",
    evidence: "server",
    dataVersion: "10.6",
  });
  expect(
    classifyDataVersionRefusal(patterns, {
      exitCode: 1,
      lines: [
        "lando-data-version-refused data=11.4 image=10.11: old",
        "lando-data-version-refused data=11.8 image=10.11: current",
        ...lines,
      ],
    })?.finding,
  ).toEqual({ direction: "downgrade", evidence: "guard", dataVersion: "11.8", imageVersion: "10.11" });
});
