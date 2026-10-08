/** Bound trial admission, stop on errors/cancellation, and drain active work. */
export async function scheduleTrials(
  options: { count: number; jobs: number; signal?: AbortSignal },
  run: (trial: number, stopAdmission: () => void) => Promise<boolean>,
): Promise<void> {
  let nextTrial = 1;
  let stopped = false;
  const stopAdmission = () => {
    stopped = true;
  };
  let failure: { error: unknown } | undefined;
  const admitting = () =>
    !stopped && !options.signal?.aborted && nextTrial <= options.count;
  const worker = async () => {
    while (admitting()) {
      const trial = nextTrial++;
      try {
        if (!(await run(trial, stopAdmission))) stopAdmission();
      } catch (error) {
        stopped = true;
        failure ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.jobs, options.count) }, worker),
  );
  if (failure) throw failure.error;
}
