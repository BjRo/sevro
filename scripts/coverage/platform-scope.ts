const unreachable: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["src/hosts/linux-sandbox.ts"],
  linux: ["src/hosts/claude-keychain.ts", "src/hosts/mac-sandbox.ts"],
};

/** Keep the complete inventory checked while measuring executable host code. */
export function platformCoverageScope(
  production: string[],
  platform: NodeJS.Platform = process.platform,
) {
  const excluded = unreachable[platform] ?? [];
  for (const file of excluded) {
    if (!production.includes(file))
      throw new Error(`Missing platform-scoped production file: ${file}`);
  }
  return {
    platform,
    included: production.filter((file) => !excluded.includes(file)),
    excluded,
  };
}
