import 'dotenv/config';
import { z } from 'zod';

const booleanFromString = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');

const migrationSchema = z.object({
  MIGRATION_DATABASE_URL: z.string().url(),
  DATABASE_SSL: booleanFromString,
});

export type MigrationEnv = z.infer<typeof migrationSchema>;

export function parseMigrationEnv(input: Record<string, string | undefined>): MigrationEnv {
  const parsed = migrationSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid migration environment configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }
  return parsed.data;
}

export function loadMigrationEnv() {
  return parseMigrationEnv(process.env);
}
