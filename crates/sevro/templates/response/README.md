# response evaluation

This deterministic adapter exercises an exact response assertion, without model credentials. Prerequisites: Bun.

```sh
sevro run --run-manifest-file run.json --dry
sevro run --run-manifest-file run.json
sevro report --latest
SEVRO_TEMPLATE_FAIL=1 sevro run --run-manifest-file run.json
```

The negative control must report task=failed and exit 1. Dry preparation is not an assessment.
Edit case.json and adapter.ts, prepare, then run again. Keep private .sevro evidence out of Git.
For a native model, replace the adapter route explicitly with --host, --model and --effort; Codex also requires --codex-auth-file. No model execution or native skill dispatch is established by this adapter.
