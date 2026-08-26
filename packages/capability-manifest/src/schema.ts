import type { JsonSchema } from "./types.js";

export interface SchemaValidationIssue {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

export class CapabilitySchemaValidationError extends TypeError {
  readonly issues: readonly SchemaValidationIssue[];

  constructor(subject: string, issues: readonly SchemaValidationIssue[]) {
    super(
      `${subject} failed schema validation: ${issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "CapabilitySchemaValidationError";
    this.issues = issues;
  }
}

export function validateJsonSchemaValue(
  schema: JsonSchema,
  value: unknown,
): readonly SchemaValidationIssue[] {
  return validateValue(schema, value, "$", []);
}

export function assertJsonSchemaValue(
  schema: JsonSchema,
  value: unknown,
  subject: string,
): void {
  const issues = validateJsonSchemaValue(schema, value);
  if (issues.length > 0) {
    throw new CapabilitySchemaValidationError(subject, issues);
  }
}

/** Validate the schema subset emitted by Guildhall before exposing it. */
export function assertSupportedJsonSchema(
  schema: JsonSchema,
  subject: string,
): void {
  const issues: SchemaValidationIssue[] = [];
  inspectSchema(schema, "$", issues);
  if (issues.length > 0) {
    throw new CapabilitySchemaValidationError(subject, issues);
  }
}

function validateValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  issues: SchemaValidationIssue[],
): readonly SchemaValidationIssue[] {
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    const matches = anyOf.some(
      (candidate) =>
        isSchema(candidate) &&
        validateValue(candidate, value, path, []).length === 0,
    );
    if (!matches) {
      issues.push({
        path,
        keyword: "anyOf",
        message: "must match one allowed schema",
      });
    }
    return issues;
  }

  if ("const" in schema && !jsonEqual(schema.const, value)) {
    issues.push({
      path,
      keyword: "const",
      message: "must equal the required constant",
    });
    return issues;
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => jsonEqual(item, value))
  ) {
    issues.push({ path, keyword: "enum", message: "must be an allowed value" });
    return issues;
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (
    schema.type !== undefined &&
    !types.some((type) => typeof type === "string" && matchesType(type, value))
  ) {
    issues.push({
      path,
      keyword: "type",
      message: `must be ${types.join(" or ")}`,
    });
    return issues;
  }

  if (typeof value === "string") validateString(schema, value, path, issues);
  if (typeof value === "number") validateNumber(schema, value, path, issues);
  if (Array.isArray(value)) validateArray(schema, value, path, issues);
  if (isJsonObject(value)) validateObject(schema, value, path, issues);
  return issues;
}

function validateString(
  schema: JsonSchema,
  value: string,
  path: string,
  issues: SchemaValidationIssue[],
): void {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    issues.push({ path, keyword: "minLength", message: "is too short" });
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    issues.push({ path, keyword: "maxLength", message: "is too long" });
  }
  if (
    typeof schema.pattern === "string" &&
    !new RegExp(schema.pattern, "u").test(value)
  ) {
    issues.push({ path, keyword: "pattern", message: "has an invalid format" });
  }
  if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
    issues.push({
      path,
      keyword: "format",
      message: "must be a real date-time",
    });
  }
}

function validateNumber(
  schema: JsonSchema,
  value: number,
  path: string,
  issues: SchemaValidationIssue[],
): void {
  if (!Number.isFinite(value)) {
    issues.push({ path, keyword: "type", message: "must be finite" });
    return;
  }
  if (schema.type === "integer" && !Number.isSafeInteger(value)) {
    issues.push({ path, keyword: "type", message: "must be a safe integer" });
  }
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    issues.push({ path, keyword: "minimum", message: "is below the minimum" });
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    issues.push({ path, keyword: "maximum", message: "is above the maximum" });
  }
}

function validateArray(
  schema: JsonSchema,
  value: readonly unknown[],
  path: string,
  issues: SchemaValidationIssue[],
): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    issues.push({ path, keyword: "minItems", message: "has too few items" });
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    issues.push({ path, keyword: "maxItems", message: "has too many items" });
  }
  if (schema.uniqueItems === true) {
    const serialized = value.map((item) => stableJson(item));
    if (new Set(serialized).size !== serialized.length) {
      issues.push({
        path,
        keyword: "uniqueItems",
        message: "contains duplicates",
      });
    }
  }
  if (isSchema(schema.items)) {
    value.forEach((item, index) => {
      validateValue(
        schema.items as JsonSchema,
        item,
        `${path}[${index}]`,
        issues,
      );
    });
  }
}

function validateObject(
  schema: JsonSchema,
  value: Readonly<Record<string, unknown>>,
  path: string,
  issues: SchemaValidationIssue[],
): void {
  const entries = Object.entries(value);
  if (
    typeof schema.maxProperties === "number" &&
    entries.length > schema.maxProperties
  ) {
    issues.push({
      path,
      keyword: "maxProperties",
      message: "has too many properties",
    });
  }
  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      issues.push({
        path: `${path}.${key}`,
        keyword: "required",
        message: "is required",
      });
    }
  }
  for (const [key, item] of entries) {
    const propertySchema = properties[key];
    if (isSchema(propertySchema)) {
      validateValue(propertySchema, item, `${path}.${key}`, issues);
    } else if (schema.additionalProperties === false) {
      issues.push({
        path: `${path}.${key}`,
        keyword: "additionalProperties",
        message: "is not allowed",
      });
    }
  }
}

function inspectSchema(
  schema: JsonSchema,
  path: string,
  issues: SchemaValidationIssue[],
): void {
  const validTypes = new Set([
    "object",
    "array",
    "string",
    "number",
    "integer",
    "boolean",
    "null",
  ]);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (
    schema.type !== undefined &&
    types.some((type) => typeof type !== "string" || !validTypes.has(type))
  ) {
    issues.push({ path, keyword: "type", message: "uses an unsupported type" });
  }

  if (typeof schema.pattern === "string") {
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      issues.push({
        path,
        keyword: "pattern",
        message: "is not a valid pattern",
      });
    }
  }
  if (schema.format !== undefined && schema.format !== "date-time") {
    issues.push({
      path,
      keyword: "format",
      message: "uses an unsupported format",
    });
  }

  if (Array.isArray(schema.required)) {
    const required = schema.required.filter(
      (item): item is string => typeof item === "string",
    );
    if (
      required.length !== schema.required.length ||
      new Set(required).size !== required.length
    ) {
      issues.push({
        path,
        keyword: "required",
        message: "must contain unique strings",
      });
    }
    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    for (const key of required) {
      if (!Object.hasOwn(properties, key)) {
        issues.push({
          path: `${path}.${key}`,
          keyword: "required",
          message: "does not name a declared property",
        });
      }
    }
  }

  if (isJsonObject(schema.properties)) {
    for (const [key, property] of Object.entries(schema.properties)) {
      if (isSchema(property))
        inspectSchema(property, `${path}.properties.${key}`, issues);
      else {
        issues.push({
          path: `${path}.properties.${key}`,
          keyword: "schema",
          message: "must be a schema object",
        });
      }
    }
  }
  if (isSchema(schema.items))
    inspectSchema(schema.items, `${path}.items`, issues);
  if (Array.isArray(schema.anyOf)) {
    if (schema.anyOf.length === 0) {
      issues.push({ path, keyword: "anyOf", message: "must not be empty" });
    }
    schema.anyOf.forEach((candidate, index) => {
      if (isSchema(candidate))
        inspectSchema(candidate, `${path}.anyOf[${index}]`, issues);
      else {
        issues.push({
          path: `${path}.anyOf[${index}]`,
          keyword: "schema",
          message: "must be a schema object",
        });
      }
    });
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isJsonObject(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
    case "boolean":
      return typeof value === type;
    default:
      return false;
  }
}

function isSchema(value: unknown): value is JsonSchema {
  return isJsonObject(value);
}

function isJsonObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
