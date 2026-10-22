// Klipper driver — Moonraker REST API (HTTP polling, port 7125)
// Implements the shared driver interface: getStatus, uploadAndPrint, cancelJob, checkIfPrinting
//
// Moonraker is the standard API layer for Klipper firmware (Voron, etc.).
// All communication is plain HTTP — no persistent connection, no auth required on LAN.
// Upload: POST multipart to /server/files/upload with print=true — starts immediately.

const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const PORT = 7125;

function base(printer) {
  // Strip any accidental protocol prefix or trailing slashes — field expects bare IP.
  const ip = printer.ip.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `http://${ip}:${PORT}`;
}

// ─── Filament slots (Snapmaker U1) ──────────────────────────────────────────
//
// The U1's Klipper exposes a print_task_config object with one entry per physical head
// (four). Field names come from Snapmaker's published firmware source,
// github.com/Snapmaker/u1-klipper klippy/extras/print_task_config.py (DEFAULT_PRINT_TASK_CONFIG),
// and are the same fields the paxx12 firmware's filament page reads and edits
// (SET_PRINT_FILAMENT_CONFIG): filament_exist, filament_type, filament_vendor,
// filament_sub_type, filament_color_rgba ("RRGGBBAA") and filament_color_multi
// ({ nums, colors: ["RRGGBB", ...] }, set when a spool has more than one colour).
// An unset type reads 'NONE'. Klipper omits objects that do not exist from a query
// result, so on any other Klipper printer this simply yields no slots.
const SLOT_FIELDS = 'filament_exist,filament_type,filament_vendor,filament_sub_type,filament_color_rgba,filament_color_multi';

// print_task_config status to [{ slot, loaded, type, color, vendor, subtype }], or
// undefined when the object is absent or malformed.
function parseFilamentSlots(ptc) {
  if (!ptc || !Array.isArray(ptc.filament_type)) return undefined;
  const clean = (v) => (typeof v === 'string' && v.trim() && v.trim().toUpperCase() !== 'NONE' ? v.trim() : null);
  return ptc.filament_type.map((rawType, i) => {
    const multi = Array.isArray(ptc.filament_color_multi) ? ptc.filament_color_multi[i] : null;
    const rgba  = Array.isArray(ptc.filament_color_rgba) ? ptc.filament_color_rgba[i] : null;
    let hex = null;
    if (multi && multi.nums > 0 && Array.isArray(multi.colors) && typeof multi.colors[0] === 'string') {
      hex = multi.colors[0];
    } else if (typeof rgba === 'string' && rgba.length >= 6) {
      hex = rgba.substring(0, 6);
    }
    const color = hex && /^[0-9a-f]{6}$/i.test(hex) ? '#' + hex.toUpperCase() : null;
    const type = clean(rawType);
    const exists = Array.isArray(ptc.filament_exist) ? !!ptc.filament_exist[i] : false;
    return {
      slot: i,
      loaded: exists && !!type && !!color,
      type,
      color,
      vendor: clean(Array.isArray(ptc.filament_vendor) ? ptc.filament_vendor[i] : null),
      subtype: clean(Array.isArray(ptc.filament_sub_type) ? ptc.filament_sub_type[i] : null),
    };
  });
}

// ─── Status ─────────────────────────────────────────────────────────────────

// Moonraker print_stats.state → canonical status
const STATE_MAP = {
  standby:   'IDLE',
  printing:  'PRINTING',
  paused:    'PAUSED',
  complete:  'FINISHED',
  error:     'ERROR',
  cancelled: 'STOPPED',
};

async function getStatus(printer) {
  try {
    const res = await axios.get(
      `${base(printer)}/printer/objects/query`,
      {
        params: { print_stats: '', virtual_sdcard: '', webhooks: '', print_task_config: SLOT_FIELDS },
        timeout: 8000,
      }
    );

    const stats  = res.data?.result?.status?.print_stats  || {};
    const vsd    = res.data?.result?.status?.virtual_sdcard || {};
    const hooks  = res.data?.result?.status?.webhooks || {};
    const filamentSlots = parseFilamentSlots(res.data?.result?.status?.print_task_config);

    // If Klipper itself is not ready (startup, shutdown, error), report offline.
    if (hooks.state && hooks.state !== 'ready') {
      return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
    }

    const status = STATE_MAP[stats.state] || 'UNKNOWN';

    let progress    = null;
    let timeRemaining = null;
    let currentFile = null;

    if (status === 'PRINTING' || status === 'PAUSED') {
      const pct = vsd.progress ?? null;
      if (pct != null) progress = Math.round(pct * 100);

      // Estimate time remaining from elapsed print time and file progress.
      // Only meaningful once a few percent in — avoid div-by-zero and wildly
      // inaccurate early estimates.
      const elapsed = stats.print_duration ?? 0;
      if (pct != null && pct > 0.02 && elapsed > 0) {
        timeRemaining = Math.round(elapsed * (1 - pct) / pct);
      }

      if (stats.filename) {
        currentFile = stats.filename;
      }
    }

    const out = { status, progress, timeRemaining, currentFile };
    // Only present on printers that report per-head filament (Snapmaker U1). The poller
    // stores it for server/slot-match.js; absent means "keep the last reading".
    if (filamentSlots) out.filamentSlots = filamentSlots;
    return out;
  } catch (_) {
    return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
  }
}

