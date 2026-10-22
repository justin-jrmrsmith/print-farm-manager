const express = require('express');
const router = express.Router();

const ALLOWED_KEYS = new Set(['dispatch_batch_size', 'farm_name', 'filament_color_tolerance']);

module.exports = (db) => {
  // GET /api/settings — returns all settings as { key: value, ... }
  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const result = {};
    rows.forEach(r => { result[r.key] = r.value; });
    res.json(result);
  });

  // PUT /api/settings/:key — update a single setting value
  router.put('/:key', (req, res) => {
    const { key } = req.params;
    if (!ALLOWED_KEYS.has(key)) {
      return res.status(400).json({ error: `Unknown setting key: ${key}` });
    }
    const { value } = req.body;
    if (value === undefined || value === null || String(value).trim() === '') {
      return res.status(400).json({ error: 'value is required' });
    }

    if (key === 'dispatch_batch_size') {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1 || n > 100) {
        return res.status(400).json({ error: 'dispatch_batch_size must be an integer between 1 and 100' });
      }
    }

    // Colour match tolerance for multi-head filament slots, as a CIE76 delta E (see
    // server/slot-match.js). Below 1 nothing but an exact reading matches; above 50 blue
    // would match navy.
    if (key === 'filament_color_tolerance') {
      const n = parseFloat(value);
      if (!Number.isFinite(n) || n < 1 || n > 50) {
        return res.status(400).json({ error: 'filament_color_tolerance must be a number between 1 and 50' });
      }
    }

    if (key === 'farm_name' && String(value).trim().length > 40) {
      return res.status(400).json({ error: 'farm_name must be 40 characters or fewer' });
    }

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
    res.json({ key, value: String(value) });
  });

  return router;
};
