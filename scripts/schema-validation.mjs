import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';

const schemas = {
  status: JSON.parse(readFileSync(new URL('../status.schema.json', import.meta.url), 'utf8')),
  slo: JSON.parse(readFileSync(new URL('../slo.schema.json', import.meta.url), 'utf8')),
  badge: JSON.parse(readFileSync(new URL('../badge.schema.json', import.meta.url), 'utf8')),
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validators = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]));

export function validateJsonSchema(value, name) {
  const validate = validators[name];
  if (!validate) throw new Error(`unknown JSON Schema: ${name}`);
  if (!validate(value)) {
    const details = (validate.errors || [])
      .map((error) => {
        const message = error.keyword === 'additionalProperties'
          ? 'unexpected property'
          : error.keyword === 'required'
            ? 'missing property'
            : error.message;
        return `${error.instancePath || '/'} ${message}`;
      })
      .join('; ');
    throw new Error(`${name}.json failed JSON Schema validation${details ? `: ${details}` : ''}`);
  }
  return true;
}
