import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

const testEnvPath = fileURLToPath(new URL("./src/test-env.ts", import.meta.url));

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "node",
    setupFiles: [testEnvPath],
    // Integration tests require a live server + network; excluded from CI.
    exclude: [
      "src/__tests__/integration/**",
      "**/__tests__/integration/**",
      "src/services/cnn.test.ts",
      "**/services/cnn.test.*",
      "dist/**",
      "**/dist/**",
      "**/.claude/**",
      "**/node_modules/**",
    ],
  },
});
