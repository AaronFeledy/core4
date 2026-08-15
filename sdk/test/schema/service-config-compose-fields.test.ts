import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

const decodeService = Schema.decodeUnknownSync(ServiceConfig);

describe("ServiceConfig Compose preserved fields", () => {
  test("Given network short and long forms, when decoded, then both canonicalize to a long mapping", () => {
    // Given / When
    const shortForm = decodeService({ networks: ["frontend", "backend"] });
    const longForm = decodeService({
      networks: {
        frontend: null,
        backend: { aliases: ["api"] },
      },
    });

    // Then
    expect(shortForm.networks).toEqual({ frontend: {}, backend: {} });
    expect(longForm.networks).toEqual({ frontend: {}, backend: { aliases: ["api"] } });
  });

  test("Given every network attachment field, when decoded and encoded, then the attachment round-trips", () => {
    // Given
    const input = {
      networks: {
        frontend: {
          aliases: ["api", "web"],
          interface_name: "eth7",
          ipv4_address: "172.20.0.10",
          ipv6_address: "2001:db8::10",
          link_local_ips: ["169.254.10.10"],
          mac_address: "02:42:ac:14:00:0a",
          driver_opts: { encrypted: "true", mtu: 1450 },
          priority: 100,
          gw_priority: 50,
          "x-network-note": { owner: "platform" },
        },
      },
    };

    // When
    const decoded = decodeService(input);
    const encoded = Schema.encodeSync(ServiceConfig)(decoded);

    // Then
    expect(encoded).toEqual(input);
    expect(decodeService(encoded)).toEqual(decoded);
  });

  test("Given config and secret short and long forms, when decoded, then strings canonicalize to source objects", () => {
    // Given / When
    const decoded = decodeService({
      configs: [
        "app-config",
        {
          source: "server-config",
          target: "/etc/server.conf",
          uid: "103",
          gid: "104",
          mode: "0440",
          "x-config-note": true,
        },
        { target: "/etc/source-optional.conf", mode: 288 },
      ],
      secrets: [
        "database-password",
        {
          source: "api-token",
          target: "/run/secrets/api-token",
          uid: "105",
          gid: "106",
          mode: 256,
          "x-secret-note": "preserve",
        },
      ],
    });

    // Then
    expect(decoded.configs).toEqual([
      { source: "app-config" },
      {
        source: "server-config",
        target: "/etc/server.conf",
        uid: "103",
        gid: "104",
        mode: "0440",
        "x-config-note": true,
      },
      { target: "/etc/source-optional.conf", mode: 288 },
    ]);
    expect(decoded.secrets).toEqual([
      { source: "database-password" },
      {
        source: "api-token",
        target: "/run/secrets/api-token",
        uid: "105",
        gid: "106",
        mode: 256,
        "x-secret-note": "preserve",
      },
    ]);
  });

  test("Given profiles and a service extension, when decoded, then both are preserved", () => {
    // Given / When
    const decoded = decodeService({
      profiles: ["debug", "ci"],
      "x-runtime-hint": { feature: "opaque" },
    });

    // Then
    expect(decoded.profiles).toEqual(["debug", "ci"]);
    expect(decoded["x-runtime-hint"]).toEqual({ feature: "opaque" });
  });

  test.each([
    ["default options", undefined],
    ["strict excess-property options", { onExcessProperty: "error" } as const],
  ])(
    "Given all preserved fields, when decoded twice with %s, then canonical output remains valid",
    (_name, options) => {
      // Given
      const input = {
        image: "nginx:alpine",
        networks: ["frontend"],
        configs: ["app-config", { target: "/etc/generated.conf", "x-entry": 1 }],
        secrets: ["database-password"],
        profiles: ["debug"],
        "x-service-note": { owner: "platform" },
      };

      // When
      const first = decodeService(input, options);
      const second = decodeService(first, options);

      // Then
      expect(second).toEqual(first);
    },
  );

  test("Given ServiceConfig fields, when enumerated, then named fields remain inspectable without an x-* pseudo-field", () => {
    // Given / When
    const fields = Object.keys(ServiceConfig.fields);

    // Then
    expect(fields).toEqual(expect.arrayContaining(["networks", "configs", "secrets", "profiles", "image"]));
    expect(fields).not.toContain("x-*");
  });
});
