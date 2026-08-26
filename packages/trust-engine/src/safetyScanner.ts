export const PUBLIC_SAFETY_RULESET_VERSION =
  "guildhall-public-safety/1.0.0" as const;

export const PUBLIC_SAFETY_LIMITS = Object.freeze({
  maximumAggregateBytes: 65_536,
  maximumDepth: 12,
  maximumTotalKeys: 512,
  maximumKeysPerObject: 128,
  maximumArrayItems: 256,
});

export const PublicSafetyCategory = {
  ArrayLimitExceeded: "array-limit-exceeded",
  AwsCredential: "aws-credential",
  BearerToken: "bearer-token",
  CredentialField: "credential-field",
  EmailAddress: "email-address",
  ExecutableContent: "executable-content",
  GithubToken: "github-token",
  GovernmentId: "government-id",
  HighEntropySecret: "high-entropy-secret",
  KeyLimitExceeded: "key-limit-exceeded",
  MaximumDepthExceeded: "maximum-depth-exceeded",
  NonAllowlistedUrlProtocol: "non-allowlisted-url-protocol",
  PayloadTooLarge: "payload-too-large",
  PhoneNumber: "phone-number",
  PrivateKey: "private-key",
  PrivateNetwork: "private-network",
  ProviderToken: "provider-token",
  UnsupportedJsonValue: "unsupported-json-value",
} as const;

export type PublicSafetyCategory =
  (typeof PublicSafetyCategory)[keyof typeof PublicSafetyCategory];

export type PublicSafetyScanResult =
  | Readonly<{ safe: true }>
  | Readonly<{
      safe: false;
      fieldPath: string;
      category: PublicSafetyCategory;
    }>;

export type RedactedPublicPayload = Readonly<{
  kind: "redacted-public-payload";
  rulesetVersion: typeof PUBLIC_SAFETY_RULESET_VERSION;
}>;

const REDACTED_PUBLIC_PAYLOAD: RedactedPublicPayload = Object.freeze({
  kind: "redacted-public-payload",
  rulesetVersion: PUBLIC_SAFETY_RULESET_VERSION,
});

const SAFE_RESULT: PublicSafetyScanResult = Object.freeze({ safe: true });

const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/i;
const PROVIDER_TOKEN_PATTERN =
  /\b(?:sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/;
const GITHUB_TOKEN_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/;
const BEARER_TOKEN_PATTERN = /\bBearer[ \t]+[A-Za-z0-9._~+/-]{12,}={0,2}\b/i;
const EMAIL_PATTERN =
  /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63})+\b/i;
const INTERNATIONAL_PHONE_PATTERN =
  /(?:^|[^A-Za-z0-9])\+\d[\d ().-]{7,20}\d(?:$|[^A-Za-z0-9])/;
const PARENTHESIZED_PHONE_PATTERN =
  /(?:^|[^A-Za-z0-9])\(\d{2,4}\)[ -]?\d{3,4}[ -]?\d{4}(?:$|[^A-Za-z0-9])/;
const GROUPED_PHONE_PATTERN =
  /(?:^|[^0-9])\d{3}[ .-]\d{3}[ .-]\d{4}(?:$|[^0-9])/;
const GOVERNMENT_ID_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const PRIVATE_HOSTNAME_PATTERN =
  /(?:^|[^A-Za-z0-9-])(?:localhost|[A-Za-z0-9-]+\.(?:localhost|local|internal|lan|home))(?:$|[^A-Za-z0-9-])/i;
