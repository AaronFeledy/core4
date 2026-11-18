// Keep the Bun version and install policy consistent across workflow jobs.
export const setupBunSteps = `      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .bun-version

      - name: Install dependencies
        run: bun install --frozen-lockfile`;
