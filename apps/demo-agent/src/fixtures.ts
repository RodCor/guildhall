import type { JsonObject } from "@guildhall/a2a-worker";

export const ACCESSIBILITY_FIXTURE_ID = "accessibility-dungeon-v1";
export const CONTROLLED_SCRIBE_FAILURE = "scribe-controlled-failure-v1";

const APPROVED_FIXTURE_HTML = `<!doctype html>
<html>
  <head><title>Accessibility Dungeon</title></head>
  <body>
    <img src="quest-map.png">
    <button id="accept-quest"></button>
    <label>Hero name</label><input id="hero-name">
  </body>
</html>`;

export interface AccessibilityFinding extends JsonObject {
  readonly evidence: string;
  readonly findingId: string;
  readonly ruleId: string;
  readonly selector: string;
  readonly severity: "moderate" | "serious";
}

/** Parse only the immutable, allowlisted fixture shipped with this Worker. */
export function parseApprovedFixture(
  fixtureId: string,
): readonly AccessibilityFinding[] {
  if (fixtureId !== ACCESSIBILITY_FIXTURE_ID) {
    throw new TypeError(
      "Only the approved accessibility fixture is supported.",
    );
  }

  const findings: AccessibilityFinding[] = [];
  if (/^<html>/mu.test(APPROVED_FIXTURE_HTML)) {
    findings.push({
      evidence: "The root html element has no lang attribute.",
      findingId: "finding-html-lang",
      ruleId: "html-has-lang",
      selector: "html",
      severity: "serious",
    });
  }
  if (/<img\s+src="[^"]+"\s*>/u.test(APPROVED_FIXTURE_HTML)) {
    findings.push({
      evidence: "The quest-map image has no alt attribute.",
      findingId: "finding-image-alt",
      ruleId: "image-alt",
      selector: "img[src='quest-map.png']",
      severity: "serious",
    });
  }
  if (/<button id="accept-quest"><\/button>/u.test(APPROVED_FIXTURE_HTML)) {
    findings.push({
      evidence: "The empty button has no accessible name.",
      findingId: "finding-button-name",
      ruleId: "button-name",
      selector: "#accept-quest",
      severity: "serious",
    });
  }
  if (
    /<label>Hero name<\/label><input id="hero-name">/u.test(
      APPROVED_FIXTURE_HTML,
    )
  ) {
    findings.push({
      evidence:
        "The visible label is not programmatically associated with the input.",
      findingId: "finding-form-label",
      ruleId: "label",
      selector: "#hero-name",
      severity: "moderate",
    });
  }
  return findings;
}

export function remediationPlan(
  findings: readonly AccessibilityFinding[],
): readonly JsonObject[] {
  return [...findings]
    .sort((left, right) => left.findingId.localeCompare(right.findingId))
    .map((finding) => ({
      acceptance: acceptanceFor(finding.ruleId),
      change: changeFor(finding.ruleId),
      findingId: finding.findingId,
      ruleId: finding.ruleId,
      selector: finding.selector,
    }));
}

export function findingsArtifactContent(
  findings: readonly AccessibilityFinding[] = parseApprovedFixture(
    ACCESSIBILITY_FIXTURE_ID,
  ),
): JsonObject {
  return {
    findings,
    fixtureId: ACCESSIBILITY_FIXTURE_ID,
    kind: "accessibility-findings",
    parserVersion: "1.0.0",
    protocol: "commitment/v1",
  };
}

export function remediationArtifactContent(
  findings: readonly AccessibilityFinding[],
): JsonObject {
  return {
    coveredFindingIds: findings.map((finding) => finding.findingId).sort(),
    fixtureId: ACCESSIBILITY_FIXTURE_ID,
    kind: "remediation-plan",
    protocol: "commitment/v1",
    steps: remediationPlan(findings),
    templateVersion: "1.0.0",
  };
}

function changeFor(ruleId: string): string {
  switch (ruleId) {
    case "html-has-lang":
      return 'Add lang="en" to the root html element.';
    case "image-alt":
      return 'Add alt="Map of the accessibility dungeon" to the quest image.';
    case "button-name":
      return "Add the visible text Accept quest to the button.";
    case "label":
      return 'Add for="hero-name" to the visible Hero name label.';
    default:
      return `Resolve ${ruleId} for the supplied selector.`;
  }
}

function acceptanceFor(ruleId: string): string {
  return `The ${ruleId} rule passes for the approved fixture.`;
}
