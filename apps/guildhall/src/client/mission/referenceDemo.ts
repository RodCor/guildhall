export const REFERENCE_DEMO_MISSION_TITLE =
  "Audit and repair an inaccessible public webpage";

export const VERIFIED_DELIVERY_DEMO_MISSION_ID =
  "0898f079-d635-40bd-a1b4-0f17951f0191";
export const VERIFIED_DELIVERY_DEMO_MISSION_TITLE =
  "Ship verified GitHub delivery targets";

const LEGACY_REFERENCE_DEMO_TITLES = new Set([
  "map and remediate the accessibility dungeon",
]);

export function isReferenceDemoMissionTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return (
    normalized === VERIFIED_DELIVERY_DEMO_MISSION_TITLE.toLowerCase() ||
    normalized === REFERENCE_DEMO_MISSION_TITLE.toLowerCase() ||
    LEGACY_REFERENCE_DEMO_TITLES.has(normalized)
  );
}
