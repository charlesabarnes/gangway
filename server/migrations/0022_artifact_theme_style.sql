-- 0022: a theme's shape and layout (corners, edges, stroke, flow nodes, canvas grid, density,
-- text size, heading scale), each a named choice; {} is gangway's own look.
ALTER TABLE artifact_themes ADD COLUMN style_json TEXT NOT NULL DEFAULT '{}';
