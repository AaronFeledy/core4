import { describe, expect, test } from "bun:test";

import { BuildArgSecretReferenceError, SecretNotFoundError } from "@lando/sdk/errors";

describe("SecretNotFoundError", () => {
  test("is a tagged error carrying the secret id", () => {
    const error = new SecretNotFoundError({
      message: "Secret 'MY_TOKEN' was not found",
      secret: "MY_TOKEN",
    });

    expect(error._tag).toBe("SecretNotFoundError");
    expect(error.secret).toBe("MY_TOKEN");
    expect(error.message).toContain("MY_TOKEN");
  });

  test("accepts an optional remediation", () => {
    const error = new SecretNotFoundError({
      message: "missing",
      secret: "API_KEY",
      remediation: "Set LANDO_SECRET_API_KEY in the environment.",
    });

    expect(error.remediation).toBe("Set LANDO_SECRET_API_KEY in the environment.");
  });
});

describe("BuildArgSecretReferenceError", () => {
  test("is a tagged error naming the service and arg", () => {
    const error = new BuildArgSecretReferenceError({
      message:
        "Service web build arg TOKEN contains a secret reference. Build args are recorded in image history.",
      service: "web",
      arg: "TOKEN",
      remediation: "Put the secret in a service environment value instead.",
    });

    expect(error._tag).toBe("BuildArgSecretReferenceError");
    expect(error.service).toBe("web");
    expect(error.arg).toBe("TOKEN");
    expect(error).not.toHaveProperty("reference");
    expect(error.remediation).toContain("environment");
  });
});
