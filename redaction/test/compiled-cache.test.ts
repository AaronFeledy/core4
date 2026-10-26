import { expect, test } from "bun:test";
import { Effect } from "effect";

import { createStandaloneRedactor, makeRedactionOwner } from "../src/service.ts";

test("standalone redactors with different environments never mask each other's values", () => {
  // Given two standalone redactors built from environments with different secrets.
  const first = createStandaloneRedactor("secrets", { sourceEnv: { API_TOKEN: "first-token-value-1" } });
  const second = createStandaloneRedactor("secrets", { sourceEnv: { API_TOKEN: "second-token-value-2" } });
  // When each redacts text holding both values.
  const text = "first-token-value-1 second-token-value-2";
  // Then each masks only its own value.
  expect(first.redactString(text)).toBe("[redacted] second-token-value-2");
  expect(second.redactString(text)).toBe("first-token-value-1 [redacted]");
});

test("a redactor built before a registration masks the value registered later", () => {
  // Given a service redactor created before any value is registered.
  const owner = makeRedactionOwner();
  const redactor = Effect.runSync(owner.service.forProfile("secrets"));
  expect(redactor.redactString("late-registered-value-3")).toBe("late-registered-value-3");
  // When a value is registered afterwards.
  Effect.runSync(owner.service.registerValues(["late-registered-value-3"]));
  // Then the existing redactor masks it.
  expect(redactor.redactString("late-registered-value-3")).toBe("[redacted]");
});

test("owners do not share compiled registrations", () => {
  // Given one owner holding a registration and another holding none.
  const holder = makeRedactionOwner();
  Effect.runSync(holder.service.registerValues(["owner-scoped-value-4"]));
  const other = makeRedactionOwner();
  // When both redact the same text with the same options.
  const held = Effect.runSync(holder.service.forProfile("secrets", { sourceEnv: {} }));
  const unheld = Effect.runSync(other.service.forProfile("secrets", { sourceEnv: {} }));
  // Then only the registering owner masks the value.
  expect(held.redactString("owner-scoped-value-4")).toBe("[redacted]");
  expect(unheld.redactString("owner-scoped-value-4")).toBe("owner-scoped-value-4");
});

test("disposing an owner drops its registrations from redactors built afterwards", () => {
  // Given an owner whose registration was used once.
  const owner = makeRedactionOwner();
  Effect.runSync(owner.service.registerValues(["disposed-value-5"]));
  expect(Effect.runSync(owner.service.forProfile("secrets")).redactString("disposed-value-5")).toBe(
    "[redacted]",
  );
  // When the owner is disposed.
  owner.dispose();
  // Then a new redactor from it no longer holds the value.
  expect(Effect.runSync(owner.service.forProfile("secrets")).redactString("disposed-value-5")).toBe(
    "disposed-value-5",
  );
});

test("disposing an owner invalidates retained matchers without dropping explicit values", () => {
  // Given a retained redactor compiled with both owner registrations and explicit values.
  const owner = makeRedactionOwner();
  Effect.runSync(owner.service.registerValues(["disposed-registration-value"]));
  const redactor = Effect.runSync(
    owner.service.forProfile("secrets", { authoritativeTokens: ["explicit-retained-value"] }),
  );
  const text = "disposed-registration-value explicit-retained-value";
  expect(redactor.redactString(text)).toBe("[redacted] [redacted]");
  // When the owner is disposed.
  owner.dispose();
  // Then the retained redactor no longer masks registrations, but keeps its caller's values.
  expect(redactor.redactString(text)).toBe("disposed-registration-value [redacted]");
});
