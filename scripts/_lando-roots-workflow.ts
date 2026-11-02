// GITHUB_ENV keeps setup, test preloads, CLI children, and teardown on the same
// roots. The runner context is unavailable in job-level env declarations.
export const isolateLandoRootsStep = `      - name: Isolate Lando roots
        shell: bash
        run: |
          echo "LANDO_USER_CONF_ROOT=$RUNNER_TEMP/lando-conf" >> "$GITHUB_ENV"
          echo "LANDO_USER_DATA_ROOT=$RUNNER_TEMP/lando-data" >> "$GITHUB_ENV"
          echo "LANDO_USER_CACHE_ROOT=$RUNNER_TEMP/lando-cache" >> "$GITHUB_ENV"
          echo "LANDO_SYSTEM_PLUGIN_ROOT=$RUNNER_TEMP/lando-system-plugins" >> "$GITHUB_ENV"`;