const PRIVATE_IPV6_PATTERN =
  /(?:^|[\s/[,(])(?:::1|::|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;
const EXPLICIT_URL_PATTERN =
  /\b([A-Za-z][A-Za-z0-9+.-]{1,31}):\/\/[^\s<>"']{1,4096}/g;
const NON_NETWORK_URL_PATTERN =
  /\b(?:data|file|blob|javascript|vbscript|mailto|tel):/i;
const ACTIVE_ELEMENT_PATTERN =
  /<\/?\s*(?:script|iframe|object|embed|base|meta|link|form)\b/i;
const EVENT_HANDLER_PATTERN = /<[A-Za-z][^>]{0,1024}\son[A-Za-z]{2,32}\s*=/i;
const ACTIVE_ATTRIBUTE_PATTERN = /\b(?:srcdoc|formaction)\s*=/i;
const SCRIPT_PROTOCOL_PATTERN = /\b(?:javascript|vbscript)\s*:/i;
const HTML_DATA_PATTERN = /\bdata\s*:\s*text\/(?:html|javascript)/i;
const SAFE_PATH_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const HIGH_ENTROPY_ALPHABET_PATTERN = /^[A-Za-z0-9_+./=-]+$/;

const ALWAYS_REJECTED_CREDENTIAL_FIELDS = new Set([
  "apikey",
  "apitoken",
  "authorization",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "credential",
  "credentials",
  "githubtoken",
  "modelprovidertoken",
  "openaiapikey",
  "anthropicapikey",
  "password",
  "passwd",
  "privatekey",
  "providertoken",
  "secretaccesskey",
  "secretkey",
  "awsaccesskeyid",
  "awssecretaccesskey",
]);

const PUBLIC_KEY_CONTEXTS = new Set([
  "jwk",
  "jwkset",
  "keyid",
  "kid",
  "publickey",
  "publickeyjwk",
  "signingkeyid",
]);

const GOVERNMENT_ID_FIELDS = new Set([
  "governmentid",
  "nationalid",
  "passportnumber",
  "passport",
  "driverlicense",
  "driverslicense",
  "socialsecuritynumber",
  "ssn",
  "taxid",
]);

interface ScanContext {
  aggregateBytes: number;
  totalKeys: number;
  readonly ancestors: WeakSet<object>;
}

function rejection(
  fieldPath: string,
  category: PublicSafetyCategory,
): PublicSafetyScanResult {
  return { safe: false, fieldPath, category };
}

function normalizedFieldName(fieldName: string): string {
  return fieldName.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fieldWords(fieldName: string): readonly string[] {
  return fieldName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function childPath(parentPath: string, key: string, ordinal: number): string {
  return SAFE_PATH_KEY_PATTERN.test(key)
    ? `${parentPath}.${key}`
    : `${parentPath}[key:${ordinal}]`;
}

function chargeBytes(
  context: ScanContext,
  byteCount: number,
  fieldPath: string,
): PublicSafetyScanResult | undefined {
  if (
    byteCount < 0 ||
    byteCount >
      PUBLIC_SAFETY_LIMITS.maximumAggregateBytes - context.aggregateBytes
  ) {
    return rejection(fieldPath, PublicSafetyCategory.PayloadTooLarge);
  }
  context.aggregateBytes += byteCount;
  return undefined;
}

function jsonStringByteLength(
  value: string,
  maximumRemainingBytes: number,
): number {
  if (value.length + 2 > maximumRemainingBytes) {
    return maximumRemainingBytes + 1;
  }

  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2;
    } else if (codeUnit <= 0x1f) {
      bytes +=
        codeUnit === 0x08 ||
        codeUnit === 0x09 ||
        codeUnit === 0x0a ||
        codeUnit === 0x0c ||
        codeUnit === 0x0d
          ? 2
          : 6;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length
    ) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }

    if (bytes > maximumRemainingBytes) {
      return maximumRemainingBytes + 1;
    }
  }
  return bytes;
}

function isHighEntropySecret(value: string): boolean {
  if (
    value.length < 20 ||
    value.length > 512 ||
    !HIGH_ENTROPY_ALPHABET_PATTERN.test(value)
  ) {
    return false;
  }

  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 3.5;
}

function isSecretContext(fieldName: string | undefined): boolean {
  if (fieldName === undefined) return false;
  const normalized = normalizedFieldName(fieldName);
  if (PUBLIC_KEY_CONTEXTS.has(normalized)) return false;
  return fieldWords(fieldName).some((word) =>
    ["credential", "key", "password", "secret", "token"].includes(word),
  );
}

function credentialFieldCategory(
  fieldName: string | undefined,
): PublicSafetyCategory | undefined {
  if (fieldName === undefined) return undefined;
  const normalized = normalizedFieldName(fieldName);
  if (GOVERNMENT_ID_FIELDS.has(normalized)) {
    return PublicSafetyCategory.GovernmentId;
  }
  if (
    ALWAYS_REJECTED_CREDENTIAL_FIELDS.has(normalized) ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("clientsecret") ||
    normalized.endsWith("credentials")
  ) {
    return PublicSafetyCategory.CredentialField;
  }
  return undefined;
}

function isPrivateIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => part < 0 || part > 255)) {
    return false;
  }
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  );
}

function normalizedHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
}

function isPrivateHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home")
  ) {
    return true;
  }
  if (isPrivateIpv4(host)) return true;
  return (
    host === "::" ||
    host === "::1" ||
    /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^fe[89ab][0-9a-f]:/i.test(host)
  );
}

