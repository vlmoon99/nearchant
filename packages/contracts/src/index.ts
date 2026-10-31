import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { schemas } from "./generated/schemas.js";

export type * from "./generated/types.js";
export { schemas };

const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
for (const [file, schema] of Object.entries(schemas)) ajv.addSchema(schema as object, file);

export type SchemaName = keyof typeof schemas;

export class SchemaError extends Error {
  constructor(public readonly schema: string, public readonly errors: string[]) {
    super(`${schema}: ${errors.join("; ")}`);
    this.name = "SchemaError";
  }
}

/** Validates `value` against a spec schema (applies defaults in place) and returns it typed. */
export function validate<T>(schema: SchemaName, value: unknown): T {
  const fn = ajv.getSchema(schema);
  if (!fn) throw new Error(`unknown schema ${schema}`);
  if (!fn(value)) {
    throw new SchemaError(schema, (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`));
  }
  return value as T;
}
