import { describe, expect, test } from "bun:test";

import { SecretNotFoundError } from "@lando/sdk/errors";

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
