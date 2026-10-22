// Unit tests for server/drivers/klipper.js
// All network calls are mocked — no real printers needed.

jest.mock('axios');
const axios = require('axios');

const path   = require('path');
const fs     = require('fs');
const klipper = require('../drivers/klipper');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

const fakePrinter = { id: 1, name: 'Voron_01', ip: '192.168.1.250', model: 'voron-24', type: 'klipper' };

const filesToClean = [];

beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
});

afterAll(() => {
  for (const p of filesToClean) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
});

afterEach(() => {
  jest.clearAllMocks();
});

function createTestFile(filename) {
  const filePath = path.join(GCODE_DIR, filename);
  fs.writeFileSync(filePath, '; fake gcode');
  filesToClean.push(filePath);
  return filePath;
}

function moonrakerResponse(printState, vsdProgress = 0, elapsed = 0, webhookState = 'ready') {
  return {
    data: {
      result: {
        status: {
          print_stats: {
            state: printState,
            print_duration: elapsed,
            filename: printState !== 'standby' ? 'test.gcode' : '',
          },
          virtual_sdcard: { progress: vsdProgress },
          webhooks: { state: webhookState },
        },
      },
    },
  };
}

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('getStatus', () => {
  test('returns IDLE when Moonraker state is standby', async () => {
    axios.get.mockResolvedValueOnce(moonrakerResponse('standby'));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('IDLE');
    expect(result.progress).toBeNull();
    expect(result.timeRemaining).toBeNull();
  });

  test('returns PRINTING with progress when printing and past 2% threshold', async () => {
    axios.get.mockResolvedValueOnce(moonrakerResponse('printing', 0.5, 600));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('PRINTING');
    expect(result.progress).toBe(50);
    expect(result.timeRemaining).toBe(600); // 600s elapsed at 50% → 600s remaining
    expect(result.currentFile).toBe('test.gcode');
  });

  test('returns PRINTING with null timeRemaining when progress is below 2% threshold', async () => {
    axios.get.mockResolvedValueOnce(moonrakerResponse('printing', 0.01, 30));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('PRINTING');
    expect(result.progress).toBe(1);
    expect(result.timeRemaining).toBeNull();
  });

  test('returns PAUSED with progress', async () => {
    axios.get.mockResolvedValueOnce(moonrakerResponse('paused', 0.3, 300));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('PAUSED');
    expect(result.progress).toBe(30);
  });

  test('returns FINISHED when Moonraker state is complete', async () => {
    axios.get.mockResolvedValueOnce(moonrakerResponse('complete'));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('FINISHED');
    expect(result.progress).toBeNull();
    expect(result.timeRemaining).toBeNull();
  });

  test('returns ERROR when Moonraker state is error', async () => {
    axios.get.mockResolvedValueOnce(moonrakerResponse('error'));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('ERROR');
  });

  test('returns STOPPED when Moonraker state is cancelled', async () => {
    axios.get.mockResolvedValueOnce(moonrakerResponse('cancelled'));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('STOPPED');
  });

  test('returns OFFLINE when webhooks.state is not ready (e.g. startup)', async () => {
    axios.get.mockResolvedValueOnce(moonrakerResponse('standby', 0, 0, 'startup'));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('OFFLINE');
  });

  test('returns OFFLINE on network error', async () => {
    axios.get.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('OFFLINE');
    expect(result.progress).toBeNull();
  });

  test('returns UNKNOWN for an unrecognised Moonraker state', async () => {
    axios.get.mockResolvedValueOnce(moonrakerResponse('some_future_state'));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('UNKNOWN');
  });

  test('queries correct Moonraker URL on port 7125 with required object params', async () => {
    axios.get.mockResolvedValueOnce(moonrakerResponse('standby'));
    await klipper.getStatus(fakePrinter);
    expect(axios.get).toHaveBeenCalledWith(
      'http://192.168.1.250:7125/printer/objects/query',
      expect.objectContaining({
        params: { print_stats: '', virtual_sdcard: '', webhooks: '' },
      })
    );
  });

  test('strips http:// prefix from ip field when building URL', async () => {
    const messyPrinter = { ...fakePrinter, ip: 'http://192.168.1.250/' };
    axios.get.mockResolvedValueOnce(moonrakerResponse('standby'));
    await klipper.getStatus(messyPrinter);
    expect(axios.get).toHaveBeenCalledWith(
      'http://192.168.1.250:7125/printer/objects/query',
      expect.anything()
    );
  });
});

