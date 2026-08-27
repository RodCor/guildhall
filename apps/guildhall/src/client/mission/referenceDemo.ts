export const REFERENCE_DEMO_MISSION_TITLE =
  "Audit and repair an inaccessible public webpage";

const LEGACY_REFERENCE_DEMO_TITLES = new Set([
  "map and remediate the accessibility dungeon",
]);

export function isReferenceDemoMissionTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return (
    normalized === REFERENCE_DEMO_MISSION_TITLE.toLowerCase() ||
    LEGACY_REFERENCE_DEMO_TITLES.has(normalized)
  );
}
