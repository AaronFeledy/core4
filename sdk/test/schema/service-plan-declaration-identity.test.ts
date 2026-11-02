import { expect, test } from "bun:test";
import { ServicePlan } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

test.each([{}, { nonSqlCreds: { user: "default", password: "secret", database: "0" } }])(
  "service declaration identity survives strict persistence and rejects empty IDs with credentials %j",
  (credentials) => {
    // Given
    const service = {
      name: "database",
      type: "postgres",
      serviceTypeId: "derived-postgres",
      provider: "test",
      primary: true,
      environment: {},
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      extensions: {},
      metadata: { resolvedAt: "2026-10-01T00:00:00Z", source: "test", runtime: 4 },
      ...credentials,
    };
    // When
    const decoded = Schema.decodeUnknownSync(ServicePlan)(service, { onExcessProperty: "error" });
    const persisted = Schema.decodeUnknownSync(ServicePlan)(
      JSON.parse(JSON.stringify(Schema.encodeSync(ServicePlan)(decoded))),
      { onExcessProperty: "error" },
    );
    const invalid = Schema.decodeUnknownResult(ServicePlan)({ ...service, serviceTypeId: "" });
    // Then
    expect(persisted.serviceTypeId).toBe("derived-postgres");
    expect(persisted.type).toBe("postgres");
    expect(Result.isFailure(invalid)).toBe(true);
  },
);
