import { defineConfig } from "vitest/config";

// Tests live in test/ (outside the app's tsconfig `include`, so `npm run build`
// stays decoupled from test tooling). The diff parser is pure, so the default
// node environment is all it needs.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
