'use strict';
/**
 * apishka — NMT-2026 scoring backend v2 (Node.js / Express / PostgreSQL)
 *
 * API surface:
 *   GET  /api/group/:slug             → group config (no answer keys)
 *   POST /api/group/:slug/score       → { answers, electiveVariantId } → scores
 *   POST /api/admin/variants          → upsert variant (requires x-admin-key)
 *   POST /api/admin/groups            → upsert group   (requires x-admin-key)
 *
 * Answer key format in DB (variants.answers JSONB):
 *   radio / cloze_sub : 'qId'      → 'X'
 *   match             : 'qId'      → { 1:'X', 2:'X', 3:'X', 4:'X' }
 *   text              : 'qId'      → '3.14'
 *   double_text       : 'qId'      → { 1:'5', 2:'12' }
 *   triple_text       : 'qId'      → { 1:'5', 2:'12', 3:'7' }
 *   cloze subs        : 'sel-e17'  → 'A'
 *
 * Letter mapping (Ukrainian → stored English value):
 *   А→A  Б→B  В→C  Г→D  Д→E  Е→F  Є→G  Ж→H
 *
 * Scoring rules:
 *   radio       : 1 pt if correct
 *   match       : 1 pt per correct pair (max 4/5 depending on question)
 *   text        : 2 pts if correct
 *   double_text : 1 pt per correct value (max 2)
 *   triple_text : 1 pt per correct value (max 3)
 *   cloze_sub   : 1 pt if correct
 *
 * Deploy on Render.com:
 *   1. Push this folder to GitHub
 *   2. Create a Render Web Service → Build: `npm install` Start: `node index.js`
 *   3. Set env vars: DATABASE_URL, ADMIN_KEY, PORT (optional)
 *   4. Run `node import.js` once to seed variants + groups
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// ─── Centralised error logger ─────────────────────────────────────────────────
// Always includes an ISO timestamp and the full stack trace so log aggregators
// (e.g. Render's log stream) can pinpoint the exact source line.

function logError(context, err) {
    const ts = new Date().toISOString();
    console.error(`[${ts}] ERROR in ${context}:`);
    console.error(err instanceof Error ? err.stack : err);
}

// ─── Process-level safety nets ────────────────────────────────────────────────
// These catch anything that slips past route-level try/catch blocks.

process.on('uncaughtException', (err) => {
    logError('uncaughtException', err);
    // Give the logger a tick to flush before the process exits.
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    const ts = new Date().toISOString();
    console.error(`[${ts}] UNHANDLED REJECTION at:`, promise, '— reason:', reason);
});

// ─── Database ─────────────────────────────────────────────────────────────────

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('render.com')
        ? { rejectUnauthorized: false }
        : false,
});

async function initDB() {
    await pool.query(`
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
        CREATE TABLE IF NOT EXISTS test_results (
            id           SERIAL PRIMARY KEY,
            session_id   VARCHAR(100) UNIQUE NOT NULL,
            name         TEXT         NOT NULL DEFAULT '',
            slug         VARCHAR(80)  NOT NULL,
            answers      JSONB        NOT NULL DEFAULT '{}',
            scores       JSONB        NOT NULL DEFAULT '{}',
            stage        VARCHAR(20)  NOT NULL DEFAULT 'block1',
            last_active  TIMESTAMPTZ  NOT NULL DEFAULT now(),
            elective_variant_id INT
        );
        ALTER TABLE test_results ADD COLUMN IF NOT EXISTS elective_variant_id INT;
        CREATE INDEX IF NOT EXISTS idx_variants_subj ON variants (subj);
        CREATE INDEX IF NOT EXISTS idx_groups_slug   ON groups   (slug);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_results_session ON test_results (session_id);
    `);
    console.log('DB ready');
}

// ─── Scoring helpers ──────────────────────────────────────────────────────────

function scoreMatch(correct, given, pairs) {
    if (!given || typeof given !== 'object') return 0;
    let count = 0;
    for (const slot of Object.keys(correct)) {
        const g = given[slot] ?? given[String(slot)];
        if (g && g.toUpperCase() === correct[slot].toUpperCase()) count++;
    }
    // Returns number of correct pairs (1 point per pair)
    return count;
}

function checkTextCorrect(correct, given) {
    if (given == null || given === '') return false;
    const givenStrRaw = String(given).trim().replace(',', '.');
    const correctStr = String(correct).trim();

    if (givenStrRaw === correctStr) return true;

    const isNumeric = (s) => /^-?\d+(\.\d+)?$/.test(s);
    if (!isNumeric(givenStrRaw) || !isNumeric(correctStr)) return false;

    const gNum = Number(givenStrRaw);
    const cNum = Number(correctStr);

    const diff = Math.abs(gNum - cNum);
    const EPS = 1e-12;

    return diff < 1e-6 - EPS;
}

function scoreText(correct, given) {
    return checkTextCorrect(correct, given) ? 2 : 0;
}

function scoreDoubleText(correct, given) {
    if (!given || typeof given !== 'object') return 0;
    let pts = 0;
    for (const slot of Object.keys(correct)) {
        const g = given[slot] ?? given[String(slot)];
        if (checkTextCorrect(correct[slot], g)) pts++;
    }
    return pts;
}

function scoreTripleText(correct, given) {
    if (!given || typeof given !== 'object') return 0;
    let count = 0;
    for (const slot of Object.keys(correct)) {
        const g = given[slot] ?? given[String(slot)];
        if (checkTextCorrect(correct[slot], g)) count++;
    }
    return count;
}

// ─── Build question meta from a questions array (DB-driven) ───────────────────

function buildMetaFromQuestions(questions, subj) {
    const meta = {};
    for (const q of questions) {
        switch (q.type) {
            case 'radio':
                meta[q.id] = { subj, type: 'radio', pairs: 0 };
                break;
            case 'match':
                meta[q.id] = { subj, type: 'match', pairs: Array.isArray(q.pairs) ? q.pairs.length : 4 };
                break;
            case 'text':
                meta[q.id] = { subj, type: 'text', pairs: 0 };
                break;
            case 'double_text':
                meta[q.id] = { subj, type: 'double_text', pairs: 2 };
                break;
            case 'triple_text':
                meta[q.id] = { subj, type: 'triple_text', pairs: 3 };
                break;
            case 'cloze':
                // Register every sub-answer slot with the canonical sel- prefix
                (q.subIds || []).forEach(sid => {
                    meta['sel-' + sid] = { subj, type: 'cloze_sub', pairs: 0 };
                });
                break;
            default:
                meta[q.id] = { subj, type: q.type || 'radio', pairs: 0 };
        }
    }
    return meta;
}

// ─── Core scoring engine ──────────────────────────────────────────────────────
//
// Accepts raw client answers (cloze keys may arrive as either 'e17' or 'sel-e17';
// both are handled via the fallback lookup).

function computeScore(answers, answerKeys, questionMeta) {
    const scores = {};

    for (const [rawId, given] of Object.entries(answers)) {
        // Primary lookup (canonical key, e.g. 'sel-e17' or 'u1')
        let qId = rawId;
        let correct = answerKeys[qId];
        let info = questionMeta[qId];

        // Fallback: client sent plain cloze id 'e17' → try 'sel-e17'
        if (correct == null) {
            qId = 'sel-' + rawId;
            correct = answerKeys[qId];
            info = questionMeta[qId];
        }

        if (correct == null || !info) continue;

        const { subj, type, pairs } = info;
        let pts = 0;

        switch (type) {
            case 'radio':
                pts = String(given).toUpperCase() === String(correct).toUpperCase() ? 1 : 0;
                break;
            case 'match':
                pts = scoreMatch(correct, given, pairs);
                break;
            case 'text':
                pts = scoreText(correct, given);
                break;
            case 'double_text':
                pts = scoreDoubleText(correct, given);
                break;
            case 'triple_text':
                pts = scoreTripleText(correct, given);
                break;
            case 'cloze_sub':
                pts = String(given).toUpperCase() === String(correct).toUpperCase() ? 1 : 0;
                break;
        }

        if (pts > 0) scores[subj] = (scores[subj] || 0) + pts;
    }

    return scores;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Serve static assets from public/ (CSS, JS chunks, images)
app.use(express.static(path.join(__dirname, 'public')));
// Serve qdata JS files (browser-loaded question data)
app.use('/qdata', express.static(path.join(__dirname, 'qdata')));

// ─── Admin guard ──────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
    if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
}

// ─── Variant loader (used by multiple routes) ─────────────────────────────────

async function getVariant(id) {
    if (!id) return null;
    const r = await pool.query('SELECT * FROM variants WHERE id = $1', [id]);
    return r.rows[0] || null;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/group/:slug
// Returns full group config including questions for all subjects.
// Answer keys are NEVER sent to the client.
app.get('/api/group/:slug', async (req, res) => {
    try {
        const gr = await pool.query(
            'SELECT * FROM groups WHERE slug = $1',
            [req.params.slug],
        );
        if (!gr.rows.length) return res.status(404).json({ error: 'Group not found' });

        const g = gr.rows[0];

        const [subj1, subj2, subj3] = await Promise.all([
            getVariant(g.subj1_id),
            getVariant(g.subj2_id),
            getVariant(g.subj3_id),
        ]);

        // Load elective options in order (preserves ordering for the selector UI)
        const electiveOptions = [];
        for (const eid of (g.elective_ids || [])) {
            const v = await getVariant(eid);
            if (v) electiveOptions.push({
                id: v.id,
                subj: v.subj,
                title: v.title,
                questions: v.questions,  // questions included; answers omitted
            });
        }

        // Helper: strip answer key before sending
        const strip = v => v
            ? { id: v.id, subj: v.subj, title: v.title, questions: v.questions }
            : null;

        res.json({
            name: g.name,
            slug: g.slug,
            subj1: strip(subj1),
            subj2: strip(subj2),
            subj3: strip(subj3),
            electiveOptions,
        });
    } catch (err) {
        logError('GET /api/group/:slug', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/group/:slug/score
// Body: { answers: { [qId]: value }, electiveVariantId: number | null }
// Returns: { [subjId]: { score: number } }
// All subjects present in the group always appear in the response (score: 0 if
// no correct answers were given), so callers never need to handle missing keys.
app.post('/api/group/:slug/score', async (req, res) => {
    const answers = req.body?.answers ?? {};
    const electiveVariantId = parseInt(req.body?.electiveVariantId) || null;

    if (typeof answers !== 'object' || Array.isArray(answers)) {
        return res.status(400).json({ error: 'answers must be an object' });
    }

    try {
        const gr = await pool.query(
            'SELECT * FROM groups WHERE slug = $1',
            [req.params.slug],
        );
        if (!gr.rows.length) return res.status(404).json({ error: 'Group not found' });

        const g = gr.rows[0];

        // FIX: validate electiveVariantId belongs to this group before using it.
        // Previously any arbitrary id could be injected to score against a
        // variant not assigned to this group.
        if (electiveVariantId && !(g.elective_ids || []).includes(electiveVariantId)) {
            return res.status(400).json({ error: 'Invalid electiveVariantId' });
        }

        const ids = [g.subj1_id, g.subj2_id, g.subj3_id].filter(Boolean);
        if (electiveVariantId) ids.push(electiveVariantId);

        const result = {
            scores: {},
            details: {}
        };

        for (const vid of ids) {
            const v = await getVariant(vid);
            if (!v) continue;

            const variantMeta = buildMetaFromQuestions(v.questions, v.subj);
            
            // Filter and strip prefix for this specific variant
            const variantAnswers = {};
            const prefix = v.subj + '_';
            for (const [key, val] of Object.entries(answers)) {
                if (key.startsWith(prefix)) {
                    variantAnswers[key.replace(prefix, '')] = val;
                }
            }

            const variantScores = computeScore(variantAnswers, v.answers, variantMeta);

            result.scores[v.subj] = { score: variantScores[v.subj] ?? 0 };
            result.details[v.subj] = {
                questions: v.questions,
                correctAnswers: v.answers
            };
        }
        res.json(result);
    } catch (err) {
        logError('POST /api/group/:slug/score', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/results/report
// Body: { sessionId, name, slug, answers, stage, electiveVariantId, scores }
// Updates user progress and calculates current scores.
app.post('/api/results/report', async (req, res) => {
    const { sessionId, name, slug, answers, stage, electiveVariantId } = req.body || {};
    if (!sessionId || !slug) return res.status(400).json({ error: 'sessionId and slug are required' });

    try {
        const gr = await pool.query('SELECT * FROM groups WHERE slug = $1', [slug]);
        if (!gr.rows.length) return res.status(404).json({ error: 'Group not found' });
        const g = gr.rows[0];

        const ids = [g.subj1_id, g.subj2_id, g.subj3_id].filter(Boolean);
        if (electiveVariantId) ids.push(parseInt(electiveVariantId));

        let finalScores = req.body.scores;
        if (!finalScores || typeof finalScores !== 'object') {
            finalScores = {};
            for (const vid of ids) {
                const v = await getVariant(vid);
                if (!v) continue;
                const variantMeta = buildMetaFromQuestions(v.questions, v.subj);
                
                const variantAnswers = {};
                const prefix = v.subj + '_';
                for (const [key, val] of Object.entries(answers || {})) {
                    if (key.startsWith(prefix)) {
                        variantAnswers[key.replace(prefix, '')] = val;
                    }
                }

                const scoreRes = computeScore(variantAnswers, v.answers, variantMeta);
                finalScores[v.subj] = scoreRes[v.subj] ?? 0;
            }
        }

        await pool.query(
            `INSERT INTO test_results (session_id, name, slug, answers, scores, stage, last_active, elective_variant_id)
             VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
             ON CONFLICT (session_id)
             DO UPDATE SET name = $2, answers = $4, scores = $5, stage = $6, last_active = now(), elective_variant_id = $7`,
            [sessionId, name || '', slug, JSON.stringify(answers || {}), JSON.stringify(finalScores), stage || 'block1', electiveVariantId ? parseInt(electiveVariantId) : null]
        );

        res.json({ ok: true, scores: finalScores });
    } catch (err) {
        logError('POST /api/results/report', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/results - list all results
app.get('/api/admin/results', requireAdmin, async (req, res) => {
    try {
        const r = await pool.query(
            'SELECT id, session_id, name, slug, scores, stage, last_active FROM test_results ORDER BY last_active DESC'
        );
        res.json(r.rows);
    } catch (err) {
        logError('GET /api/admin/results', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/results/:id - detailed result with answer comparison
app.get('/api/admin/results/:id', requireAdmin, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM test_results WHERE id = $1', [parseInt(req.params.id)]);
        if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
        const result = r.rows[0];

        const gr = await pool.query('SELECT * FROM groups WHERE slug = $1', [result.slug]);
        if (!gr.rows.length) return res.json({ result, variants: [] });
        const g = gr.rows[0];

        // Only include the 3 fixed subjects + the student's chosen elective
        const ids = [g.subj1_id, g.subj2_id, g.subj3_id].filter(Boolean);
        if (result.elective_variant_id) {
            ids.push(result.elective_variant_id);
        } else {
            // Fallback: guess from scores — include elective whose subj appears in scores
            const studentSubjects = Object.keys(result.scores || {});
            for (const eid of (g.elective_ids || [])) {
                const v = await getVariant(eid);
                if (v && studentSubjects.includes(v.subj)) {
                    ids.push(eid);
                    break;
                }
            }
        }

        const variants = [];
        for (const vid of ids) {
            const v = await getVariant(vid);
            if (v) variants.push(v);
        }

        res.json({ result, variants });
    } catch (err) {
        logError('GET /api/admin/results/:id', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/admin/results/:id
app.delete('/api/admin/results/:id', requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM test_results WHERE id = $1', [parseInt(req.params.id)]);
        res.json({ ok: true });
    } catch (err) {
        logError('DELETE /api/admin/results/:id', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/variants  — list all (no questions/answers, lightweight)
app.get('/api/admin/variants', requireAdmin, async (req, res) => {
    try {
        const r = await pool.query(
            'SELECT id, subj, variant, title, created_at FROM variants ORDER BY subj, variant'
        );
        res.json(r.rows);
    } catch (err) {
        logError('GET /api/admin/variants', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/variants/:id  — single variant with full questions + answers
app.get('/api/admin/variants/:id', requireAdmin, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM variants WHERE id = $1', [parseInt(req.params.id)]);
        if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
        res.json(r.rows[0]);
    } catch (err) {
        logError('GET /api/admin/variants/:id', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/admin/variants/:id
// Body: { subj, variant, title, questions, answers }
app.put('/api/admin/variants/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    const { subj, variant, title, questions, answers } = req.body || {};
    if (!subj || !variant || !questions || !answers) {
        return res.status(400).json({ error: 'subj, variant, questions, answers are required' });
    }
    try {
        const r = await pool.query(
            `UPDATE variants
             SET subj = $1, variant = $2, title = $3, questions = $4, answers = $5
             WHERE id = $6
             RETURNING id`,
            [subj, variant, title || '', JSON.stringify(questions), JSON.stringify(answers), id],
        );
        if (!r.rows.length) return res.status(404).json({ error: 'Variant not found' });
        res.json({ id: r.rows[0].id });
    } catch (err) {
        logError('PUT /api/admin/variants/:id', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/admin/variants/:id
app.delete('/api/admin/variants/:id', requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM variants WHERE id = $1', [parseInt(req.params.id)]);
        res.json({ ok: true });
    } catch (err) {
        logError('DELETE /api/admin/variants/:id', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/groups  — list all groups
app.get('/api/admin/groups', requireAdmin, async (req, res) => {
    try {
        const r = await pool.query(
            'SELECT id, slug, name, subj1_id, subj2_id, subj3_id, elective_ids, created_at FROM groups ORDER BY created_at DESC'
        );
        res.json(r.rows);
    } catch (err) {
        logError('GET /api/admin/groups', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/groups/:id
app.get('/api/admin/groups/:id', requireAdmin, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM groups WHERE id = $1', [parseInt(req.params.id)]);
        if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
        res.json(r.rows[0]);
    } catch (err) {
        logError('GET /api/admin/groups/:id', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/admin/groups/:id
app.delete('/api/admin/groups/:id', requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM groups WHERE id = $1', [parseInt(req.params.id)]);
        res.json({ ok: true });
    } catch (err) {
        logError('DELETE /api/admin/groups/:id', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/variants
// Body: { subj, variant, title, questions, answers }
// Upserts on (subj, variant) unique key.
app.post('/api/admin/variants', requireAdmin, async (req, res) => {
    const { subj, variant, title, questions, answers } = req.body || {};
    if (!subj || !variant || !questions || !answers) {
        return res.status(400).json({ error: 'subj, variant, questions, answers are required' });
    }
    try {
        const r = await pool.query(
            `INSERT INTO variants (subj, variant, title, questions, answers)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (subj, variant)
             DO UPDATE SET title = $3, questions = $4, answers = $5
             RETURNING id`,
            [subj, variant, title || '', JSON.stringify(questions), JSON.stringify(answers)],
        );
        res.json({ id: r.rows[0].id });
    } catch (err) {
        logError('POST /api/admin/variants', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/groups
// Body: { slug, name, subj1_id, subj2_id, subj3_id, elective_ids }
// Upserts on slug unique key.
app.post('/api/admin/groups', requireAdmin, async (req, res) => {
    const { slug, name, subj1_id, subj2_id, subj3_id, elective_ids } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'slug is required' });
    try {
        const r = await pool.query(
            `INSERT INTO groups (slug, name, subj1_id, subj2_id, subj3_id, elective_ids)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (slug)
             DO UPDATE SET name = $2, subj1_id = $3, subj2_id = $4, subj3_id = $5, elective_ids = $6
             RETURNING id`,
            [slug, name || '', subj1_id || null, subj2_id || null, subj3_id || null, elective_ids || []],
        );
        res.json({ id: r.rows[0].id });
    } catch (err) {
        logError('POST /api/admin/groups', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── index.html catch-all ─────────────────────────────────────────────────────

app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.includes('.')) return next();
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
    initDB()
        .then(() => app.listen(PORT, () => console.log(`apishka listening on port ${PORT}`)))
        .catch(err => { logError('Fatal DB init error', err); process.exit(1); });
} else {
    initDB().catch(err => logError('DB init error', err));
}

// ─── Express catch-all error middleware ───────────────────────────────────────
// Catches any error passed via next(err) or thrown inside an async route that
// wasn't wrapped in its own try/catch.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    logError(`${req.method} ${req.path}`, err);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = {
    app,
    scoreMatch,
    scoreText,
    scoreDoubleText,
    scoreTripleText,
    buildMetaFromQuestions,
    computeScore,
};