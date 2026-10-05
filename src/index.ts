/**
 * Session-scoped prompt presets (spec 07-plugins/16 §6, `before_agent_start`).
 *
 * A preset is a Markdown snippet appended to — or prepended to — the system
 * prompt of the session it was selected in. The global agent instructions are
 * never modified, so a preset picked for one session does not reach the other
 * sessions running at the same time.
 *
 * Presets are read from `~/.pi/prompt-presets/*.md`, each file optionally
 * carrying YAML front matter:
 *
 *   ---
 *   name: CTF 竞赛
 *   description: 本次会话是授权的 CTF 竞赛环境
 *   position: after        # after（默认）| before
 *   ---
 *   正文……
 *
 * Without front matter the file name becomes the display name and the position
 * defaults to `after`. The selection is remembered per session id in
 * `state.json`, so it survives an extension reload.
 *
 * Commands: `/preset` (picker), `/preset <name>`, `/preset list`, `/preset off`.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PRESET_DIR = join(homedir(), ".pi", "prompt-presets");
const STATE_FILE = join(PRESET_DIR, "state.json");
const STATUS_KEY = "prompt-preset";
/** A preset is prompt text, not a document; a larger file is almost certainly a mistake. */
const MAX_PRESET_BYTES = 64 * 1024;
/** Sessions are pruned to this many entries on write so `state.json` stays bounded. */
const MAX_STATE_SESSIONS = 500;

type PresetPosition = "before" | "after";

type PromptPreset = {
  id: string;
  name: string;
  description?: string;
  position: PresetPosition;
  body: string;
};

type ExtensionContext = {
  ui: {
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    setStatus: (key: string, text: string | undefined) => void;
  };
  sessionManager: { getSessionId: () => string };
};

type BeforeAgentStartEvent = { systemPrompt?: string };

type ExtensionApi = {
  on: (
    event: "before_agent_start",
    handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => { systemPrompt: string } | undefined,
  ) => void;
  registerCommand: (
    name: string,
    command: {
      description?: string;
      handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
    },
  ) => void;
};

/** Parsed body cache keyed by path; `mtimeMs:size` invalidates an edited file. */
const bodyCache = new Map<string, { stamp: string; preset: PromptPreset }>();

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Split optional `---` front matter from the body. Only `key: value` lines are
 * read; anything else is left in the body untouched, so a preset may start with
 * a horizontal rule or Markdown that happens to contain colons.
 */
function splitFrontMatter(source: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return { fields: {}, body: source };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = unquote(line.slice(separator + 1));
    if (key) fields[key] = value;
  }
  return { fields, body: source.slice(match[0].length) };
}

function parsePreset(id: string, source: string): PromptPreset {
  const { fields, body } = splitFrontMatter(source);
  const position: PresetPosition = fields.position?.trim().toLowerCase() === "before" ? "before" : "after";
  return {
    id,
    name: fields.name?.trim() || id,
    ...(fields.description?.trim() ? { description: fields.description.trim() } : {}),
    position,
    body: body.trim(),
  };
}

/** Every `*.md` in the preset directory, name-sorted, with edited files re-read. */
function loadPresets(): PromptPreset[] {
  let entries: string[];
  try {
    entries = readdirSync(PRESET_DIR);
  } catch {
    return [];
  }
  const presets: PromptPreset[] = [];
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const path = join(PRESET_DIR, entry);
    let stamp: string;
    try {
      const stats = statSync(path);
      if (!stats.isFile() || stats.size > MAX_PRESET_BYTES) continue;
      stamp = `${stats.mtimeMs}:${stats.size}`;
    } catch {
      continue;
    }
    const cached = bodyCache.get(path);
    if (cached?.stamp === stamp) {
      presets.push(cached.preset);
      continue;
    }
    try {
      const preset = parsePreset(entry.slice(0, -3), readFileSync(path, "utf8"));
      bodyCache.set(path, { stamp, preset });
      presets.push(preset);
    } catch {
      continue;
    }
  }
  return presets;
}

function readState(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { sessions?: unknown };
    const sessions = parsed?.sessions;
    if (!sessions || typeof sessions !== "object") return {};
    const out: Record<string, string> = {};
    for (const [sessionId, presetId] of Object.entries(sessions as Record<string, unknown>)) {
      if (typeof presetId === "string" && presetId) out[sessionId] = presetId;
    }
    return out;
  } catch {
    return {};
  }
}

