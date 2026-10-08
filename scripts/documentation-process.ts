export async function runDocumentationCommand(
  argv: string[],
  cwd: string,
): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [output, diagnostic, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${argv[0]} exited ${code}: ${diagnostic || output}`);
  return output;
}