// ─── uploadAndPrint ───────────────────────────────────────────────────────────

describe('uploadAndPrint', () => {
  test('POSTs to /server/files/upload with print=true as a form field', async () => {
    const filename = `klipper_upload_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    axios.post.mockResolvedValueOnce({});

    const FormData = require('form-data');
    const appendSpy = jest.spyOn(FormData.prototype, 'append');

    await klipper.uploadAndPrint(fakePrinter, fullPath, filename);

    const [url, , config] = axios.post.mock.calls[0];
    expect(url).toBe('http://192.168.1.250:7125/server/files/upload');

    // print must be a form field — query params are silently ignored by Moonraker
    const appendedFields = appendSpy.mock.calls.map(([name, value]) => ({ name, value }));
    expect(appendedFields).toContainEqual({ name: 'print', value: 'true' });
    expect(config?.params?.print).toBeUndefined();

    appendSpy.mockRestore();
  });

  test('throws when upload fails', async () => {
    const filename = `klipper_fail_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    axios.post.mockRejectedValueOnce(new Error('Request failed with status code 405'));

    await expect(klipper.uploadAndPrint(fakePrinter, fullPath, filename))
      .rejects.toThrow('405');
  });
});

// ─── Snapmaker U1 filament slots and mapped start ──────────────────────────────

