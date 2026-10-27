// Settings from ~/.config/lboard/config.json; an environment variable, where set, wins over the file.
// See the README for what each one means.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The config file: $XDG_CONFIG_HOME/lboard/config.json, by default ~/.config/lboard/config.json. */
export const CONFIG_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "lboard", "config.json");

/** What the config file may hold, with the environment variable that overrides each. */
const SETTINGS = {
  token: "LINEAR_API_KEY",
  team: "LINEAR_TEAM",
  project: "LBOARD_PROJECT",
  columns: "LBOARD_COLUMNS",
  hideEmpty: "LBOARD_HIDE_EMPTY",
  theme: "LBOARD_THEME",
  bench: "LBOARD_BENCH",
  branch: "LBOARD_BRANCH",
  truecolor: "LBOARD_TRUECOLOR",
} as const;

type Setting = keyof typeof SETTINGS;

/** Why the config file can't be used, reported when lboard starts; "" when it is fine or there is none. */
export let CONFIG_ERROR = "";

function readConfig(): Partial<Record<Setting, string>> {
  let text: string;
  try {
    text = readFileSync(CONFIG_FILE, "utf8");
  } catch {
    return {}; // no file: the environment only
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object of settings");
    const config: Partial<Record<Setting, string>> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (!(name in SETTINGS)) throw new Error(`unknown setting "${name}", choose from: ${Object.keys(SETTINGS).join(", ")}`);
      // a list of columns, true for truecolor: all read as the environment would have them
      config[name as Setting] = Array.isArray(value) ? value.join(",") : value === true ? "1" : value === false ? "" : String(value);
    }
    return config;
  } catch (e) {
    CONFIG_ERROR = `${CONFIG_FILE}: ${(e as Error).message}`;
    return {};
  }
}

let config = readConfig();

/** A setting from the environment, else the config file; undefined when neither has it. */
export const setting = (name: Setting): string | undefined => process.env[SETTINGS[name]] ?? config[name];

/** Linear's GraphQL API and web app; the tests point them elsewhere. */
export const API_URL = process.env.LINEAR_API_URL || "https://api.linear.app/graphql";
export const WEB_URL = (process.env.LINEAR_WEB_URL || "https://linear.app").replace(/\/+$/, "");

export let TOKEN = "";

function apply(): void {
  TOKEN = setting("token") ?? "";
}
apply();

/** Read the config file again, e.g. after setup wrote it. */
export function reloadConfig(): void {
  CONFIG_ERROR = "";
  config = readConfig();
  apply();
}

/** Save settings in the config file, keeping the others in it; only you can read it, since it holds the API key. */
export function saveConfig(settings: Partial<Record<Setting, string>>): void {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    // none yet, or one setup replaces
  }
  for (const [name, value] of Object.entries(settings)) {
    if (value === "") delete saved[name]; // e.g. no project: the whole team
    else saved[name] = value;
  }
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600); // also when it was there already
  reloadConfig();
}

/** The workspace's part of Linear's web addresses (linear.app/<workspace>/…), known once the board loaded. */
let workspace = "";

export function setWorkspace(urlKey: string): void {
  workspace = urlKey;
}

export const issueUrl = (key: string) => `${WEB_URL}/${workspace}/issue/${key}`;

/** The team's board in Linear: its active cycle, its active issues or its backlog; or a project's issues. */
export function boardUrl(team: string, view: "cycle" | "active" | "backlog", project?: { slugId: string } | null): string {
  if (project) return `${WEB_URL}/${workspace}/project/${project.slugId}/issues`;
  return `${WEB_URL}/${workspace}/team/${team}/${view === "cycle" ? "cycle/active" : view}`;
}
