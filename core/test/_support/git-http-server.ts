export interface GitHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly protocol: string;
}

export interface GitHttpServer {
  readonly url: (repoName: string) => string;
  readonly requests: readonly GitHttpRequest[];
  readonly stop: () => Promise<void>;
}

/** Serve caller-owned bare repositories; stop before removing the project root. */
export const startGitHttpServer = (root: string): GitHttpServer => {
  const requests: GitHttpRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const protocol = request.headers.get("git-protocol") ?? "";
      requests.push({ method: request.method, path: url.pathname, protocol });
      const body = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array();
      const proc = Bun.spawn(["git", "http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: decodeURIComponent(url.pathname),
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          REMOTE_ADDR: "127.0.0.1",
          GIT_PROTOCOL: protocol,
          HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
        },
        stdin: body,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [output, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) return new Response(stderr, { status: 500 });
      const bytes = Buffer.from(output);
      const boundary = bytes.indexOf("\r\n\r\n");
      if (boundary < 0) return new Response("Missing git CGI headers", { status: 502 });
      const headers = new Headers();
      let status = 200;
      for (const line of bytes.subarray(0, boundary).toString("utf8").split("\r\n")) {
        const separator = line.indexOf(":");
        const name = line.slice(0, separator);
        const value = line.slice(separator + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else headers.append(name, value);
      }
      return new Response(bytes.subarray(boundary + 4), { status, headers });
    },
  });
  const origin = server.url.origin;
  return {
    url: (repoName) => `${origin}/${encodeURIComponent(repoName)}`,
    requests,
    stop: () => server.stop(true),
  };
};
