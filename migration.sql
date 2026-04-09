-- migration.sql
-- Run this manually on your DB if you prefer explicit setup
-- (index.js also runs this automatically on startup via initDB())

CREATE TABLE IF NOT EXISTS variants (
    id         SERIAL PRIMARY KEY,
    subj       VARCHAR(10)  NOT NULL,
    variant    INT          NOT NULL,
    title      TEXT         NOT NULL DEFAULT '',
    questions  JSONB        NOT NULL DEFAULT '[]',
    answers    JSONB        NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (subj, variant)
);

CREATE TABLE IF NOT EXISTS groups (
    id           SERIAL PRIMARY KEY,
    slug         VARCHAR(80)  UNIQUE NOT NULL,
    name         TEXT         NOT NULL DEFAULT '',
    subj1_id     INT          REFERENCES variants(id) ON DELETE SET NULL,
    subj2_id     INT          REFERENCES variants(id) ON DELETE SET NULL,
    subj3_id     INT          REFERENCES variants(id) ON DELETE SET NULL,
    elective_ids INT[]        NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Useful indexes
CREATE INDEX IF NOT EXISTS idx_variants_subj    ON variants (subj);
CREATE INDEX IF NOT EXISTS idx_groups_slug      ON groups   (slug);
