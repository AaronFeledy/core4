import { Effect, Stream } from "effect";
import type { EngineHttpApi } from "../../src/engine-api.ts";
import { isUmaskProbeCommand } from "../../src/podman/exec-umask.ts";

export const installNonCompensatingExecUmask = (api: EngineHttpApi): void => {
  const request = api.request;
  const stream = api.stream;
  if (request === undefined || stream === undefined)
    throw new TypeError("Fake exec API requires request and stream");
  const id = "lando-test-umask-probe";
  const payload = new TextEncoder().encode("Umask:\t0022\n");
  const frame = new Uint8Array(8 + payload.length);
  frame[0] = 1;
  new DataView(frame.buffer).setUint32(4, payload.length);
  frame.set(payload, 8);
  Object.assign(api, {
    request: (input: Parameters<typeof request>[0]) => {
      const body = input.body;
      if (
        input.method === "POST" &&
        input.path.startsWith("/containers/") &&
        input.path.endsWith("/exec") &&
        typeof body === "object" &&
        body !== null &&
        "Cmd" in body &&
        Array.isArray(body.Cmd) &&
        isUmaskProbeCommand(body.Cmd)
      ) {
        return Effect.succeed({ status: 201, body: JSON.stringify({ Id: id }) });
      }
      if (input.method === "GET" && input.path === `/exec/${id}/json`) {
        return Effect.succeed({ status: 200, body: JSON.stringify({ Running: false, ExitCode: 0 }) });
      }
      return request(input);
    },
    stream: (input: Parameters<typeof stream>[0]) =>
      input.path === `/exec/${id}/start`
        ? Stream.suspend(() => {
            input.onResponseHead?.();
            return Stream.make(frame);
          })
        : stream(input),
  });
};
