import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit and route tests. No test reaches the network or a real database:
// MongoDB is an in-memory fake (src/test/fake-db.ts), Clerk and Socle are
// stubbed, and src/test/setup.ts makes any other fetch fail.
export default defineConfig({
  // tsconfig keeps JSX for Next ("preserve"); tests render it with React's
  // automatic runtime instead.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
      // The real package throws outside React Server Components.
      "server-only": fileURLToPath(
        new URL("./src/test/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    env: {
      TZ: "UTC",
      SKIP_ENV_VALIDATION: "1",
      DATABASE_URL: "mongodb://127.0.0.1:9/eisenq-test",
      SETTINGS_ENCRYPTION_KEY: "0".repeat(64),
      CLERK_SECRET_KEY: "",
      SOCLE_API_URL: "",
      SOCLE_API_KEY: "",
      CRON_SECRET: "",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
