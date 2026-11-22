import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/{canvas,export,gapstyle,overview,tour}.test.ts'] },
});
