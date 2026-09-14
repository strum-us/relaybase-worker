/** Wrangler may store `0000_foo.sql`; the Worker ledger uses `0000_foo`. */
export function normalizeMigrationName(name: string): string {
  return name.trim().replace(/\.sql$/i, "");
}

/** Flatten D1 / Workers errors (`message` is often just `D1_ERROR`). */
export function d1ErrorText(error: unknown): string {
  if (error instanceof Error) {
    const cause =
      error.cause instanceof Error
        ? error.cause.message
        : error.cause != null
          ? String(error.cause)
          : "";
    return [error.message, cause, error.toString()].filter(Boolean).join(" ");
  }
  if (error && typeof error === "object") {
    const o = error as { message?: unknown; error?: unknown; cause?: unknown };
    return [o.message, o.error, o.cause, JSON.stringify(error)]
      .filter((v) => v != null && String(v).length > 0)
      .join(" ");
  }
  return String(error);
}

/** SQLite errors that mean this statement's object is already on the DB. */
export function isSchemaAlreadyPresentError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("already exists") ||
    lower.includes("duplicate column")
  );
}
