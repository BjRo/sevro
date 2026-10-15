export class CommandCancellation {
  private readonly controller = new AbortController();
  private readonly interrupt = () => {
    this.controller.abort("SIGINT");
  };
  private readonly terminate = () => {
    this.controller.abort("SIGTERM");
  };
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  constructor() {
    process.on("SIGINT", this.interrupt);
    process.on("SIGTERM", this.terminate);
  }
  dispose(): void {
    process.off("SIGINT", this.interrupt);
    process.off("SIGTERM", this.terminate);
  }
}
