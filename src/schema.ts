import Ajv2020 from "ajv/dist/2020.js";
import cliSchema from "../schemas/cli-result-v1.schema.json";
import runSchema from "../schemas/run-evidence-v1.schema.json";

const ajv = new Ajv2020({
  strict: true,
  strictRequired: false,
  strictTypes: false,
});
ajv.addSchema(cliSchema);
ajv.addSchema(runSchema);
const cliValidator = ajv.getSchema("urn:sevro:schema:cli-result:v1")!;
const runValidator = ajv.getSchema("urn:sevro:schema:run-evidence:v1")!;

export function assertCliResult(value: unknown): void {
  if (!cliValidator(value)) throw new Error("invalid Sevro CLI result");
}

export function assertRunEvidence(value: unknown): void {
  if (!runValidator(value)) throw new Error("invalid Sevro retained evidence");
}
