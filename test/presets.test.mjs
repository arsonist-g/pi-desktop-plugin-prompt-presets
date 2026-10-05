/**
 * Exercises the real extension module against a stand-in `pi` object.
 *
 * `src/index.ts` is loaded through jiti, the same loader the agent sidecar
 * uses, so the test runs the shipped file rather than a transpiled copy.
 *
 * The preset directory is derived from the home directory at module load, so
 * the home is redirected to a temp directory before the module is imported.
 *
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { createJiti } from "jiti";

const HOME = mkdtempSync(join(tmpdir(), "prompt-presets-test-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const PRESET_DIR = join(HOME, ".pi", "prompt-presets");
mkdirSync(PRESET_DIR, { recursive: true });

const jiti = createJiti(import.meta.url);
const activate = await jiti.import("../src/index.ts", { default: true });

const BASE = "BASE-SYSTEM-PROMPT";
/** Notifications the stub `ui.notify` collected during the last command. */
let notices = [];

function presetFile(id, body, fields = {}) {
  const front = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const text = front ? `---\n${front}\n---\n${body}` : body;
  writeFileSync(join(PRESET_DIR, `${id}.md`), text, "utf8");
}

/** Instantiate the extension with a stub host and return what it registered. */
function load() {
  const handlers = new Map();
  const commands = new Map();
  const statuses = [];
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
  };
  activate(pi);
  const ctxFor = (sessionId) => ({
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      select: async () => undefined,
      setStatus: (key, text) => statuses.push({ key, text }),
    },
  });
  return {
    statuses,
    run: (sessionId, args) => commands.get("preset").handler(args, ctxFor(sessionId)),
    promptFor: (sessionId) =>
      handlers.get("before_agent_start")({ systemPrompt: BASE }, ctxFor(sessionId)),
  };
}

before(() => {
  rmSync(join(PRESET_DIR, "state.json"), { force: true });
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  notices = [];
  for (const entry of ["state.json", "ctf.md", "pre.md", "plain.md"]) {
    rmSync(join(PRESET_DIR, entry), { force: true });
  }
});

test("registers one before_agent_start handler and one /preset command", () => {
  const handlers = new Map();
  const commands = new Map();
  activate({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
  });
  assert.deepEqual([...handlers.keys()], ["before_agent_start"]);
  assert.deepEqual([...commands.keys()], ["preset"]);
});

test("an unselected session keeps the base prompt untouched", async () => {
  presetFile("ctf", "CTF 说明");
  const session = load();
  assert.equal(session.promptFor("s1"), undefined);
});

test("a selected preset is appended by default", async () => {
  presetFile("ctf", "CTF 说明", { name: "CTF 竞赛", position: "after" });
  const session = load();
  await session.run("s1", "ctf");
  assert.equal(session.promptFor("s1").systemPrompt, `${BASE}\n\nCTF 说明`);
});

test("position: before puts the snippet ahead of the base prompt", async () => {
  presetFile("pre", "前置说明", { position: "before" });
  const session = load();
  await session.run("s1", "pre");
  assert.equal(session.promptFor("s1").systemPrompt, `前置说明\n\n${BASE}`);
});

test("the selection is scoped to its session", async () => {
  presetFile("ctf", "CTF 说明");
  const session = load();
  await session.run("s1", "ctf");
  assert.equal(session.promptFor("s2"), undefined);
  assert.equal(session.promptFor("s1").systemPrompt.endsWith("CTF 说明"), true);
});

test("/preset off clears the session", async () => {
  presetFile("ctf", "CTF 说明");
  const session = load();
  await session.run("s1", "ctf");
  await session.run("s1", "off");
  assert.equal(session.promptFor("s1"), undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(PRESET_DIR, "state.json"), "utf8")).sessions, {});
});

test("the selection survives a reload through state.json", async () => {
  presetFile("ctf", "CTF 说明");
  await load().run("s1", "ctf");
  const reloaded = load();
  assert.equal(reloaded.promptFor("s1").systemPrompt, `${BASE}\n\nCTF 说明`);
});

test("a file without front matter uses its name and appends", async () => {
  presetFile("plain", "无 front matter 的正文");
  const session = load();
  await session.run("s1", "plain");
  assert.equal(session.promptFor("s1").systemPrompt, `${BASE}\n\n无 front matter 的正文`);
  assert.equal(notices.length, 1);
});

test("an unknown preset name is refused and changes nothing", async () => {
  presetFile("ctf", "CTF 说明");
  const session = load();
  await session.run("s1", "nope");
  assert.match(notices[0].message, /没有名为 nope 的预设/);
  assert.match(notices[0].message, /ctf/);
  assert.equal(notices[0].level, "warning");
  assert.equal(session.promptFor("s1"), undefined);
});

test("/preset list names every file and its position", async () => {
  presetFile("ctf", "A", { position: "before" });
  presetFile("plain", "B");
  const session = load();
  await session.run("s1", "list");
  assert.match(notices[0].message, /`ctf`（前置）/);
  assert.match(notices[0].message, /`plain`（后置）/);
});

test("an empty directory points at the directory to fill", async () => {
  const session = load();
  await session.run("s1", "");
  assert.match(notices[0].message, /没有可用预设/);
  assert.match(notices[0].message, /prompt-presets/);
});

test("each turn rebuilds from the base prompt instead of accumulating", async () => {
  presetFile("ctf", "CTF 说明");
  const session = load();
  await session.run("s1", "ctf");
  const first = session.promptFor("s1").systemPrompt;
  const second = session.promptFor("s1").systemPrompt;
  assert.equal(first, second);
  assert.equal(second, `${BASE}\n\nCTF 说明`);
});

test("state.json is not offered as a preset", async () => {
  presetFile("ctf", "CTF 说明");
  const session = load();
  await session.run("s1", "ctf");
  await session.run("s1", "list");
  assert.doesNotMatch(notices.at(-1).message, /`state`/);
});
