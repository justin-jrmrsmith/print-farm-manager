// Unit tests for server/slot-match.js: which loaded head each tool of a multi-colour
// G-code goes to on a Snapmaker U1, and when the farm must refuse the printer instead.

const slotMatch = require('../slot-match');

const BLACK = '#000000';
const RED   = '#FF0000';

function slot(i, type, color, loaded = true) {
  return { slot: i, loaded, type, color };
}

describe('matchSlots', () => {
  test('remaps tools to whichever heads hold the right filament (the motivating case)', () => {
    // File: black PLA on tool 1 (T0), red PLA on tool 2 (T1).
    // Printer: red on head 1, empty head 2, black on head 3.
    const tools = [{ tool: 0, type: 'PLA', color: BLACK }, { tool: 1, type: 'PLA', color: RED }];
    const slots = [slot(0, 'PLA', '#E00000'), slot(1, null, null, false), slot(2, 'PLA', '#161616'), slot(3, null, null, false)];
    const r = slotMatch.matchSlots(tools, slots);
    expect(r.ok).toBe(true);
    expect(r.map).toEqual([[0, 2], [1, 0]]);
  });

  test('keeps the identity map when the heads already line up', () => {
    const tools = [{ tool: 0, type: 'PLA', color: BLACK }, { tool: 1, type: 'PLA', color: RED }];
    const slots = [slot(0, 'PLA', BLACK), slot(1, 'PLA', RED), slot(2, 'PLA', BLACK), slot(3, 'PLA', RED)];
    expect(slotMatch.matchSlots(tools, slots).map).toEqual([[0, 0], [1, 1]]);
  });

  test('prefers the closer colour when two heads both qualify', () => {
    const tools = [{ tool: 0, type: 'PLA', color: BLACK }];
    const slots = [slot(0, 'PLA', '#1A1A1A'), slot(1, 'PLA', '#050505')];
    expect(slotMatch.matchSlots(tools, slots).map).toEqual([[0, 1]]);
  });

  test('material type must match exactly (case-insensitive)', () => {
    const tools = [{ tool: 0, type: 'PLA', color: BLACK }];
    expect(slotMatch.matchSlots(tools, [slot(0, 'PETG', BLACK)]).ok).toBe(false);
    expect(slotMatch.matchSlots(tools, [slot(0, 'pla', BLACK)]).ok).toBe(true);
  });

  test('a colour outside tolerance is refused, and the reason names the tool', () => {
    const tools = [{ tool: 1, type: 'PLA', color: '#0000FF' }];
    const r = slotMatch.matchSlots(tools, [slot(0, 'PLA', '#000080')]); // navy is not blue
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/T1 PLA #0000FF/);
  });

  test('empty heads never match, even with a stale colour reading', () => {
    const tools = [{ tool: 0, type: 'PLA', color: BLACK }];
    expect(slotMatch.matchSlots(tools, [slot(0, 'PLA', BLACK, false)]).ok).toBe(false);
  });

  test('two tools cannot share one head', () => {
    const tools = [{ tool: 0, type: 'PLA', color: BLACK }, { tool: 1, type: 'PLA', color: '#101010' }];
    const r = slotMatch.matchSlots(tools, [slot(0, 'PLA', BLACK), slot(1, 'PLA', RED)]);
    expect(r.ok).toBe(false);
  });

  test('more tools than loaded heads is refused up front', () => {
    const tools = [0, 1, 2].map(t => ({ tool: t, type: 'PLA', color: BLACK }));
    const r = slotMatch.matchSlots(tools, [slot(0, 'PLA', BLACK), slot(1, 'PLA', BLACK)]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/needs 3 filaments/);
  });

  test('tolerance is adjustable', () => {
    const tools = [{ tool: 0, type: 'PLA', color: BLACK }];
    const slots = [slot(0, 'PLA', '#333333')]; // about 21 delta E away
    expect(slotMatch.matchSlots(tools, slots).ok).toBe(false);
    expect(slotMatch.matchSlots(tools, slots, 25).ok).toBe(true);
  });
});

describe('evaluate', () => {
  const tools = JSON.stringify([{ tool: 0, type: 'PLA', color: BLACK }]);
  const slots = JSON.stringify([slot(0, 'PLA', BLACK)]);

  test('does not apply when the file has no per-tool data', () => {
    expect(slotMatch.evaluate(null, { filament_slots: slots }).applies).toBe(false);
  });

  test('does not apply when the printer reports no slots (non-U1 printers)', () => {
    expect(slotMatch.evaluate(tools, { filament_slots: null }).applies).toBe(false);
  });

  test('a fresh reading matches', () => {
    const now = Date.now();
    const r = slotMatch.evaluate(tools, { filament_slots: slots, filament_slots_at: now - 5000 }, { now });
    expect(r).toMatchObject({ applies: true, ok: true, map: [[0, 0]] });
  });

  test('a stale reading is refused for dispatch', () => {
    const now = Date.now();
    const r = slotMatch.evaluate(tools, {
      filament_slots: slots, filament_slots_at: now - slotMatch.SLOT_DATA_MAX_AGE_MS - 1,
    }, { now });
    expect(r).toMatchObject({ applies: true, ok: false });
    expect(r.reason).toMatch(/out of date/);
  });

  test('without now (the schedule projection) age is not checked', () => {
    const r = slotMatch.evaluate(tools, { filament_slots: slots, filament_slots_at: 1 });
    expect(r.ok).toBe(true);
  });
});

describe('colorDistance', () => {
  test('near-identical blacks are close, black and dark grey are not', () => {
    expect(slotMatch.colorDistance('#000000', '#161616')).toBeLessThan(slotMatch.DEFAULT_COLOR_TOLERANCE);
    expect(slotMatch.colorDistance('#000000', '#333333')).toBeGreaterThan(slotMatch.DEFAULT_COLOR_TOLERANCE);
  });

  test('accepts RRGGBBAA without a hash, as the printer reports it', () => {
    expect(slotMatch.colorDistance('#FF0000', 'FF0000FF')).toBe(0);
  });

  test('unreadable colours never match', () => {
    expect(slotMatch.colorDistance('#FF0000', null)).toBe(Infinity);
  });
});
