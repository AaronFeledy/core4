import { expect, test } from "bun:test";
import { assertImageBuild, verifyQaInput } from "./minio-qa-image.ts";

test("rejects altered acquisition bytes before building", () => {
  // Given an independently known SHA256 of the empty input.
  const digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  // When / Then: exact bytes pass, corruption fails.
  expect(() => verifyQaInput(new Uint8Array(), digest)).not.toThrow();
  expect(() => verifyQaInput(new Uint8Array([1]), digest)).toThrow("checksum mismatch");
});

test("rejects a registry or compiler error carried inside a successful HTTP stream", () => {
  // Given / When / Then: engine stream errors cannot masquerade as HTTP success.
  expect(() => assertImageBuild('{"stream":"building"}\n{"error":"compile failed"}\n')).toThrow(
    "compile failed",
  );
  expect(() => assertImageBuild("")).toThrow("no events");
  expect(() => assertImageBuild('{"stream":"Successfully tagged local/qa:test"}\n')).not.toThrow();
});
