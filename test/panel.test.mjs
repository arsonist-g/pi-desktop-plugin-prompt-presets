/**
 * Exercises the panel backend in `main.js`: the channels `views/presets.html`
 * calls through `window.pluginBridge.invoke`, with a stand-in `pi` object.
 *
 * The panel's own rendering is not covered here — this pins the filesystem
 * behaviour behind it, including the two states the panel has to render
 * differently (`granted: false` before the user picks a directory, and a
 * normal listing after).
 *
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

const require = createRequire(import.meta.url);

/** Files the stub fs exposes, keyed by root-relative path. */
let files = {};
let entries = [];
let writes = [];
let removals = [];
let reveals = [];
let settings = {};
/** What the native picker returns; null models the user cancelling it. */
let picked = { path: "C:\\Users\\example\\.pi\\prompt-presets", name: "prompt-presets" };
/** When true, `fs.list` rejects the way an ungranted `userSelected` root does. */
let ungranted = false;

function notFound() {
  return Object.assign(new Error("no directory has been chosen; call fs.requestDirectory first"), {
    code: "NOT_FOUND",
  });
}

function entry(name, size) {
  return { name, path: name, isDirectory: false, size, mtimeMs: 1 };
}

let onPanelInvoke;

beforeEach(() => {
  files = {};
  entries = [];
  writes = [];
  removals = [];
  reveals = [];
  settings = {};
  picked = { path: "C:\\Users\\example\\.pi\\prompt-presets", name: "prompt-presets" };
  ungranted = false;
  globalThis.pi = {
    plugin: {
      getSettings: async () => settings,
      setSettings: async (patch) => Object.assign(settings, patch),
    },
    fs: {
      list: async () => {
        if (ungranted) throw notFound();
        return entries;
      },
      readText: async (path) => {
        if (!(path in files)) throw notFound();
        return files[path];
      },
      writeText: async (path, content) => {
        writes.push([path, content]);
        files[path] = content;
        entries.push(entry(path, content.length));
      },
      remove: async (path) => {
        removals.push(path);
        delete files[path];
        entries = entries.filter((item) => item.name !== path);
      },
      reveal: async (path) => {
        reveals.push(path);
      },
      requestDirectory: async () => picked,
    },
  };
  delete require.cache[require.resolve("../main.js")];
  ({ onPanelInvoke } = require("../main.js"));
});

afterEach(() => {
  delete globalThis.pi;
});

test("status reports the ungranted state instead of throwing", async () => {
  ungranted = true;
  assert.deepEqual(await onPanelInvoke("presets:status", {}), { granted: false, dir: null });
});

test("list reports the ungranted state instead of throwing", async () => {
  ungranted = true;
  assert.deepEqual(await onPanelInvoke("presets:list", {}), { granted: false, dir: null });
});

test("grant records the picked directory for later runs", async () => {
  ungranted = true;
  const result = await onPanelInvoke("presets:grant", {});
  assert.equal(result.granted, true);
  assert.equal(settings.presetDirectory, picked.path);
});

test("a cancelled picker leaves the plugin ungranted", async () => {
  ungranted = true;
  picked = null;
  assert.deepEqual(await onPanelInvoke("presets:grant", {}), { granted: false, dir: null });
  assert.equal(settings.presetDirectory, undefined);
});

test("list parses front matter and sorts by id", async () => {
  entries = [entry("zeta.md", 10), entry("ctf.md", 10), entry("notes.txt", 3)];
  files["ctf.md"] = "---\nname: CTF 竞赛\ndescription: 竞赛用\nposition: before\n---\n正文";
  files["zeta.md"] = "没有 front matter";
  const result = await onPanelInvoke("presets:list", {});
  assert.equal(result.granted, true);
  assert.deepEqual(
    result.presets.map((preset) => [preset.id, preset.name, preset.position]),
    [
      ["ctf", "CTF 竞赛", "before"],
      ["zeta", "zeta", "after"],
    ],
  );
  assert.equal(result.presets[0].raw, files["ctf.md"]);
});

test("the extension's state file is not listed as a preset", async () => {
  entries = [entry("state.json", 2), entry("ctf.md", 4)];
  files["ctf.md"] = "正文";
  const result = await onPanelInvoke("presets:list", {});
  assert.deepEqual(result.presets.map((p) => p.id), ["ctf"]);
});

test("save writes the file under the preset's own name", async () => {
  await onPanelInvoke("presets:save", { id: "ctf", raw: "正文" });
  assert.deepEqual(writes, [["ctf.md", "正文\n"]]);
});

test("save keeps an existing trailing newline instead of doubling it", async () => {
  await onPanelInvoke("presets:save", { id: "ctf", raw: "正文\n" });
  assert.deepEqual(writes, [["ctf.md", "正文\n"]]);
});

for (const [label, id] of [
  ["a path separator", "../escape"],
  ["a nested path", "sub/name"],
  ["a Windows-reserved character", "a:b"],
  ["a dotfile name", ".hidden"],
  ["the state file", "state"],
]) {
  test(`save refuses ${label}`, async () => {
    await assert.rejects(() => onPanelInvoke("presets:save", { id, raw: "正文" }), /invalid preset name/);
    assert.equal(writes.length, 0);
  });
}

test("save refuses an empty preset", async () => {
  await assert.rejects(() => onPanelInvoke("presets:save", { id: "ctf", raw: "   \n" }), /empty/);
});

test("save refuses a preset past the extension's read cap", async () => {
  await assert.rejects(
    () => onPanelInvoke("presets:save", { id: "ctf", raw: "x".repeat(64 * 1024 + 1) }),
    /larger than/,
  );
});

test("delete removes exactly the named file", async () => {
  await onPanelInvoke("presets:delete", { id: "ctf" });
  assert.deepEqual(removals, ["ctf.md"]);
});

test("reveal opens the named file in the file manager", async () => {
  await onPanelInvoke("presets:reveal", { id: "ctf" });
  assert.deepEqual(reveals, ["ctf.md"]);
});

test("an unknown channel is refused with UNSUPPORTED", async () => {
  await assert.rejects(
    () => onPanelInvoke("presets:nonsense", {}),
    (error) => error.code === "UNSUPPORTED",
  );
});
