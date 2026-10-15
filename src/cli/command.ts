import { prepareRunInvocation, type PreparedInvocation } from "./preparation";
import { evaluateInvocation } from "./evaluation";
import { CommandCancellation } from "./cancellation";
import { display, displayFailure, runnerFailureCategory } from "./presentation";
import { displayEffectiveSettings } from "./settings";
import { jsonOutputRequested } from "./run-options";
import { retainCliResult } from "./completion";

type CommandRelease = (() => Promise<void>) | undefined;

export async function main(
  argv: string[],
  release?: () => Promise<void>,
): Promise<void> {
  const json = jsonOutputRequested(argv);
  let prepared: PreparedInvocation;
  try {
    prepared = await prepareRunInvocation(argv);
  } catch (error) {
    await releaseBeforeDisplay(release, 64);
    displayFailure(error, json, 64, "invalid invocation");
    return;
  }
  const cancellation = new CommandCancellation();
  try {
    displayEffectiveSettings(prepared);
    const { result } = await evaluateInvocation(prepared, cancellation.signal);
    const completion = await retainCompletion(
      result,
      prepared.invocation.resultsRoot,
    );
    await releaseBeforeDisplay(release, result.exitCode);
    display(result, prepared.invocation.json, completion);
    process.exitCode = result.exitCode;
  } catch (error) {
    await releaseBeforeDisplay(release, 70);
    displayFailure(
      error,
      prepared.invocation.json,
      runnerFailureCategory(error),
      "runner failure",
    );
  } finally {
    cancellation.dispose();
  }
}

async function retainCompletion(
  result: Parameters<typeof retainCliResult>[0],
  resultsRoot: string,
) {
  try {
    return await retainCliResult(result, resultsRoot);
  } catch (cause) {
    if (result.exitCode === 0)
      throw new Error(
        "CLI result/latest could not be retained; check --results-root permissions",
        { cause },
      );
    process.stderr.write(
      "sevro: CLI result/latest could not be retained; original run outcome preserved; inspect evidence directly\n",
    );
    return undefined;
  }
}

async function releaseBeforeDisplay(
  release: CommandRelease,
  exitCode: number,
): Promise<void> {
  try {
    await release?.();
  } catch (error) {
    if (exitCode === 0) throw error;
    const detail =
      error instanceof Error
        ? error.message
        : "temporary project could not be removed";
    process.stderr.write(`sevro: demo cleanup failed: ${detail}\n`);
  }
}
