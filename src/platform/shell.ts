/** Encode one literal argument for a POSIX shell, including empty strings. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
