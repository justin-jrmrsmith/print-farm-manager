// Scheduler dispatch against multi-head filament slots (Snapmaker U1).
//
// A multi-colour G-code goes only to a printer whose loaded heads hold every filament it
// needs, in any order, and the driver receives the tool-to-head map. A part that does not
// fit falls through to the next part, exactly like a part at its ceiling.

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const mockDriver = {
  uploadAndPrint: jest.fn(),
  checkIfPrinting: jest.fn(),
};
jest.mock('../drivers', () => ({ getDriver: jest.fn(() => mockDriver) }));
jest.mock('../notifications', () => ({ add: jest.fn() }));

const JobScheduler = require('../scheduler');
const { SLOT_DATA_MAX_AGE_MS } = require('../slot-match');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');
let gcodeFilename;
beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
  gcodeFilename = `slots_test_${Date.now()}.gcode`;
  fs.writeFileSync(path.join(GCODE_DIR, gcodeFilename), 'G28');
});
afterAll(() => {
  try { fs.unlinkSync(path.join(GCODE_DIR, gcodeFilename)); } catch (_) {}
});
beforeEach(() => {
  jest.clearAllMocks();
  mockDriver.uploadAndPrint.mockResolvedValue(undefined);
  mockDriver.checkIfPrinting.mockResolvedValue(false);
});

// Black PLA on tool 1, red PLA on tool 2.
const BLACK_RED = [
  { tool: 0, type: 'PLA', color: '#000000', grams: 3, mm: 1000 },
  { tool: 1, type: 'PLA', color: '#FF0000', grams: 1, mm: 300 },
];

function slots(...entries) {
  return entries.map((e, i) => (e
    ? { slot: i, loaded: true, type: e[0], color: e[1] }
    : { slot: i, loaded: false, type: null, color: null }));
}

function makeDb({ printerSlots, slotsAt = Date.now(), parts = [{ name: 'Multi', tools: BLACK_RED }] }) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, ip TEXT NOT NULL, api_key TEXT NOT NULL,
      model TEXT NOT NULL, type TEXT DEFAULT 'klipper',
      group_name TEXT, loaded_material TEXT, loaded_color TEXT,
      status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL, filament_slots TEXT, filament_slots_at INTEGER
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0, required_material TEXT, required_color TEXT,
      allowed_groups TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER DEFAULT 0,
      print_time_seconds INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, ams_slot INTEGER,
      allowed_groups TEXT, required_material TEXT, required_color TEXT,
      created_at INTEGER NOT NULL, tool_filaments TEXT
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_id INTEGER NOT NULL,
      gcode_id INTEGER, parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('dispatch_batch_size', '10');
  `);
  const now = Date.now();
  db.prepare(`INSERT INTO printers (name, ip, api_key, model, type, status, created_at, filament_slots, filament_slots_at)
              VALUES ('U1-A', '10.0.0.5', '', 'u1', 'klipper', 'IDLE', ?, ?, ?)`)
    .run(now, printerSlots ? JSON.stringify(printerSlots) : null, slotsAt);
  db.prepare(`INSERT INTO projects (name, status, priority, created_at, updated_at) VALUES ('Proj', 'active', 0, ?, ?)`).run(now, now);
  parts.forEach((p, i) => {
    db.prepare(`INSERT INTO parts (project_id, name, target_qty, status, sort_order, created_at, updated_at)
                VALUES (1, ?, 5, 'open', ?, ?, ?)`).run(p.name, i, now, now);
    db.prepare(`INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, tool_filaments, created_at)
                VALUES (?, 'u1', ?, ?, 1, ?, ?)`)
      .run(i + 1, gcodeFilename, gcodeFilename, p.tools ? JSON.stringify(p.tools) : null, now);
  });
  return db;
}

const printer = { id: 1, name: 'U1-A', ip: '10.0.0.5', api_key: '', model: 'u1', type: 'klipper', status: 'IDLE', is_held: 0, is_active: 1 };

describe('scheduler: multi-head filament slots', () => {
  test('dispatches with the remapped tool table when colours sit on other heads', async () => {
    // red on head 1, empty head 2, black on head 3
    const db = makeDb({ printerSlots: slots(['PLA', '#E00000'], null, ['PLA', '#141414'], null) });
    const jobId = await new JobScheduler(db, { on: () => {} })._dispatchToPrinter(printer);
    expect(jobId).not.toBeNull();
    const opts = mockDriver.uploadAndPrint.mock.calls[0][3];
    expect(opts.toolMap).toEqual([[0, 2], [1, 0]]);
    expect(opts.toolFilaments).toHaveLength(2);
  });

  test('does not dispatch when a needed colour is not loaded', async () => {
    const db = makeDb({ printerSlots: slots(['PLA', '#000000'], ['PLA', '#0000FF'], null, null) });
    const jobId = await new JobScheduler(db, { on: () => {} })._dispatchToPrinter(printer);
    expect(jobId).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n).toBe(0);
  });

  test('does not dispatch on a stale slot reading', async () => {
    const db = makeDb({
      printerSlots: slots(['PLA', '#000000'], ['PLA', '#FF0000'], null, null),
      slotsAt: Date.now() - SLOT_DATA_MAX_AGE_MS - 1000,
    });
    expect(await new JobScheduler(db, { on: () => {} })._dispatchToPrinter(printer)).toBeNull();
  });

  test('a part that does not fit falls through to the next part', async () => {
    const db = makeDb({
      printerSlots: slots(['PLA', '#000000'], null, null, null),
      parts: [{ name: 'Multi', tools: BLACK_RED }, { name: 'Black only', tools: [BLACK_RED[0]] }],
    });
    const jobId = await new JobScheduler(db, { on: () => {} })._dispatchToPrinter(printer);
    expect(jobId).not.toBeNull();
    expect(db.prepare('SELECT part_id FROM jobs WHERE id = ?').get(jobId).part_id).toBe(2);
    expect(mockDriver.uploadAndPrint.mock.calls[0][3].toolMap).toEqual([[0, 0]]);
  });

  test('files without per-tool data dispatch exactly as before, with no map', async () => {
    const db = makeDb({ printerSlots: slots(['PLA', '#000000'], null, null, null), parts: [{ name: 'Old', tools: null }] });
    expect(await new JobScheduler(db, { on: () => {} })._dispatchToPrinter(printer)).not.toBeNull();
    expect(mockDriver.uploadAndPrint.mock.calls[0][3].toolMap).toBeNull();
  });
});
