# Filament Library

Administrator-managed canonical lists of filament types and filament colors. These lists are the single source of truth for what materials and colors exist in the farm — printers and G-codes select from them rather than entering free text.

## Tables

### `filament_types`

| Column | Type    | Notes |
|--------|---------|-------|
| `id`   | INTEGER | PK, autoincrement |
| `name` | TEXT    | Unique, e.g. "PLA", "PETG", "ASA" |

### `filament_colors`

| Column      | Type    | Notes |
|-------------|---------|-------|
| `id`        | INTEGER | PK, autoincrement |
| `type_id`   | INTEGER | FK → `filament_types.id` (NOT NULL). A color belongs to exactly one type. |
| `name`      | TEXT    | Unique per type, e.g. "Black", "Galaxy Red". `UNIQUE(type_id, name)`. |
| `hex_color` | TEXT    | Optional hex code, e.g. "#FF0000". Shown as a color swatch in the Settings table. |

## API Endpoints — `server/routes/filaments.js`

All endpoints are mounted at `/api/filaments`.

### `GET /api/filaments/types`
Returns all filament types ordered by name.
```json
[{ "id": 1, "name": "PLA" }, { "id": 2, "name": "PETG" }]
```

### `POST /api/filaments/types`
Add a new filament type.
- Body: `{ "name": "ASA" }`
- Returns: the created row (201)
- Errors: 400 if name missing, 409 if name already exists

### `DELETE /api/filaments/types/:id`
Remove a filament type by ID.
- No foreign-key block — deleting a type does not clear printers or G-codes that reference it by name. The stored name string remains; the operator resolves via the printer/gcode form on next edit.
- Returns 404 if not found.

### `GET /api/filaments/colors`
Returns all filament colors ordered by name.
```json
[{ "id": 1, "name": "Black", "hex_color": "#000000" }, { "id": 2, "name": "Galaxy Red", "hex_color": null }]
```

### `POST /api/filaments/colors`
Add a new filament color.
- Body: `{ "type_id": 1, "name": "Galaxy Red", "hex_color": "#C0392B" }` — `hex_color` is optional; `type_id` is required.
- Returns: the created row with `type_name` included (201)
- Errors: 400 if name or type_id missing / type not found, 409 if name already exists for that type

### `DELETE /api/filaments/colors/:id`
Remove a filament color by ID. Same non-blocking behavior as type deletion.

## Where filament data is used

| Location | Field | Meaning |
|----------|-------|---------|
| `printers.loaded_material` | type name | What material is currently loaded on the printer |
| `printers.loaded_color` | color name | What color is currently loaded on the printer |
| `gcodes.required_material` | type name | Material required to print this G-code |
| `gcodes.required_color` | color name | Color required to print this G-code |
| `gcodes.tool_filaments` | JSON per tool | Filament each tool of a multi-colour file needs (read from the file) |
| `printers.filament_slots` | JSON per head | Filament each head of a Snapmaker U1 holds (read from the printer) |

The scheduler uses `required_material` and `required_color` to match G-codes to printers with matching `loaded_material` / `loaded_color`.

For multi-head printers, see [Multi-head printers (Snapmaker U1)](#multi-head-printers-snapmaker-u1).

## Settings UI

The **Filament Library** section in Settings has two sub-sections:

**Filament Types** — table of all types with delete buttons; add form with a required name field.

**Filament Colors** — table of all colors (with hex swatch if provided) and delete buttons; add form with a required name field and optional hex color picker.

## Client usage

All client pages that show material/color pickers (Settings add-printer form, Printers bulk edit, PrinterDetail edit form, Projects G-code upload and edit) fetch from `/api/filaments/types` and `/api/filaments/colors` and render `<select>` dropdowns rather than free-text `<input>` elements.

## Multi-head printers (Snapmaker U1)

The material and colour fields above describe one filament per printer. A Snapmaker U1 has four heads, each loaded with its own filament, and a multi-colour G-code expects a particular filament on each of its tools. Matching one printer-wide material and colour cannot tell whether the right colours are loaded, or whether they are on the heads the file expects. For these printers the farm matches per head instead, and lets the printer handle the order.

**What the file needs.** At upload, `server/slicer-metadata.js` reads the per-tool lists Orca-family slicers write in the config block (`filament_colour`, `filament_type`, `filament used [g]`, `filament used [mm]`) and stores the tools that actually use filament in `gcodes.tool_filaments`. A tool with no filament used does not count.

**What the printer has.** The Klipper driver also queries the U1's `print_task_config` object on every poll (the same data the printer's filament page at `http://<ip>/filament/` shows and edits) and the poller stores the four heads in `printers.filament_slots`, with `filament_slots_at`. Field names come from Snapmaker's published firmware source (`github.com/Snapmaker/u1-klipper`, `klippy/extras/print_task_config.py`). A head counts as loaded when the printer reports filament present and a type and colour are set.

**Matching** (`server/slot-match.js`). Each used tool needs its own loaded head with the same material type (exact, case-insensitive) and a colour within tolerance: CIE76 delta E, default 15, adjustable as **Filament colour tolerance** under Settings, Dispatch Settings. With four heads every assignment is checked. The one with the closest colours wins, and on a tie the one that moves the fewest tools. A part whose file does not fit a printer is skipped for that printer, and the scheduler moves on to the next part, the same way it does when a part is at its ceiling. A slot reading older than 60 s is not trusted for dispatch.

**Printing in any order.** The U1 firmware keeps a table from the file's tools to its physical heads, and applies it to every tool change, nozzle temperature and Snapmaker macro in the file. The farm uploads the file unchanged and starts it with the firmware's parameterised start command, the same command the slicer's "send and print" uses:

```
SDCARD_PRINT_FILE_WITH_PARAMETERS FILENAME="earring.gcode" MAP_TABLE="[[0,2],[1,0]]" FILAMENT_USED_G="[3.24,1.44]" FILAMENT_USED_MM="[1085.19,484.34]"
```

Here tool 1 (T0) prints on head 3 and tool 2 (T1) on head 1. The firmware clears the table when the print ends. The usage lists also tell the firmware which heads the print uses, so it runs the per-head pre-extrusion the file asks for.

**What is unchanged.** Files without per-tool lists (PrusaSlicer, single-material Bambu files, files uploaded before this feature) and printers that do not report slots (every brand except the U1) behave exactly as before. The gcode and project **Material** and **Colour** fields still apply on top of slot matching if set. For U1 files, leave them blank and let the file decide. Files uploaded before this feature have no per-tool data. Delete and re-upload them to get slot matching.

**Where to see it.** The "Why isn't this printing?" check on the Projects page lists each file's filaments as colour chips, each U1's four heads, and either the tool-to-head map it would use or which filament is missing (`slot_reason` / `tool_map` in `GET /api/parts/:id/dispatch-status`). The forward schedule applies the same rule, using the heads as loaded now.

Implemented from Snapmaker's firmware source and tested against mocks. Not yet validated on a U1.
