import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/adapters/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './data/layout.db',
  },
});