function writeState(sessions: Record<string, string>): void {
  const keys = Object.keys(sessions);
  const bounded = keys.length > MAX_STATE_SESSIONS ? keys.slice(keys.length - MAX_STATE_SESSIONS) : keys;
  const trimmed = Object.fromEntries(bounded.map((key) => [key, sessions[key]]));
  mkdirSync(PRESET_DIR, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify({ version: 1, sessions: trimmed }, null, 2)}\n`, "utf8");
}

function formatList(presets: PromptPreset[]): string {
  return presets
    .map((preset) => `\`${preset.id}\`（${preset.position === "before" ? "前置" : "后置"}）${preset.name}`)
    .join("\n");
}

export default function activate(pi: ExtensionApi): void {
  mkdirSync(PRESET_DIR, { recursive: true });
  const sessions = readState();
  /** Last text published to the status line, so it is written only on change. */
  const published = new Map<string, string>();

  function select(sessionId: string, presetId: string | undefined, ctx: ExtensionContext): void {
    if (presetId) sessions[sessionId] = presetId;
    else delete sessions[sessionId];
    writeState(sessions);
    publishStatus(sessionId, ctx);
  }

  function publishStatus(sessionId: string, ctx: ExtensionContext): void {
    const presetId = sessions[sessionId];
    const text = presetId ? `预设：${presetId}` : "";
    if (published.get(sessionId) === text) return;
    published.set(sessionId, text);
    ctx.ui.setStatus(STATUS_KEY, text || undefined);
  }

  pi.on("before_agent_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    publishStatus(sessionId, ctx);
    const presetId = sessions[sessionId];
    if (!presetId || typeof event.systemPrompt !== "string") return undefined;
    const preset = loadPresets().find((candidate) => candidate.id === presetId);
    if (!preset?.body) return undefined;
    const systemPrompt =
      preset.position === "before"
        ? `${preset.body}\n\n${event.systemPrompt}`
        : `${event.systemPrompt}\n\n${preset.body}`;
    return { systemPrompt };
  });

  pi.registerCommand("preset", {
    description: "为当前会话追加提示词预设（/preset 选择，/preset list 列出，/preset off 取消）",
    async handler(args, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const presets = loadPresets();
      // The directory is created at load, but a user command is the first point
      // where the path is worth spelling out.
      const where = `预设目录：${PRESET_DIR}`;
      const requested = args.trim();

      if (requested.toLowerCase() === "off") {
        select(sessionId, undefined, ctx);
        ctx.ui.notify(`已取消当前会话的提示词预设。${where}`);
        return;
      }
      if (!presets.length) {
        ctx.ui.notify(`没有可用预设，放一个 .md 文件进去即可。\n${where}`, "warning");
        return;
      }
      if (requested.toLowerCase() === "list") {
        ctx.ui.notify(`可用预设：\n${formatList(presets)}\n${where}`);
        return;
      }
      if (requested) {
        const preset = presets.find((candidate) => candidate.id === requested);
        if (!preset) {
          ctx.ui.notify(`没有名为 ${requested} 的预设。\n可用预设：\n${formatList(presets)}`, "warning");
          return;
        }
        select(sessionId, preset.id, ctx);
        ctx.ui.notify(`当前会话已启用预设 ${preset.id}（${preset.position === "before" ? "前置" : "后置"}）。`);
        return;
      }

      // Labels start with the (unique) file-derived id, so two presets can never
      // collapse into the same entry.
      const options = new Map<string, string>();
      for (const preset of presets) options.set(`${preset.id} — ${preset.name}`, preset.id);
      const offLabel = "off — 不使用预设";
      options.set(offLabel, "");
      const picked = await ctx.ui.select("选择当前会话的提示词预设", [...options.keys()]);
      if (picked === undefined) return;
      const presetId = options.get(picked);
      if (presetId === undefined) return;
      if (!presetId) {
        select(sessionId, undefined, ctx);
        ctx.ui.notify("已取消当前会话的提示词预设。");
        return;
      }
      select(sessionId, presetId, ctx);
      ctx.ui.notify(`当前会话已启用预设 ${presetId}。`);
    },
  });
}
