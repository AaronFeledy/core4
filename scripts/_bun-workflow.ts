import { pinnedAction } from "./action-pins.ts";
// Keep the Bun version and install policy consistent across workflow jobs.
export const setupBunSteps = `      - name: Setup Bun
        uses: ${pinnedAction("oven-sh/setup-bun")}
        with:
          bun-version-file: .bun-version

      - name: Install dependencies
        run: bun install --frozen-lockfile`;
