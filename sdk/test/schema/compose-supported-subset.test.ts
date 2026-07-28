import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { ComposeServiceKnobKey, LandofileShape, ServiceName } from "@lando/sdk/schema";

const landofileWithService = (service: Record<string, unknown>) => ({
  name: "probe",
  services: {
    entry: {
      image: "nginx",
      ...service,
    },
  },
});

const serviceFrom = (landofile: typeof LandofileShape.Type) =>
  landofile.services?.[ServiceName.make("entry")];

const acceptedForms = [
  {
    name: "networks short list",
    field: "networks",
    value: ["frontend", "backend"],
  },
  {
    name: "networks long map",
    field: "networks",
    value: {
      frontend: null,
      backend: {
        aliases: ["api"],
        interface_name: "eth1",
        ipv4_address: "172.20.0.10",
        ipv6_address: "2001:db8::10",
        link_local_ips: ["169.254.1.10"],
        mac_address: "02:42:ac:14:00:0a",
        driver_opts: { mtu: 1_500, mode: "bridge" },
        priority: 10,
        gw_priority: 20,
        "x-network": { any: "value" },
      },
    },
  },
  {
    name: "configs short list",
    field: "configs",
    value: ["test_config"],
  },
  {
    name: "configs long list",
    field: "configs",
    value: [
      {
        source: "test_config",
        target: "/volumes/test_config.txt",
        uid: "1000",
        gid: "1000",
        mode: "0440",
        "x-config": { any: "value" },
      },
    ],
  },
  {
    name: "secrets short list",
    field: "secrets",
    value: ["test_secret"],
  },
  {
    name: "secrets long list",
    field: "secrets",
    value: [
      {
        source: "test_secret",
        target: "/volumes/test_secret.txt",
        uid: "1000",
        gid: "1000",
        mode: 288,
        "x-secret": { any: "value" },
      },
    ],
  },
  {
    name: "profiles list",
    field: "profiles",
    value: ["dev", "debug"],
  },
] as const;

describe("Compose supported service subset schemas", () => {
  test.each(acceptedForms)("accepts the vendored $name form", ({ field, value }) => {
    // Given / When
    const decoded = Schema.decodeUnknownSync(LandofileShape)(landofileWithService({ [field]: value }), {
      onExcessProperty: "error",
    });

    // Then
    expect(serviceFrom(decoded)?.[field]).toEqual(value);
  });

  test.each([
    { field: "networks", value: { frontend: { aliases: ["api"] } } },
    {
      field: "configs",
      value: [{ source: "test_config", target: "/volumes/test_config.txt" }],
    },
    {
      field: "secrets",
      value: [{ source: "test_secret", target: "/volumes/test_secret.txt" }],
    },
    { field: "profiles", value: ["dev"] },
  ] as const)("decodes $field idempotently in default and strict modes", ({ field, value }) => {
    // Given
    const input = landofileWithService({ [field]: value });

    // When
    const defaultDecoded = Schema.decodeUnknownSync(LandofileShape)(input);
    const defaultDecodedAgain = Schema.decodeUnknownSync(LandofileShape)(defaultDecoded);
    const strictDecoded = Schema.decodeUnknownSync(LandofileShape)(input, {
      onExcessProperty: "error",
    });
    const strictDecodedAgain = Schema.decodeUnknownSync(LandofileShape)(strictDecoded, {
      onExcessProperty: "error",
    });

    // Then
    expect(defaultDecodedAgain).toEqual(defaultDecoded);
    expect(strictDecoded).toEqual(defaultDecoded);
    expect(strictDecodedAgain).toEqual(strictDecoded);
  });

  test("accepts and preserves service-level x-* extensions", () => {
    // Given / When
    const decoded = Schema.decodeUnknownSync(LandofileShape)(
      landofileWithService({ "x-custom": { any: "value" } }),
      { onExcessProperty: "error" },
    );

    // Then
    expect(serviceFrom(decoded)?.["x-custom"]).toEqual({ any: "value" });
  });

  test.each([
    { field: "networks", value: ["frontend", 42] },
    { field: "configs", value: [{ source: 42 }] },
    { field: "secrets", value: { source: "test_secret" } },
    { field: "profiles", value: "dev" },
  ] as const)("rejects an invalid typed outer $field shape", ({ field, value }) => {
    // Given / When
    const decoded = Schema.decodeUnknownEither(LandofileShape)(landofileWithService({ [field]: value }), {
      onExcessProperty: "error",
    });

    // Then
    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("rejects a non-extension unknown service key", () => {
    // Given / When
    const decoded = Schema.decodeUnknownEither(LandofileShape)(
      landofileWithService({ unsupported_service_key: true }),
      { onExcessProperty: "error" },
    );

    // Then
    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("keeps native-only fields outside the per-knob capability declaration", () => {
    // Given / When
    const knobKeys: ReadonlySet<string> = new Set(ComposeServiceKnobKey.literals);
    const memberships = ["networks", "configs", "secrets", "profiles"].map((field) => knobKeys.has(field));

    // Then
    expect(memberships).toEqual([false, false, false, false]);
  });
});
