import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tests mutate process.env + a process-wide SQLite singleton; run files sequentially.
    fileParallelism: false,
  },
});
