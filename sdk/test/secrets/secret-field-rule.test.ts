import { describe, expect, test } from "bun:test";

import {
  REDACTED,
  type ValueRedactionScope,
  createRedactor,
  redactSecretField,
  redactValueWith,
} from "@lando/sdk/secrets";

const secrets = createRedactor("secrets");

describe("one secret-named-field rule", () => {
  test.each([
    ["plain free text", "hunter2"],
    ["text that matches no pattern", "some free text"],
    ["text with a secret word", "PASSWORD=hunter2"],
    ["an already redacted value", REDACTED],
  ])("masks %s under a secret-named key", (_label, value) => {
    // Given
    const input = { password: value, note: value };
    // When
    const output = secrets.redactValue(input) as Record<string, unknown>;
    // Then
    expect(output.password).toBe(REDACTED);
    // The same bytes under a public key keep only the ordinary string pass.
    expect(output.note).toBe(typeof value === "string" ? secrets.redactString(value) : REDACTED);
  });

  test("keeps booleans and null as typed facts under secret-named keys", () => {
    // Given
    const input = { secretRedaction: true, tokenAvailable: false, password: null, apiToken: undefined };
    // When
    const output = secrets.redactValue(input) as Record<string, unknown>;
    // Then
    expect(output).toEqual({
      secretRedaction: true,
      tokenAvailable: false,
      password: null,
      apiToken: undefined,
    });
  });

  test.each([12345, 1.5, 10n, Symbol("token")])("masks the %s scalar under a secret-named key", (value) => {
    // Given / When
    const output = secrets.redactValue({ token: value }) as Record<string, unknown>;
    // Then
    expect(output.token).toBe(REDACTED);
  });

  test("keeps an array's type and applies the same rule to each element", () => {
    // Given
    const input = { apiToken: [1, true, "hunter2", null, ["nested"]], tags: ["prod"] };
    // When
    const output = secrets.redactValue(input) as Record<string, unknown>;
    // Then
    expect(output.apiToken).toEqual([REDACTED, true, REDACTED, null, [REDACTED]]);
    expect(output.tags).toEqual(["prod"]);
  });

  test("collapses an object under a secret-named key when no schema describes its keys", () => {
    // Given
    const input = { password: { value: "hunter2" }, nested: { token: "t" } };
    // When
    const output = secrets.redactValue(input) as Record<string, unknown>;
    // Then
    expect(output.password).toBe(REDACTED);
    expect((output.nested as Record<string, unknown>).token).toBe(REDACTED);
  });

  test("collapses an Error under a secret-named key instead of publishing its message", () => {
    // Given
    const input = { password: new Error("connect failed: hunter2") };
    // When
    const output = secrets.redactValue(input) as Record<string, unknown>;
    // Then
    expect(output.password).toBe(REDACTED);
  });

  test("masks an aliased object under its secret key however the walk reaches it", () => {
    // Given
    const shared = { value: "hunter2" };
    // When
    const secretLast = secrets.redactValue({ ok: shared, password: shared }) as Record<string, unknown>;
    const secretFirst = secrets.redactValue({ password: shared, ok: shared }) as Record<string, unknown>;
    // Then
    expect(secretLast).toEqual({ ok: { value: "hunter2" }, password: REDACTED });
    expect(secretFirst).toEqual({ password: REDACTED, ok: { value: "hunter2" } });
  });
});

// A scope whose every key is declared, so an object keeps its shape under a
// secret-named key. This is the shape a compiled schema policy exposes.
const declaredScope = (child?: ValueRedactionScope): ValueRedactionScope => ({
  keyIsDeclared: () => true,
  child: () => child ?? declaredScope(),
  element: () => declaredScope(),
  stringIsExempt: () => false,
});

describe("secret-named-field rule under a declaring scope", () => {
  test("walks a fully declared object field by field and masks each value", () => {
    // Given
    const value = { password: { value: "hunter2", retained: true } };
    // When
    const output = redactValueWith(
      secrets.redactString,
      (key) => key === "password",
      value,
      declaredScope(),
    ) as Record<string, unknown>;
    // Then
    expect(output.password).toEqual({ value: REDACTED, retained: true });
  });

  test("keeps an object's keys readable when the scope declares them", () => {
    // Given
    const value = { creds: { password: "hunter2" } };
    // When
    const output = redactValueWith(
      secrets.redactString,
      (key) => key === "password",
      value,
      declaredScope(),
    ) as Record<string, unknown>;
    // Then
    expect(output).toEqual({ creds: { password: REDACTED } });
  });
});

describe("exotic and schema-typed values under a secret-named key", () => {
  test("fails closed on a revoked proxy instead of throwing", () => {
    // Given an object and an array whose proxy handle has been revoked.
    const object = Proxy.revocable({ value: "hunter2" }, {});
    const array = Proxy.revocable(["hunter2"], {});
    object.revoke();
    array.revoke();
    // When / Then no exotic input throws, and every field fails closed.
    expect(redactSecretField(secrets.redactString, object.proxy)).toEqual({
      kind: "replace",
      text: REDACTED,
    });
    expect(secrets.redactValue(object.proxy)).toBe(REDACTED);
    expect(secrets.redactValue(array.proxy)).toBe(REDACTED);
    expect((secrets.redactValue({ password: object.proxy }) as Record<string, unknown>).password).toBe(
      REDACTED,
    );
    expect((secrets.redactValue({ apiToken: array.proxy }) as Record<string, unknown>).apiToken).toBe(
      REDACTED,
    );
    // A live proxy whose prototype trap throws is equally unreadable.
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("trap");
        },
      },
    );
    expect(secrets.redactValue(hostile)).toBe(REDACTED);
    expect(redactSecretField(secrets.redactString, hostile)).toEqual({
      kind: "replace",
      text: REDACTED,
    });
  });

  const numericScope = (exempt: boolean): ValueRedactionScope => ({
    keyIsDeclared: () => true,
    child: () => numericScope(exempt),
    element: () => numericScope(exempt),
    stringIsExempt: () => false,
    numberIsExempt: () => exempt,
  });

  test("keeps a number only when the scope types the position as a number", () => {
    // Given a number under a secret-named key and a scope that proves the type.
    const value = { apiToken: 12345 };
    // When
    const typed = redactValueWith(secrets.redactString, (_key) => true, value, numericScope(true));
    const opaque = redactValueWith(secrets.redactString, (_key) => true, value, numericScope(false));
    // Then masking it would turn a typed number into a string; an opaque position still masks.
    expect(typed).toEqual({ apiToken: 12345 });
    expect(opaque).toEqual({ apiToken: REDACTED });
    expect(redactSecretField(secrets.redactString, 12345, numericScope(true))).toEqual({
      kind: "ordinary",
    });
    expect(redactSecretField(secrets.redactString, 12345, numericScope(false))).toEqual({
      kind: "replace",
      text: REDACTED,
    });
  });
});