describe('U1 filament slots', () => {
  // print_task_config shape from Snapmaker u1-klipper print_task_config.py.
  const ptc = {
    filament_exist:       [true, false, true, true],
    filament_type:        ['PLA', 'NONE', 'PLA', 'PETG'],
    filament_vendor:      ['Generic', 'NONE', 'Snapmaker', 'Generic'],
    filament_sub_type:    ['Basic', 'NONE', 'Matte', 'NONE'],
    filament_color_rgba:  ['FF0000FF', 'FFFFFFFF', '161616FF', '000000FF'],
    filament_color_multi: [{}, {}, { nums: 2, colors: ['00FF00', '0000FF'] }, {}],
  };

  test('getStatus queries print_task_config and returns per-head filament', async () => {
    const res = moonrakerResponse('standby');
    res.data.result.status.print_task_config = ptc;
    axios.get.mockResolvedValueOnce(res);

    const result = await klipper.getStatus(fakePrinter);
    expect(axios.get.mock.calls[0][1].params.print_task_config).toMatch(/filament_type/);
    expect(result.filamentSlots).toEqual([
      { slot: 0, loaded: true,  type: 'PLA',  color: '#FF0000', vendor: 'Generic',   subtype: 'Basic' },
      { slot: 1, loaded: false, type: null,   color: '#FFFFFF', vendor: null,        subtype: null },
      // a multi-colour spool reads as its first colour
      { slot: 2, loaded: true,  type: 'PLA',  color: '#00FF00', vendor: 'Snapmaker', subtype: 'Matte' },
      { slot: 3, loaded: true,  type: 'PETG', color: '#000000', vendor: 'Generic',   subtype: null },
    ]);
  });

  test('printers without print_task_config report no slots', async () => {
    axios.get.mockResolvedValueOnce(moonrakerResponse('standby'));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.filamentSlots).toBeUndefined();
  });

  test('a mapped print uploads without print=true, then starts with MAP_TABLE', async () => {
    const filename = `klipper_mapped_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    axios.post
      .mockResolvedValueOnce({ data: { item: { path: filename, root: 'gcodes' } } })
      .mockResolvedValueOnce({ data: { result: 'ok' } });
    const FormData = require('form-data');
    const appendSpy = jest.spyOn(FormData.prototype, 'append');

    await klipper.uploadAndPrint(fakePrinter, fullPath, filename, {
      toolMap: [[0, 2], [1, 0]],
      toolFilaments: [
        { tool: 0, type: 'PLA', color: '#000000', grams: 3.24, mm: 1085.19 },
        { tool: 1, type: 'PLA', color: '#FF0000', grams: 1.44, mm: 484.34 },
      ],
    });

    const fields = appendSpy.mock.calls.map(([name, value]) => ({ name, value }));
    expect(fields).toContainEqual({ name: 'print', value: 'false' });
    appendSpy.mockRestore();

    const [url, body] = axios.post.mock.calls[1];
    expect(url).toBe('http://192.168.1.250:7125/printer/gcode/script');
    expect(body.script).toBe(
      `SDCARD_PRINT_FILE_WITH_PARAMETERS FILENAME="${filename}" MAP_TABLE="[[0,2],[1,0]]" ` +
      'FILAMENT_USED_G="[3.24,1.44]" FILAMENT_USED_MM="[1085.19,484.34]"'
    );
  });

  test('usage lists keep zeros for unused tools so indices line up', () => {
    const script = klipper.buildMappedStartScript('a.gcode', [[0, 1], [2, 3]], [
      { tool: 0, grams: 1, mm: 10 }, { tool: 2, grams: 2, mm: 20 },
    ]);
    expect(script).toContain('FILAMENT_USED_G="[1,0,2]"');
    expect(script).toContain('MAP_TABLE="[[0,1],[2,3]]"');
  });

  test('a filename Klipper cannot quote is uploaded under a safe name', async () => {
    const fullPath = createTestFile(`klipper_quote_${Date.now()}.gcode`);
    axios.post.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    await klipper.uploadAndPrint(fakePrinter, fullPath, 'cube "v2"; final.gcode', { toolMap: [[0, 0]] });
    expect(axios.post.mock.calls[1][1].script).toContain('FILENAME="cube _v2__ final.gcode"');
  });

  test('a failed start is reported so the scheduler retries or holds', async () => {
    const fullPath = createTestFile(`klipper_startfail_${Date.now()}.gcode`);
    axios.post.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Request failed with status code 400'));
    await expect(klipper.uploadAndPrint(fakePrinter, fullPath, 'x.gcode', { toolMap: [[0, 1]] }))
      .rejects.toThrow('400');
  });
});

// ─── checkIfPrinting ─────────────────────────────────────────────────────────

describe('checkIfPrinting', () => {
  test('returns true when Moonraker state is printing', async () => {
    axios.get.mockResolvedValueOnce(moonrakerResponse('printing', 0.5, 300));
    expect(await klipper.checkIfPrinting(fakePrinter)).toBe(true);
  });

  test('returns true when Moonraker state is paused', async () => {
    axios.get.mockResolvedValueOnce(moonrakerResponse('paused', 0.5, 300));
    expect(await klipper.checkIfPrinting(fakePrinter)).toBe(true);
  });

  test('returns false when Moonraker state is standby', async () => {
    axios.get.mockResolvedValueOnce(moonrakerResponse('standby'));
    expect(await klipper.checkIfPrinting(fakePrinter)).toBe(false);
  });

  test('returns false when printer is unreachable', async () => {
    axios.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await klipper.checkIfPrinting(fakePrinter)).toBe(false);
  });
});

// ─── Driver registry ──────────────────────────────────────────────────────────

describe('driver registry', () => {
  const { getDriver } = require('../drivers');

  test('getDriver("klipper") returns the klipper driver', () => {
    const driver = getDriver('klipper');
    expect(typeof driver.getStatus).toBe('function');
    expect(typeof driver.uploadAndPrint).toBe('function');
    expect(typeof driver.cancelJob).toBe('function');
    expect(typeof driver.checkIfPrinting).toBe('function');
  });
});
