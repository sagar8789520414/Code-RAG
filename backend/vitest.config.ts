import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    // Unit tests never touch real services; these only satisfy env validation.
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      MONGODB_URI: "mongodb://127.0.0.1:27017",
      REDIS_URL: "redis://127.0.0.1:6379",
      GROQ_API_KEY: "test-groq-key-0000000000000000",
      GEMINI_API_KEY: "test-gemini-key-000000000000000",
    },
  },
});
