import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    DATABASE_URL: z.string().url(),
    SETTINGS_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "SETTINGS_ENCRYPTION_KEY must be 64 hex chars (32 bytes)"),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    // Waiting-task reminders through Socle (docs/integrations/socle.md). All
    // four are optional: Production sets them, Preview and local builds don't,
    // and without them the daily job and the bell switch themselves off.
    SOCLE_API_URL: z.string().url().optional(),
    SOCLE_API_KEY: z.string().optional(),
    CRON_SECRET: z.string().optional(),
    NOTIFICATIONS_ALLOWED_USER_IDS: z.string().optional(),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    // NEXT_PUBLIC_CLIENTVAR: z.string(),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY,
    NODE_ENV: process.env.NODE_ENV,
    SOCLE_API_URL: process.env.SOCLE_API_URL,
    SOCLE_API_KEY: process.env.SOCLE_API_KEY,
    CRON_SECRET: process.env.CRON_SECRET,
    NOTIFICATIONS_ALLOWED_USER_IDS: process.env.NOTIFICATIONS_ALLOWED_USER_IDS,
    // NEXT_PUBLIC_CLIENTVAR: process.env.NEXT_PUBLIC_CLIENTVAR,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for Docker builds.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
