import { Stream } from "effect";

export const execStreamFromResponse = (response: {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}): Stream.Stream<
  { readonly kind: "stdout" | "stderr"; readonly chunk: Uint8Array } | { readonly exitCode: number }
> => {
  const chunks: Array<
    { readonly kind: "stdout" | "stderr"; readonly chunk: Uint8Array } | { readonly exitCode: number }
  > = [];
  const stdout = response.stdout ?? "";
  const stderr = response.stderr ?? "";
  if (stdout.length > 0) chunks.push({ kind: "stdout", chunk: new TextEncoder().encode(stdout) });
  if (stderr.length > 0) chunks.push({ kind: "stderr", chunk: new TextEncoder().encode(stderr) });
  chunks.push({ exitCode: response.exitCode });
  return Stream.fromIterable(chunks);
};
