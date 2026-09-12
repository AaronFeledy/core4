import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import { planAppPlannerCerts } from "./app-planner-certs-harness.ts";

test("derives SANs from normalized shorthand hostnames", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-certs-routes-"));
  const ca = makeTestCertificateAuthority();
  try {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "certs-app",
      services: { web: { type: "node:22", certs: true, routes: ["web.example.test:3000/api"] } },
      proxy: { web: ["alias.example.test:3000/other"] },
    });
    // When
    const result = await planAppPlannerCerts({
      appRoot: root,
      cacheRoot: join(root, "cache"),
      landofile,
      ca,
    });
    // Then
    const sans = [
      "web",
      "web.certs-app.internal",
      "web.example.test",
      "alias.example.test",
      "localhost",
      "127.0.0.1",
    ];
    expect(result.services[ServiceName.make("web")]?.certs?.sans).toEqual(sans);
    const issued = ca.calls.find((call) => call.op === "issueCert");
    expect(issued?.op === "issueCert" ? issued.spec.sans : []).toEqual(sans);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
