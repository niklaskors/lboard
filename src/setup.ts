// Setup, on the first run (no config yet) or with --setup: asks for a Linear API key, a team and optionally a project,
// checks them with Linear, and saves them in the config file.

import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import { CONFIG_FILE, saveConfig, setting } from "./config.ts";
import { myTeams, whoAmI } from "./linear/api.ts";
import { LinearError } from "./linear/client.ts";

/** Questions on the terminal; answers are read as lines, so typed-ahead or piped ones aren't lost. */
class Questions {
  muted = false;
  rl: Interface;
  lines: AsyncIterator<string>;
  closed = false; // all input read; answers may still be waiting in `lines`

  constructor() {
    // the token isn't echoed: what readline writes goes nowhere while muted
    const output = new Writable({
      write: (chunk, _encoding, done) => {
        if (!this.muted) process.stdout.write(chunk);
        done();
      },
    });
    this.rl = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
    this.rl.on("SIGINT", () => { // ctrl+c
      process.stdout.write("\n");
      process.exit(130);
    });
    this.rl.on("close", () => (this.closed = true));
    this.lines = this.rl[Symbol.asyncIterator]();
  }

  async line(prompt: string, secret: boolean): Promise<string> {
    if (this.closed) process.stdout.write(prompt);
    else {
      this.rl.setPrompt(prompt);
      this.rl.prompt();
    }
    this.muted = secret;
    try {
      const { value, done } = await this.lines.next();
      if (done) throw new LinearError("setup cancelled");
      return (value as string).trim();
    } finally {
      if (secret) process.stdout.write("\n"); // the enter wasn't echoed
      this.muted = false;
    }
  }

  async ask(question: string, answer = ""): Promise<string> {
    return (await this.line(`${question}${answer ? ` [${answer}]` : ""}: `, false)) || answer;
  }

  secret(question: string): Promise<string> {
    return this.line(`${question}: `, true);
  }

  close(): void {
    this.rl.close();
  }
}

/** One of my teams, by its key or its number in the list. */
async function chooseTeam(q: Questions, token: string): Promise<string> {
  const teams = await myTeams(token);
  if (!teams.length) throw new LinearError("you are in no Linear team yet: join one first");
  teams.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. ${t.key.padEnd(6)} ${t.name}`));
  for (;;) {
    const answer = (await q.ask("Team: its key or number", setting("team") ?? (teams.length === 1 ? teams[0].key : ""))).trim();
    const team = teams[Number(answer) - 1] ?? teams.find((t) => t.key.toLowerCase() === answer.toLowerCase());
    if (team) return team.key;
    if (answer) console.log(`  no team "${answer}"`);
  }
}

/** Ask for the settings lboard needs, check them with Linear and save them. */
export async function setup(): Promise<void> {
  console.log(`Setting up lboard; your answers are saved in ${CONFIG_FILE}.\n`);
  const q = new Questions();
  try {
    let token = "";
    for (;;) {
      token = await q.secret("Linear API key (in Linear: Settings → Security & access → Personal API keys)");
      if (!token) continue;
      try {
        const me = await whoAmI(token);
        console.log(`  signed in as ${me.displayName}`);
        break;
      } catch (e) {
        console.log(`  that didn't work: ${(e as Error).message}\n`);
      }
    }
    const team = await chooseTeam(q, token);
    const current = setting("project");
    let project = await q.ask(`Only the issues of one project? Its name, or ${current ? "- for" : "empty for"} the whole team`, current);
    if (project === "-") project = "";
    saveConfig({ token, team, project });
    console.log(`\nSaved. Change it in ${CONFIG_FILE}, or run lboard --setup again.\n`);
  } finally {
    q.close();
  }
}
