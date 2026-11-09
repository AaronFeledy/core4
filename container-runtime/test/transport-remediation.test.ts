import { expect, test } from "bun:test";
import { internalErrorRemediation, taggedErrorJson } from "@lando/sdk/command-result";
import { runtimeRemediation } from "../src/ephemeral-http-failure.ts";
import { ContainerTransportError } from "../src/transport.ts";

test.each(["connect", "write", "read", "http", "parse"] as const)(
  "%s transport failures project the appropriate remediation",
  (kind) => {
    const error = new ContainerTransportError({ kind, operation: "run", message: "Runtime request failed." });

    expect(taggedErrorJson(error).remediation).toBe(
      kind === "parse" ? internalErrorRemediation : runtimeRemediation,
    );
  },
);
