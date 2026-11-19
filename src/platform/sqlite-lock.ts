import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface LockDatabase {
  exec(sql: string): unknown;
  close(): void;
}

/** Both drivers use SQLite file locks, including across Node and Bun runners. */
export function openLockDatabase(path: string): LockDatabase {
  if (process.versions.bun) {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const database = new Database(path);
    return {
      exec: (sql) => database.run(sql),
      close() {
        database.close();
      },
    };
  }
  const { DatabaseSync } =
    require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(path);
}