function urlCategory(value: string): PublicSafetyCategory | undefined {
  if (NON_NETWORK_URL_PATTERN.test(value)) {
    return PublicSafetyCategory.NonAllowlistedUrlProtocol;
  }

  EXPLICIT_URL_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(EXPLICIT_URL_PATTERN)) {
    const protocol = `${(match[1] ?? "").toLowerCase()}:`;
    if (protocol !== "https:") {
      return PublicSafetyCategory.NonAllowlistedUrlProtocol;
    }
    const candidate = (match[0] ?? "").replace(/[),.;!?]+$/, "");
    try {
      const parsed = new URL(candidate);
      if (isPrivateHostname(parsed.hostname)) {
        return PublicSafetyCategory.PrivateNetwork;
      }
    } catch {
      return PublicSafetyCategory.NonAllowlistedUrlProtocol;
    }
  }

  if (
    PRIVATE_HOSTNAME_PATTERN.test(value) ||
    PRIVATE_IPV6_PATTERN.test(value)
  ) {
    return PublicSafetyCategory.PrivateNetwork;
  }

  IPV4_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(IPV4_PATTERN)) {
    if (isPrivateIpv4(match[0])) {
      return PublicSafetyCategory.PrivateNetwork;
    }
  }
  return undefined;
}

function stringCategory(
  value: string,
  fieldName: string | undefined,
): PublicSafetyCategory | undefined {
  if (
    ACTIVE_ELEMENT_PATTERN.test(value) ||
    EVENT_HANDLER_PATTERN.test(value) ||
    ACTIVE_ATTRIBUTE_PATTERN.test(value) ||
    SCRIPT_PROTOCOL_PATTERN.test(value) ||
    HTML_DATA_PATTERN.test(value)
  ) {
    return PublicSafetyCategory.ExecutableContent;
  }
  if (PRIVATE_KEY_PATTERN.test(value)) {
    return PublicSafetyCategory.PrivateKey;
  }
  if (PROVIDER_TOKEN_PATTERN.test(value)) {
    return PublicSafetyCategory.ProviderToken;
  }
  if (GITHUB_TOKEN_PATTERN.test(value)) {
    return PublicSafetyCategory.GithubToken;
  }
  if (AWS_ACCESS_KEY_PATTERN.test(value)) {
    return PublicSafetyCategory.AwsCredential;
  }
  if (BEARER_TOKEN_PATTERN.test(value)) {
    return PublicSafetyCategory.BearerToken;
  }
  if (EMAIL_PATTERN.test(value)) {
    return PublicSafetyCategory.EmailAddress;
  }
  if (
    INTERNATIONAL_PHONE_PATTERN.test(value) ||
    PARENTHESIZED_PHONE_PATTERN.test(value) ||
    GROUPED_PHONE_PATTERN.test(value) ||
    (fieldName !== undefined &&
      fieldWords(fieldName).some((word) =>
        ["mobile", "phone", "telephone"].includes(word),
      ) &&
      (value.match(/\d/g)?.length ?? 0) >= 7)
  ) {
    return PublicSafetyCategory.PhoneNumber;
  }
  if (GOVERNMENT_ID_PATTERN.test(value)) {
    return PublicSafetyCategory.GovernmentId;
  }
  const unsafeUrlCategory = urlCategory(value);
  if (unsafeUrlCategory !== undefined) return unsafeUrlCategory;
  if (isSecretContext(fieldName) && isHighEntropySecret(value)) {
    return PublicSafetyCategory.HighEntropySecret;
  }
  return undefined;
}

