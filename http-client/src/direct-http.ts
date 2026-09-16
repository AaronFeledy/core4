import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export interface DirectHttpInit {
  readonly method: string;
  readonly headers: Headers;
  readonly signal: AbortSignal;
  readonly ca: ReadonlyArray<string> | undefined;
}

export type DirectHttpTransport = (url: URL, init: DirectHttpInit) => Promise<Response>;

/** Bun fetch cannot suppress ambient proxies; Node's request API can go direct without global mutation. */
export const directHttpRequest: DirectHttpTransport = (url, init) =>
  new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: init.method,
        headers: Object.fromEntries(init.headers),
        signal: init.signal,
        agent: false,
        ...(init.ca === undefined ? {} : { ca: [...init.ca] }),
        rejectUnauthorized: true,
      },
      (incoming) => {
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index];
          const value = incoming.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) headers.append(name, value);
        }
        const status = incoming.statusCode ?? 500;
        if (init.method === "HEAD" || status === 204 || status === 205 || status === 304) {
          incoming.destroy();
          resolve(new Response(null, { status, headers }));
          return;
        }
        let decoder: Transform | undefined;
        switch (headers.get("content-encoding")?.trim().toLowerCase()) {
          case "gzip":
            decoder = createGunzip();
            break;
          case "deflate":
            decoder = createInflate();
            break;
          case "br":
            decoder = createBrotliDecompress();
            break;
          default:
            break;
        }
        const source = decoder ?? incoming;
        let finished = false;
        let receivedBytes = false;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            source.pause();
            source.on("data", (chunk: Buffer) => {
              source.pause();
              controller.enqueue(new Uint8Array(chunk));
            });
            source.once("end", () => {
              if (!finished) {
                finished = true;
                controller.close();
              }
            });
            source.once("error", (error: Error) => {
              if (finished) return;
              finished = true;
              // Fetch accepts an empty wire body even when an encoding header is present.
              if (!receivedBytes && incoming.complete) controller.close();
              else controller.error(error);
            });
            if (decoder !== undefined) {
              const decompress = decoder;
              incoming.once("data", () => {
                receivedBytes = true;
              });
              incoming.once("error", (error: Error) => decompress.destroy(error));
              decompress.once("error", () => incoming.destroy());
              incoming.pipe(decompress);
            }
          },
          pull() {
            source.resume();
          },
          cancel() {
            finished = true;
            source.destroy();
            incoming.destroy();
            request.destroy();
          },
        });
        resolve(new Response(body, { status, headers }));
      },
    );
    request.once("error", reject);
    request.end();
  });
