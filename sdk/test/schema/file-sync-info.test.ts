import { expect, test } from "bun:test";
import {
  FileSyncEngineDescriptor,
  FileSyncInfo,
  FileSyncPolicy,
  FileSyncPolicyInfo,
  FileSyncPolicyReason,
  FileSyncServicePolicy,
} from "@lando/sdk/schema";
import { TestFileSyncEngine } from "@lando/sdk/test";
import { Schema } from "effect";

test("policy contracts round-trip without adding current reasons to historical data", () => {
  const service = { mode: "ordinary", reason: "native-provider" } as const;
  const policy = { reason: "native-provider", services: { web: service } } as const;
  const view = { mode: "ordinary", reason: "unknown", services: [] } as const;
  const info = { planned: view, pendingChange: false };
  expect(
    Schema.encodeSync(FileSyncServicePolicy)(Schema.decodeUnknownSync(FileSyncServicePolicy)(service)),
  ).toEqual(service);
  expect(Schema.encodeSync(FileSyncPolicy)(Schema.decodeUnknownSync(FileSyncPolicy)(policy))).toEqual(policy);
  expect(Schema.encodeSync(FileSyncPolicyInfo)(Schema.decodeUnknownSync(FileSyncPolicyInfo)(view))).toEqual(
    view,
  );
  expect(Schema.encodeSync(FileSyncInfo)(Schema.decodeUnknownSync(FileSyncInfo)(info))).toEqual(info);
  expect(Schema.is(FileSyncPolicyReason)("guessed-from-global-config")).toBe(false);
});

test("engine support is required and nonempty independent of default preference", () => {
  const base = { id: "example", capabilities: TestFileSyncEngine.capabilities };
  expect(Schema.is(FileSyncEngineDescriptor)(base)).toBe(false);
  expect(Schema.is(FileSyncEngineDescriptor)({ ...base, supports: { platform: [] } })).toBe(false);
  expect(
    Schema.is(FileSyncEngineDescriptor)({
      ...base,
      supports: { platform: ["win32"] },
      defaultFor: { platform: ["linux"] },
    }),
  ).toBe(true);
});
