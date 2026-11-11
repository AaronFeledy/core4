import { expect, test } from "bun:test";

import { doctorReportsForHelper } from "../src/doctor-socket-proxy-helper.ts";
import { classifySocketProxyArtifacts, socketProxyUnitHeader } from "../src/socket-proxy-helper.ts";

const root = "/lando/root";
const other = "/lando/other";

test("owned active passes", () => {
  const reports = doctorReportsForHelper({
    ownership: { kind: "owned" },
    installed: true,
    socketsActive: true,
  });
  expect(reports).toHaveLength(1);
  expect(reports[0]?.status).toBe("pass");
});

test("owned inactive without socket-helper acquisition is silent", () => {
  const reports = doctorReportsForHelper({
    ownership: { kind: "owned" },
    installed: true,
    socketsActive: false,
    acquisitionMode: "occupied-hop",
  });
  expect(reports).toEqual([]);
});

test("owned inactive with no acquisition claim is silent", () => {
  const reports = doctorReportsForHelper({
    ownership: { kind: "owned" },
    installed: true,
    socketsActive: false,
  });
  expect(reports).toEqual([]);
});

test("owned inactive with socket-helper acquisition warns setup", () => {
  const reports = doctorReportsForHelper({
    ownership: { kind: "owned" },
    installed: true,
    socketsActive: false,
    acquisitionMode: "socket-helper",
  });
  expect(reports[0]?.status).toBe("warn");
  expect(reports[0]?.solutions.some((s) => s.command === "lando setup")).toBe(true);
});

test("other-root passes with ownerRoot context", () => {
  const reports = doctorReportsForHelper({
    ownership: { kind: "foreign", reason: "other-root", ownerRoot: other },
    installed: false,
    socketsActive: false,
  });
  expect(reports[0]?.status).toBe("pass");
  expect(reports[0]?.context.ownerRoot).toBe(other);
});

test("missing-root and unattributed warn with setup and manual", () => {
  for (const reason of ["missing-root", "unattributed"] as const) {
    const reports = doctorReportsForHelper({
      ownership: { kind: "foreign", reason, ...(reason === "missing-root" ? { ownerRoot: other } : {}) },
      installed: false,
      socketsActive: false,
    });
    expect(reports[0]?.status).toBe("warn");
    expect(reports[0]?.solutions.some((s) => s.command === "lando setup")).toBe(true);
  }
});

test("mixed warns manual review", () => {
  const reports = doctorReportsForHelper({
    ownership: { kind: "foreign", reason: "mixed" },
    installed: false,
    socketsActive: false,
  });
  expect(reports[0]?.status).toBe("warn");
  expect(reports[0]?.context.ownership).toBe("mixed");
});

test("absent and unmarked produce no report", () => {
  expect(
    doctorReportsForHelper({ ownership: { kind: "absent" }, installed: false, socketsActive: false }),
  ).toEqual([]);
  expect(
    doctorReportsForHelper({ ownership: { kind: "unmarked" }, installed: false, socketsActive: false }),
  ).toEqual([]);
});

test("malformed classification is mixed", () => {
  const files = Array.from({ length: 4 }, () => "# lando-proxy-socket-helper\n# lando-data-root: not-json");
  expect(classifySocketProxyArtifacts(files, root, [])).toEqual({ kind: "foreign", reason: "mixed" });
  expect(classifySocketProxyArtifacts([socketProxyUnitHeader(root)], root, [])).toEqual({ kind: "owned" });
});
