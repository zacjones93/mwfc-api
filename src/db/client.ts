import { Client } from "@planetscale/database";
import { drizzle } from "drizzle-orm/planetscale-serverless";
import * as schema from "./schema";

export type Env = {
  DATABASE_URL?: string;
  DATABASE_HOST?: string;
  DATABASE_USERNAME?: string;
  DATABASE_PASSWORD?: string;
  ALLOWED_ORIGINS: string;
};

export function createDb(env: Env) {
  const client = env.DATABASE_URL
    ? new Client({ url: env.DATABASE_URL })
    : new Client({
        host: env.DATABASE_HOST!,
        username: env.DATABASE_USERNAME!,
        password: env.DATABASE_PASSWORD!,
      });

  return drizzle(client, { schema, casing: "snake_case" });
}

export type Database = ReturnType<typeof createDb>;
