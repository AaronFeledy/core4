import { expect, test } from "bun:test";
import { loadBuiltinRecipe } from "../_support/recipe-output.ts";

test.each(["lamp", "backdrop", "joomla"])(
  "%s compiler retains PHP tooling and conditionally drops Composer",
  async (id) => {
    const enabled = await loadBuiltinRecipe(id);
    const disabled = await loadBuiltinRecipe(id, { composer: false });
    expect(enabled.document.tooling).toMatchObject({
      composer: { service: "appserver", cmds: ["composer"] },
      php: { service: "appserver", cmds: ["php"] },
    });
    expect(disabled.document.tooling?.composer).toBeUndefined();
    expect(disabled.document.tooling?.php).toEqual(enabled.document.tooling?.php);
  },
);
