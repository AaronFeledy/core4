const calls: { readonly compile: boolean; readonly metafile: boolean }[] = [];

Bun.build = async (config: Bun.BuildConfig): Promise<Bun.BuildOutput> => {
  calls.push({ compile: typeof config.compile === "object", metafile: config.metafile === true });
  const recordPath = process.env.LANDO_TEST_COMPILE_CALLS;
  if (recordPath === undefined) throw new Error("Missing compile call record path.");
  await Bun.write(recordPath, JSON.stringify(calls));
  if (typeof config.compile === "object" && config.compile.outfile !== undefined) {
    await Bun.write(config.compile.outfile, "fixture executable");
  }
  return { success: true, logs: [], outputs: [] };
};
