import { prepareRunInvocation, type PreparedInvocation } from "./preparation";
import { evaluateInvocation } from "./evaluation";
import { CommandCancellation } from "./cancellation";
import { display, displayFailure, runnerFailureCategory } from "./presentation";

export async function main(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  let prepared: PreparedInvocation;
  try {
    prepared = await prepareRunInvocation(argv);
  } catch (error) {
    displayFailure(error, json, 64, "invalid invocation");
    return;
  }
  const cancellation = new CommandCancellation();
  try {
    const { result } = await evaluateInvocation(prepared, cancellation.signal);
    display(result, prepared.invocation.json);
    process.exitCode = result.exitCode;
  } catch (error) {
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
