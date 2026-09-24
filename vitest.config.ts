import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Most tests fly the simulation for real, which takes seconds on a laptop
    // and two or three times as long on a shared CI runner. The five-second
    // default failed tests there that pass comfortably here.
    testTimeout: 30_000,
  },
});
