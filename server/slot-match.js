// Filament slot matching for multi-head printers (Snapmaker U1).
//
// A multi-colour G-code assumes a filament on each logical tool (T0, T1, ...). A U1 has
// four physical heads, each loaded with whatever the operator put there. The firmware
// keeps a logical-to-physical table (print_task_config.extruder_map_table) and applies it
// to every tool change, temperature command and Snapmaker macro, so the same file can
// print on any U1 whose heads hold the right filaments in any order, as long as the farm
// supplies the table when it starts the print. This module answers, for one G-code and
// one printer: can it print here, and with which table?
//
// Pure functions, no DB access. Three callers must agree, so they all call this:
// the scheduler (dispatch), server/projection.js (schedule) and routes/parts.js
// (dispatch-status diagnostics).

// How old a printer's slot reading may be and still be trusted for dispatch. Must exceed
// the 15 s poll interval with room for a slow poll or two; anything older means the farm
// has lost sight of the printer and an operator may have swapped spools since.
const SLOT_DATA_MAX_AGE_MS = 60 * 1000;

// Default colour tolerance as a CIE76 delta E. About 2 is the smallest difference a
// person notices side by side; slicer swatches and printer readings for "the same black"
// are routinely 5 to 10 apart (#000000 vs #161616 is about 8), while black vs dark grey
// #333333 is about 21 and blue vs navy is over 40. Overridable per farm through the
// filament_color_tolerance setting.
const DEFAULT_COLOR_TOLERANCE = 15;

function parseJson(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// "#RRGGBB" or "RRGGBB" (extra alpha digits ignored) to [r, g, b], or null.
function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const m = hex.trim().replace(/^#/, '').match(/^([0-9a-f]{6})/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// sRGB (D65) to CIELAB.
function rgbToLab([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// CIE76 delta E between two hex colours, or Infinity when either is unreadable.
function colorDistance(hexA, hexB) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  if (!a || !b) return Infinity;
  const [l1, a1, b1] = rgbToLab(a);
  const [l2, a2, b2] = rgbToLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

function sameType(a, b) {
  return typeof a === 'string' && typeof b === 'string' &&
    a.trim().toUpperCase() === b.trim().toUpperCase();
}

// Does this G-code/printer pair need slot matching at all? Only when the file declares
// per-tool filament AND the printer reports per-slot filament. Everything else (Prusa,
// Bambu, Elegoo, a non-U1 Klipper, a file uploaded before this feature) keeps the plain
// material/colour targeting unchanged.
function needsSlotMatch(toolFilamentsRaw, printer) {
  return !!(parseJson(toolFilamentsRaw) && parseJson(printer && printer.filament_slots));
}

// Find the best physical slot for every used tool.
//
//   tools: [{ tool, type, color }]   from gcodes.tool_filaments
//   slots: [{ slot, loaded, type, color }]   from printers.filament_slots
//
// Returns { ok: true, map: [[tool, slot], ...], distances } or { ok: false, reason }.
// Every used tool must land on a different loaded slot with the same material type and
// a colour within tolerance. Among valid assignments the one with the smallest total
// colour distance wins, ties going to the assignment that moves the fewest tools. Four
// heads means at most 24 assignments, so all of them are checked.
function matchSlots(tools, slots, tolerance = DEFAULT_COLOR_TOLERANCE) {
  if (!Array.isArray(tools) || tools.length === 0) return { ok: false, reason: 'G-code lists no tools' };
  if (!Array.isArray(slots) || slots.length === 0) return { ok: false, reason: 'printer reports no filament slots' };

  const usable = slots.filter(s => s && s.loaded && s.type && Number.isInteger(s.slot));
  if (tools.length > usable.length) {
    return { ok: false, reason: `needs ${tools.length} filaments, printer has ${usable.length} loaded` };
  }

  // Candidate slots for each tool, with distances.
  const options = tools.map(t => usable
    .filter(s => sameType(t.type, s.type))
    .map(s => ({ slot: s.slot, dist: colorDistance(t.color, s.color) }))
    .filter(o => o.dist <= tolerance));

  const missing = tools.filter((_, i) => options[i].length === 0);
  if (missing.length > 0) {
    const desc = missing.map(t => `T${t.tool} ${t.type} ${t.color}`).join(', ');
    return { ok: false, reason: `no loaded slot matches ${desc}` };
  }

  let best = null;
  const chosen = [];
  const used = new Set();
  (function search(i, total, moved) {
    if (i === tools.length) {
      if (!best || total < best.total - 1e-9 || (Math.abs(total - best.total) <= 1e-9 && moved < best.moved)) {
        best = { total, moved, picks: [...chosen] };
      }
      return;
    }
    for (const o of options[i]) {
      if (used.has(o.slot)) continue;
      used.add(o.slot);
      chosen.push(o);
      search(i + 1, total + o.dist, moved + (o.slot === tools[i].tool ? 0 : 1));
      chosen.pop();
      used.delete(o.slot);
    }
  })(0, 0, 0);

  if (!best) return { ok: false, reason: 'filaments are loaded but two tools would need the same slot' };
  return {
    ok: true,
    map: tools.map((t, i) => [t.tool, best.picks[i].slot]),
    distances: best.picks.map(p => Math.round(p.dist * 10) / 10),
  };
}

// The one entry point the three callers use. Returns:
//   { applies: false }                              plain targeting rules only
//   { applies: true, ok: true, map }                dispatch with this tool map
//   { applies: true, ok: false, reason }            do not dispatch here
// opts.now enables the freshness check (dispatch passes it, the projection does not:
// a schedule is a forecast and should not blank out because one poll was slow).
function evaluate(toolFilamentsRaw, printer, opts = {}) {
  const tools = parseJson(toolFilamentsRaw);
  const slots = parseJson(printer && printer.filament_slots);
  if (!tools || !slots) return { applies: false };

  if (opts.now != null) {
    const at = printer.filament_slots_at;
    if (!at || opts.now - at > SLOT_DATA_MAX_AGE_MS) {
      return { applies: true, ok: false, reason: 'filament slot reading is out of date' };
    }
  }
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : DEFAULT_COLOR_TOLERANCE;
  return { applies: true, ...matchSlots(tools, slots, tolerance) };
}

// Read the farm's tolerance setting, falling back to the default on anything unusable.
function readTolerance(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'filament_color_tolerance'").get();
    const n = row ? parseFloat(row.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_COLOR_TOLERANCE;
  } catch (_) {
    return DEFAULT_COLOR_TOLERANCE;
  }
}

module.exports = {
  evaluate,
  matchSlots,
  needsSlotMatch,
  colorDistance,
  readTolerance,
  SLOT_DATA_MAX_AGE_MS,
  DEFAULT_COLOR_TOLERANCE,
};
