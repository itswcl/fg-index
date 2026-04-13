import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "node",
    // Integration tests require a live server + network; excluded from CI.
    exclude: [
      "src/__tests__/integration/**",
      "src/services/cnn.test.ts",
      "**/node_modules/**",
    ],
  },
});
