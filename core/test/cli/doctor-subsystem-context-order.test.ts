import { expect, test } from "bun:test";

import { Schema } from "effect";

import { StreamFrame } from "@lando/sdk/schema";

import {
  type SubsystemDoctorResult,
  renderSubsystemDoctorResultAsNdjson,
} from "../../src/cli/commands/doctor-subsystems.ts";

const DoctorContext = Schema.Record({ key: Schema.String, value: Schema.String });
const DoctorEventContext = Schema.Struct({ context: DoctorContext });

test("orders certificate and network-trust context keys deterministically", () => {
  // Given
  const result: SubsystemDoctorResult = {
    checks: [
      {
        name: "certs",
        status: "warn",
        severity: "warn",
        recovery: "manual",
        context: {
          certsDetail: "choose one",
          certsPlugin: "ca-plugin",
          certsCandidateIds: "first,second",
          certsReason: "ambiguous",
          ready: "false",
          subsystemId: "unavailable",
          subsystem: "certs",
        },
        solutions: [],
      },
      {
        name: "network-trust",
        status: "warn",
        severity: "warn",
        recovery: "manual",
        context: {
          noProxyCount: "0",
          remediation: "run setup",
          message: "missing CA",
          failure: "missing-custom-ca",
          caInjectIntoServices: "true",
          caTrustHost: "true",
          caLoaded: "0",
          caCount: "1",
          caConfigured: "true",
          proxyInjectIntoServices: "false",
          proxyConfigured: "false",
        },
        solutions: [],
      },
    ],
  };

  // When
  const contexts = renderSubsystemDoctorResultAsNdjson(result)
    .trimEnd()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)))
    .flatMap((frame) =>
      frame._tag === "event" ? [Schema.decodeUnknownSync(DoctorEventContext)(frame.payload).context] : [],
    );

  // Then
  expect(Object.keys(contexts[0] ?? {})).toEqual([
    "subsystem",
    "subsystemId",
    "ready",
    "certsReason",
    "certsCandidateIds",
    "certsPlugin",
    "certsDetail",
  ]);
  expect(Object.keys(contexts[1] ?? {})).toEqual([
    "failure",
    "message",
    "remediation",
    "caConfigured",
    "caCount",
    "caLoaded",
    "caTrustHost",
    "caInjectIntoServices",
    "proxyConfigured",
    "proxyInjectIntoServices",
    "noProxyCount",
  ]);
});
