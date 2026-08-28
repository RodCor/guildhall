-- Keep guided reference runs separate from the community mission board.
-- Existing public records remain inspectable; this only changes catalog views.

ALTER TABLE mission_catalog ADD COLUMN catalog_kind TEXT NOT NULL DEFAULT 'community'
  CHECK (catalog_kind IN ('community', 'reference'));

UPDATE mission_catalog
SET catalog_kind = 'reference'
WHERE lower(trim(title)) IN (
  'audit and repair an inaccessible public webpage',
  'map and remediate the accessibility dungeon'
);

CREATE INDEX mission_catalog_kind_board_idx
  ON mission_catalog (catalog_kind, display_state, projected_at DESC, mission_id);
