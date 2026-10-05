/**
 * Preset file manager for `local.prompt-presets`.
 *
 * The agent extension (`src/index.ts`) owns the prompt hook and reads the same
 * directory; this module only edits the files, so the two share no state.
 *
 * The preset directory sits outside any workspace, so it is reached through the
 * `userSelected` fs root: the user points at it once and the grant lives for
 * this run of the plugin process only. Until it is granted, the panel reports
 * `granted: false` instead of failing.
 */

/** Matches the extension's read cap: a longer file is a mistake, not a preset. */
const MAX_PRESET_BYTES = 64 * 1024;
/** Preset ids become file names; reject anything that is not a plain name. */
const ID_PATTERN = /^[^\\/:*?"<>|]{1,64}$/;
/** The extension keeps its per-session selection in the same directory; it is not a preset. */
const RESERVED = new Set(["state", "state.json"]);

/** Front matter keys the panel reads for the list; the extension owns parsing. */
function describe(id, raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(raw);
  const fields = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator <= 0) continue;
      fields[line.slice(0, separator).trim().toLowerCase()] = line
        .slice(separator + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
  const position = fields.position?.toLowerCase() === "before" ? "before" : "after";
  return { id, name: fields.name || id, description: fields.description || "", position };
}

async function directoryStatus() {
  const picked = await pi.plugin.getSettings().then(
    (settings) => settings.presetDirectory ?? null,
    () => null,
  );
  return picked;
}

async function granted() {
  try {
    await pi.fs.list("");
    return true;
  } catch (error) {
    if (String(error?.code ?? error?.message ?? "").includes("NOT_FOUND")) return false;
    throw error;
  }
}

async function listPresets() {
  let entries;
  try {
    entries = await pi.fs.list("");
  } catch (error) {
    if (String(error?.code ?? error?.message ?? "").includes("NOT_FOUND")) return null;
    throw error;
  }
  const presets = [];
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.toLowerCase().endsWith(".md")) continue;
    const id = entry.name.slice(0, -3);
    if (RESERVED.has(id.toLowerCase())) continue;
    try {
      const raw = await pi.fs.readText(entry.path);
      presets.push({
        ...describe(id, raw),
        raw,
        size: entry.size ?? raw.length,
        mtimeMs: entry.mtimeMs ?? 0,
      });
    } catch {
      // A file that cannot be read is reported by its name alone rather than
      // dropping the whole list.
      presets.push({ id, name: id, description: "", position: "after", raw: "", size: 0, mtimeMs: 0 });
    }
  }
  presets.sort((a, b) => a.id.localeCompare(b.id));
  return presets;
}

async function onPanelInvoke(channel, payload) {
  switch (channel) {
    case "presets:status": {
      const dir = await directoryStatus();
      return { granted: await granted(), dir };
    }
    case "presets:grant": {
      const picked = await pi.fs.requestDirectory();
      if (!picked) return { granted: false, dir: null };
      await pi.plugin.setSettings({ presetDirectory: picked.path });
      return { granted: true, dir: picked.path };
    }
    case "presets:list": {
      const presets = await listPresets();
      if (!presets) return { granted: false, dir: await directoryStatus() };
      return { granted: true, dir: await directoryStatus(), presets };
    }
    case "presets:save": {
      const id = String(payload?.id ?? "").trim();
      const raw = String(payload?.raw ?? "");
      if (!ID_PATTERN.test(id) || id.startsWith(".") || RESERVED.has(id.toLowerCase())) {
        throw Object.assign(new Error(`invalid preset name: ${id}`), { code: "INVALID_ARGUMENT" });
      }
      if (!raw.trim()) {
        throw Object.assign(new Error("preset is empty"), { code: "INVALID_ARGUMENT" });
      }
      if (raw.length > MAX_PRESET_BYTES) {
        throw Object.assign(new Error(`preset is larger than ${MAX_PRESET_BYTES} bytes`), {
          code: "INVALID_ARGUMENT",
        });
      }
      await pi.fs.writeText(`${id}.md`, raw.endsWith("\n") ? raw : `${raw}\n`);
      return { id };
    }
    case "presets:delete": {
      const id = String(payload?.id ?? "").trim();
      if (!ID_PATTERN.test(id) || RESERVED.has(id.toLowerCase())) {
        throw Object.assign(new Error(`invalid preset name: ${id}`), { code: "INVALID_ARGUMENT" });
      }
      await pi.fs.remove(`${id}.md`);
      return { id };
    }
    case "presets:reveal": {
      const id = String(payload?.id ?? "").trim();
      if (!ID_PATTERN.test(id)) {
        throw Object.assign(new Error(`invalid preset name: ${id}`), { code: "INVALID_ARGUMENT" });
      }
      await pi.fs.reveal(`${id}.md`);
      return { id };
    }
    default:
      throw Object.assign(new Error(`unknown channel: ${channel}`), { code: "UNSUPPORTED" });
  }
}

module.exports = { onPanelInvoke };