function visit(
  value: unknown,
  fieldPath: string,
  fieldName: string | undefined,
  depth: number,
  context: ScanContext,
): PublicSafetyScanResult | undefined {
  if (depth > PUBLIC_SAFETY_LIMITS.maximumDepth) {
    return rejection(fieldPath, PublicSafetyCategory.MaximumDepthExceeded);
  }

  const forbiddenFieldCategory = credentialFieldCategory(fieldName);
  if (forbiddenFieldCategory !== undefined) {
    return rejection(fieldPath, forbiddenFieldCategory);
  }

  if (value === null) {
    return chargeBytes(context, 4, fieldPath);
  }
  if (typeof value === "string") {
    const remaining =
      PUBLIC_SAFETY_LIMITS.maximumAggregateBytes - context.aggregateBytes;
    const charged = chargeBytes(
      context,
      jsonStringByteLength(value, remaining),
      fieldPath,
    );
    if (charged !== undefined) return charged;
    const category = stringCategory(value, fieldName);
    return category === undefined ? undefined : rejection(fieldPath, category);
  }
  if (typeof value === "boolean") {
    return chargeBytes(context, value ? 4 : 5, fieldPath);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return rejection(fieldPath, PublicSafetyCategory.UnsupportedJsonValue);
    }
    return chargeBytes(
      context,
      String(Object.is(value, -0) ? 0 : value).length,
      fieldPath,
    );
  }
  if (typeof value !== "object") {
    return rejection(fieldPath, PublicSafetyCategory.UnsupportedJsonValue);
  }

  if (context.ancestors.has(value)) {
    return rejection(fieldPath, PublicSafetyCategory.UnsupportedJsonValue);
  }
  context.ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      if (value.length > PUBLIC_SAFETY_LIMITS.maximumArrayItems) {
        return rejection(fieldPath, PublicSafetyCategory.ArrayLimitExceeded);
      }
      const charged = chargeBytes(
        context,
        2 + Math.max(0, value.length - 1),
        fieldPath,
      );
      if (charged !== undefined) return charged;
      if (Object.getOwnPropertySymbols(value).length > 0) {
        return rejection(fieldPath, PublicSafetyCategory.UnsupportedJsonValue);
      }
      const arrayDescriptors = Object.getOwnPropertyDescriptors(value);
      const arrayKeys = Object.keys(arrayDescriptors).filter(
        (key) => key !== "length",
      );
      if (
        arrayKeys.length !== value.length ||
        arrayKeys.some((key) => !/^(?:0|[1-9][0-9]*)$/.test(key))
      ) {
        return rejection(fieldPath, PublicSafetyCategory.UnsupportedJsonValue);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = arrayDescriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) {
          return rejection(
            `${fieldPath}[${index}]`,
            PublicSafetyCategory.UnsupportedJsonValue,
          );
        }
        const nested = visit(
          descriptor.value,
          `${fieldPath}[${index}]`,
          undefined,
          depth + 1,
          context,
        );
        if (nested !== undefined) return nested;
      }
      return undefined;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return rejection(fieldPath, PublicSafetyCategory.UnsupportedJsonValue);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return rejection(fieldPath, PublicSafetyCategory.UnsupportedJsonValue);
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (
      keys.length > PUBLIC_SAFETY_LIMITS.maximumKeysPerObject ||
      keys.length > PUBLIC_SAFETY_LIMITS.maximumTotalKeys - context.totalKeys
    ) {
      return rejection(fieldPath, PublicSafetyCategory.KeyLimitExceeded);
    }
    context.totalKeys += keys.length;
    const charged = chargeBytes(
      context,
      2 + Math.max(0, keys.length - 1),
      fieldPath,
    );
    if (charged !== undefined) return charged;

    const isJwk = Object.prototype.hasOwnProperty.call(descriptors, "kty");
    for (const [ordinal, key] of keys.entries()) {
      const opaqueKeyPath = `${fieldPath}[key:${ordinal}]`;
      const keyCategory = stringCategory(key, undefined);
      if (keyCategory !== undefined)
        return rejection(opaqueKeyPath, keyCategory);
      const nestedPath = childPath(fieldPath, key, ordinal);
      const keyCharge = chargeBytes(
        context,
        jsonStringByteLength(
          key,
          PUBLIC_SAFETY_LIMITS.maximumAggregateBytes - context.aggregateBytes,
        ) + 1,
        nestedPath,
      );
      if (keyCharge !== undefined) return keyCharge;

      if (isJwk && ["d", "p", "q", "dp", "dq", "qi", "oth"].includes(key)) {
        return rejection(nestedPath, PublicSafetyCategory.PrivateKey);
      }

      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) {
        return rejection(nestedPath, PublicSafetyCategory.UnsupportedJsonValue);
      }
      const nested = visit(
        descriptor.value,
        nestedPath,
        key,
        depth + 1,
        context,
      );
      if (nested !== undefined) return nested;
    }
    return undefined;
  } finally {
    context.ancestors.delete(value);
  }
}

/**
 * Runs the identical deterministic ruleset used by the browser preflight and
 * Worker publication gate. Rejections intentionally contain no input excerpts.
 */
export function scanPublicPayload(value: unknown): PublicSafetyScanResult {
  try {
    return (
      visit(value, "$", undefined, 0, {
        aggregateBytes: 0,
        totalKeys: 0,
        ancestors: new WeakSet(),
      }) ?? SAFE_RESULT
    );
  } catch {
    return rejection("$", PublicSafetyCategory.UnsupportedJsonValue);
  }
}

/**
 * Public marker used after emergency redaction. Mission IDs and immutable
 * content digests remain in caller-owned metadata and are never accepted here.
 */
export function createRedactedPublicPayload(): RedactedPublicPayload {
  return REDACTED_PUBLIC_PAYLOAD;
}