// ─── Upload & Print ──────────────────────────────────────────────────────────

// Uploads the G-code file to Moonraker's gcodes directory, then triggers a print.
// Moonraker deduplicates by filename — uploading a file that already exists
// overwrites it silently, so no pre-delete step is needed.
//
// options.toolMap ([[tool, head], ...], from server/slot-match.js) is set only for a
// Snapmaker U1 whose loaded heads were matched to a multi-colour file. Then the file is
// uploaded without print=true and started with the firmware's own parameterised start,
// the same command Moonraker issues for a slicer "send and print"
// (Snapmaker u1-moonraker klippy_apis.py start_print_advanced):
//
//   SDCARD_PRINT_FILE_WITH_PARAMETERS FILENAME="x.gcode" MAP_TABLE="[[0,2],[1,0]]"
//     FILAMENT_USED_G="[3.24,1.44]" FILAMENT_USED_MM="[1085.19,484.34]"
//
// The firmware (u1-klipper print_task_config.py, cmd_SET_PRINT_TASK_PARAMETERS) resets
// the logical-to-physical table, applies MAP_TABLE (parsed with ast.literal_eval), marks
// the used heads from the FILAMENT_USED lists, and then every T, M104/M109 T and
// SM_PRINT_PREEXTRUDE_FILAMENT in the file is redirected to the mapped head. The G-code
// itself is never edited. The table is cleared when the print finishes.
async function uploadAndPrint(printer, gcodeFullPath, filename, options = {}) {
  const toolMap = Array.isArray(options.toolMap) && options.toolMap.length > 0 ? options.toolMap : null;

  // Klipper's command parser ends the argument list at ; # or * and has no escape for a
  // quote inside a quoted value, so a mapped print uploads under a name that is safe to
  // quote. Unmapped uploads keep their name exactly as before.
  const uploadName = toolMap ? filename.replace(/[;#*"'\\]/g, '_') : filename;

  const form = new FormData();
  form.append('file', fs.createReadStream(gcodeFullPath), { filename: uploadName });
  // Must be a form field, not a query param. Mapped prints are started separately below.
  form.append('print', toolMap ? 'false' : 'true');

  const res = await axios.post(
    `${base(printer)}/server/files/upload`,
    form,
    {
      headers: form.getHeaders(),
      timeout: 300000, // 5 minutes for large files
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }
  );
  if (!toolMap) return;

  const storedPath = res?.data?.item?.path || res?.data?.result?.item?.path || uploadName;
  await axios.post(
    `${base(printer)}/printer/gcode/script`,
    { script: buildMappedStartScript(storedPath, toolMap, options.toolFilaments) },
    { timeout: 60000 }
  );
}

// The parameterised start command for a mapped print. Exported for tests.
function buildMappedStartScript(storedPath, toolMap, toolFilaments) {
  const pairs = toolMap.map(([t, h]) => `[${parseInt(t, 10)},${parseInt(h, 10)}]`).join(',');
  let script = `SDCARD_PRINT_FILE_WITH_PARAMETERS FILENAME="${storedPath}" MAP_TABLE="[${pairs}]"`;

  // Usage lists are indexed by logical tool, zeros for unused tools, as the slicer writes
  // them. Without them the firmware treats every head as unused and skips the per-head
  // pre-extrusion the file asks for.
  if (Array.isArray(toolFilaments) && toolFilaments.length > 0) {
    const width = Math.max(...toolFilaments.map(t => t.tool)) + 1;
    const grams = new Array(width).fill(0);
    const mm = new Array(width).fill(0);
    for (const t of toolFilaments) {
      grams[t.tool] = Number(t.grams) || 0;
      mm[t.tool] = Number(t.mm) || 0;
    }
    script += ` FILAMENT_USED_G="[${grams.join(',')}]" FILAMENT_USED_MM="[${mm.join(',')}]"`;
  }
  return script;
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

async function cancelJob(printer) {
  try {
    await axios.post(`${base(printer)}/printer/print/cancel`, null, { timeout: 10000 });
  } catch (err) {
    console.warn(`[klipper] Cancel failed for ${printer.name}: ${err.message}`);
  }
}

// ─── Check if printing ────────────────────────────────────────────────────────

async function checkIfPrinting(printer) {
  try {
    const { status } = await getStatus(printer);
    return status === 'PRINTING' || status === 'PAUSED';
  } catch (_) {
    return false;
  }
}

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting, buildMappedStartScript, parseFilamentSlots };
