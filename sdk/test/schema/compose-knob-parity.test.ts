import { describe, expect, test } from "bun:test";

import { ComposeServiceKnobFields, ComposeServiceKnobKey, ServiceConfig } from "@lando/sdk/schema";

/**
 * Published order of ComposeServiceKnobKey. Contract lock for deterministic
 * first-failure reporting in downstream core — hardcoding the ordered array
 * is intentional HERE (this test IS the lock).
 */
const PUBLISHED_COMPOSE_SERVICE_KNOB_KEY_ORDER = [
  "restart",
  "cap_add",
  "cap_drop",
  "privileged",
  "devices",
  "ulimits",
  "sysctls",
  "tmpfs",
  "shm_size",
  "dns",
  "dns_search",
  "dns_opt",
  "extra_hosts",
  "init",
  "stop_signal",
  "stop_grace_period",
  "security_opt",
  "group_add",
  "read_only",
  "platform",
  "pull_policy",
  "logging",
  "gpus",
  "deploy.resources",
] as const;

/** Sole documented capability-key → ServiceConfig field exception. */
const CAPABILITY_KEY_TO_FIELD = (key: string): string => (key === "deploy.resources" ? "deploy" : key);

const FIELD_TO_CAPABILITY_KEY = (field: string): string => (field === "deploy" ? "deploy.resources" : field);

describe("Compose knob capability ↔ ServiceConfig parity", () => {
  test("Given ComposeServiceKnobKey, when literals are read, then order matches the published contract order", () => {
    // Given / When
    const literals = [...ComposeServiceKnobKey.literals];

    // Then
    expect(literals).toEqual([...PUBLISHED_COMPOSE_SERVICE_KNOB_KEY_ORDER]);
    expect(literals).toHaveLength(PUBLISHED_COMPOSE_SERVICE_KNOB_KEY_ORDER.length);
  });

  test("Given every ComposeServiceKnobKey, when mapped to ServiceConfig, then each key has a real field", () => {
    // Given
    const capabilityKeys = [...ComposeServiceKnobKey.literals];
    const serviceFields = new Set(Object.keys(ServiceConfig.fields));

    // When / Then
    for (const key of capabilityKeys) {
      const field = CAPABILITY_KEY_TO_FIELD(key);
      expect(serviceFields.has(field)).toBe(true);
    }
  });

  test("Given every ComposeServiceKnobFields key on ServiceConfig, when reverse-mapped, then each has a ComposeServiceKnobKey", () => {
    // Given — authoring knob fields from the schema object (not a third hardcoded list)
    const authoringKnobFields = Object.keys(ComposeServiceKnobFields);
    const serviceFields = new Set(Object.keys(ServiceConfig.fields));
    const capabilityKeys = new Set<string>(ComposeServiceKnobKey.literals);

    // When / Then — present on ServiceConfig and covered by a capability key
    expect(authoringKnobFields).toHaveLength(ComposeServiceKnobKey.literals.length);
    for (const field of authoringKnobFields) {
      expect(serviceFields.has(field)).toBe(true);
      expect(capabilityKeys.has(FIELD_TO_CAPABILITY_KEY(field))).toBe(true);
    }
  });

  test("Given capability keys and authoring knob fields, when both sides are projected through the mapping, then the sets are equal", () => {
    // Given
    const fieldsFromKeys = new Set([...ComposeServiceKnobKey.literals].map(CAPABILITY_KEY_TO_FIELD));
    const authoringFields = new Set(Object.keys(ComposeServiceKnobFields));
    const serviceFields = new Set(Object.keys(ServiceConfig.fields));

    // When / Then — bidirectional set equality; every authoring field is on ServiceConfig
    expect(fieldsFromKeys).toEqual(authoringFields);
    for (const field of authoringFields) {
      expect(serviceFields.has(field)).toBe(true);
    }
  });
});
