import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const protocolDirectory = resolve("protocol/commitment-v1");
const examplesDirectory = resolve(protocolDirectory, "examples");

describe("published commitment/v1 schema examples", () => {
  it("accepts every valid example and rejects every invalid example", async () => {
    const files = await readdir(examplesDirectory);
    const examples = files.filter((file) => file.endsWith(".json")).sort();
    expect(examples.length).toBeGreaterThan(0);

    for (const exampleFile of examples) {
      const schemaBase = exampleFile.replace(/\.(valid|invalid)\.json$/, "");
      const schemaFile = `${schemaBase === "pact" ? "commitment" : schemaBase}.schema.json`;
      const [schemaText, exampleText] = await Promise.all([
        readFile(resolve(protocolDirectory, schemaFile), "utf8"),
        readFile(resolve(examplesDirectory, exampleFile), "utf8"),
      ]);
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      addFormats(ajv);
      const validate = ajv.compile(JSON.parse(schemaText) as AnySchema);
      const valid = validate(JSON.parse(exampleText));
      expect(
        valid,
        `${basename(exampleFile)}: ${ajv.errorsText(validate.errors)}`,
      ).toBe(exampleFile.endsWith(".valid.json"));
    }
  });
});
