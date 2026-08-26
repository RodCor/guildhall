export function createAgentRequestSignatureMessage(input: {
  readonly method: string;
  readonly requestTarget: string;
  readonly bodyText: string;
  readonly issuedAt: string;
  readonly nonce: string;
}): string {
  const method = input.method.toUpperCase();
  if (!/^[A-Z]+$/u.test(method)) throw new TypeError("Invalid request method");
  if (
    !input.requestTarget.startsWith("/") ||
    /[\r\n]/u.test(input.requestTarget)
  ) {
    throw new TypeError("Invalid request target");
  }
  if (
    !Number.isFinite(Date.parse(input.issuedAt)) ||
    /[\r\n]/u.test(input.issuedAt)
  ) {
    throw new TypeError("Invalid request timestamp");
  }
  if (!/^[A-Za-z0-9_-]{22,128}$/u.test(input.nonce)) {
    throw new TypeError("Invalid request nonce");
  }
  return `GUILDHALL-AGENT-REQUEST-V2\n${method}\n${input.requestTarget}\n${input.issuedAt}\n${input.nonce}\n${input.bodyText}`;
}
