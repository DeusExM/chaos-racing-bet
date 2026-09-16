import { defineConfig } from 'vitest/config';

// Le noyau (src/core) doit rester testable SANS navigateur : environnement node.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
