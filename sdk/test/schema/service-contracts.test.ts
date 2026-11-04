import { expect, test } from "bun:test";
import { ServiceFeatureError } from "@lando/sdk/errors";
import {
  EndpointInput,
  EndpointPlan,
  EndpointScan,
  ServiceFeatureValidationResult,
  endpointInvariantIssues,
} from "@lando/sdk/schema";
import { MinIOServiceConfig } from "@lando/sdk/schema/services/minio";
import { Schema } from "effect";

test.each([{}, { path: "/" }, { okCodes: [] }, { path: "/health", okCodes: [100, 599] }])(
  "preserves sparse endpoint scan policy %j",
  (scan) => {
    // Given / When
    const endpoint = Schema.decodeUnknownSync(EndpointPlan)({
      _tag: "internal",
      protocol: "http",
      port: 9000,
      scan,
    });
    // Then
    expect(endpoint.scan).toEqual(scan);
    expect(Schema.encodeSync(EndpointScan)(Schema.decodeUnknownSync(EndpointScan)(scan))).toEqual(scan);
  },
);

test.each([{ path: "health" }, { okCodes: [99] }, { okCodes: [600] }, { okCodes: [200.5] }, { retries: 1 }])(
  "rejects invalid endpoint scan policy %j",
  (scan) => {
    // Given / When / Then
    expect(() => Schema.decodeUnknownSync(EndpointScan, { onExcessProperty: "error" })(scan)).toThrow();
  },
);

test("keeps scan metadata out of authored endpoints and old plans", () => {
  // Given
  const input = { _tag: "internal", protocol: "http", port: 80 } as const;
  // When / Then
  expect(Schema.decodeUnknownSync(EndpointPlan)(input)).toEqual(input);
  expect(() =>
    Schema.decodeUnknownSync(EndpointInput, { onExcessProperty: "error" })({
      ...input,
      scan: { path: "/health" },
    }),
  ).toThrow();
});

test.each([
  [{ path: "/live" }, { path: "/ready" }],
  [{ okCodes: [200] }, { okCodes: [204] }],
  [{ okCodes: [] }, { okCodes: [200] }],
])("rejects contradictory logical scan defaults %j", (first, second) => {
  // Given
  const endpoints = Schema.decodeUnknownSync(Schema.Array(EndpointPlan))([
    { _tag: "internal", protocol: "http", port: 80, scan: first },
    { _tag: "published", protocol: "http", port: 80, publication: {}, scan: second },
  ]);
  // When / Then
  expect(endpointInvariantIssues(endpoints)).toEqual([{ kind: "scan-conflict", identities: ["80/tcp"] }]);
});

test("allows omitted scan fields to inherit and compares status codes as sets", () => {
  // Given
  const endpoints = Schema.decodeUnknownSync(Schema.Array(EndpointPlan))([
    { _tag: "internal", protocol: "http", port: 80, scan: { path: "/live", okCodes: [200, 204] } },
    { _tag: "published", protocol: "http", port: 80, publication: {}, scan: { okCodes: [204, 200, 200] } },
    { _tag: "published", protocol: "http", port: 80, publication: { hostPort: 8080 }, scan: {} },
  ]);
  // When / Then
  expect(endpointInvariantIssues(endpoints)).toEqual([]);
});

test.each([
  { handledServiceFields: [] },
  { handledServiceFields: ["webroot"] },
  { handledServiceFields: ["consolePort"] },
  { handledServiceFields: ["webroot", "consolePort"] },
])("decodes successful effective field claims %j", ({ handledServiceFields }) => {
  // Given / When
  const result = Schema.decodeUnknownSync(ServiceFeatureValidationResult)({ handledServiceFields });
  // Then
  expect(result.handledServiceFields).toEqual(handledServiceFields);
});

test.each([{ handledServiceFields: ["image"] }, {}, { handledServiceFields: [], issues: [] }])(
  "rejects unsupported claims and success-channel findings %j",
  (input) => {
    // Given / When / Then
    expect(() =>
      Schema.decodeUnknownSync(ServiceFeatureValidationResult, { onExcessProperty: "error" })(input),
    ).toThrow();
  },
);

test("preserves relative feature findings without requiring them on historical errors", () => {
  // Given
  const base = { message: "Invalid listener", feature: "minio", remediation: "Choose distinct ports." };
  const issues = [{ path: ["consolePort"], message: "Port collides", suggestion: "Choose another port." }];
  // When
  const error = new ServiceFeatureError({ ...base, issues });
  // Then
  expect(
    Schema.decodeUnknownSync(ServiceFeatureError)(Schema.encodeSync(ServiceFeatureError)(error)).issues,
  ).toEqual(issues);
  expect(new ServiceFeatureError(base).issues).toBeUndefined();
});

test.each([
  { type: "minio" },
  { type: "minio", image: "example/minio:custom" },
  { type: "minio", build: "." },
  { type: "minio", build: { context: ".", dockerfile: "Containerfile" } },
])("accepts inherited, image, and Compose-build MinIO inputs %j", (input) => {
  // Given / When
  const result = Schema.decodeUnknownSync(MinIOServiceConfig, { onExcessProperty: "error" })(input);
  // Then
  expect(result.image).toBe("image" in input ? input.image : undefined);
  expect(result.build !== undefined).toBe("build" in input);
});
