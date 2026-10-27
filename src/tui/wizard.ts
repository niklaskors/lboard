// `lboard --create SUMMARY`: a small wizard that creates one issue, for other tools such as punch. Step by step it
// asks the project (only when the team has any), the type, and where it goes, then the summary, typed in already. It draws on the terminal itself (/dev/tty), so whoever runs it reads the new key from stdout:
// key=$(lboard --create "Export to CSV").

import { openSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { ReadStream, WriteStream } from "node:tty";
import { createIssue, issueTypes, loadTeam, places, teamProjects, type IssueType, type Place, type Team } from "../linear/api.ts";
import { LinearError } from "../linear/client.ts";
import type { Project } from "../linear/types.ts";
import { typeIcon } from "../render/layout.ts";
import { lineLen, shorten, sliceLine, type Line, type Segment } from "../render/line.ts";
import { ansi, theme } from "../render/theme.ts";
import { boxInner, drawBox, isTyping, type BoxRow, type Key } from "./dialog.ts";

const SHAPE = { max: 72, pad: 2, padY: 1 };

type Step = "project" | "type" | "where" | "summary";
const STEP_NAMES: Record<Step, string> = { project: "Project", type: "Type", where: "Where", summary: "Summary" };

/** Where the wizard draws: a terminal's size, and its output. */
export interface Screen {
  columns: number;
  rows: number;
  write(data: string): unknown;
}

export interface Created {
  key: string;
  /** What went wrong after it was created; "" when nothing did. */
  warning: string;
}

interface Choice {
  label: Line;
  note: string;
}

export class CreateWizard {
  screen: Screen;
  teamKey: string;
  team: Team | null = null;
  finish: (created: Created | null) => void;
  /** No project (null), then the team's open projects. */
  projects: (Project | null)[] = [null];
  project = 0;
  types: IssueType[] = [];
  type = 0;
  /** The backlog, then the cycles or the board; the backlog is the default, as with C on the board. */
  places: Place[] = [];
  place = 0;
  summary: string;
  step: Step = "type";
  status = "loading…";
  /** Loading or creating: keys wait, apart from esc. */
  busy = true;
  creating = false;
  finished = false;

  /** `project`: the one to start on, by name, e.g. the config's. */
  constructor(screen: Screen, teamKey: string, project: string | undefined, summary: string, finish: (created: Created | null) => void) {
    this.screen = screen;
    this.teamKey = teamKey;
    this.summary = summary.replace(/\s+/g, " ").trim();
    this.finish = finish;
    loadTeam(teamKey).then(async (team) => {
      this.team = team;
      this.places = places(team);
      const [projects, types] = await Promise.all([teamProjects(team.id), issueTypes(team.id)]);
      this.projects = [null, ...projects];
      const wanted = project?.toLowerCase();
      this.project = Math.max(0, this.projects.findIndex((p) => !!p && !!wanted && [p.name.toLowerCase(), p.slugId, p.id].includes(wanted)));
      this.types = types;
      this.step = this.steps[0];
      this.busy = false;
      this.status = "";
      this.draw();
    }).catch((e: Error) => {
      this.busy = false;
      this.status = `loading team ${teamKey} failed: ${e.message}`;
      this.draw();
    });
  }

  /** The steps there are: the project only when there is a choice. */
  get steps(): Step[] {
    return this.projects.length > 1 ? ["project", "type", "where", "summary"] : ["type", "where", "summary"];
  }

  /** The option selected in the step shown. */
  get sel(): number {
    return this.step === "project" ? this.project : this.step === "type" ? this.type : this.place;
  }

  set sel(i: number) {
    if (this.step === "project") this.project = i;
    else if (this.step === "type") this.type = i;
    else this.place = i;
  }

  done(created: Created | null): void {
    if (this.finished) return;
    this.finished = true;
    this.finish(created);
  }

  async key(str: string | undefined, key: Key): Promise<void> {
    if (key.ctrl && key.name === "c") return this.done(null);
    if (key.name === "escape") return this.back();
    if (this.busy) return;
    if (this.step === "summary") return this.summaryKey(str, key);
    const count = this.choices().length;
    const name = key.name && key.name.length > 1 ? key.name : str;
    if (name === "up" || name === "k" || (key.shift && name === "tab")) this.sel = Math.max(0, this.sel - 1);
    else if (name === "down" || name === "j" || name === "tab") this.sel = Math.min(count - 1, this.sel + 1);
    else if (name === "return" || name === "enter" || name === "right" || name === "l") await this.next();
    else if (name === "left" || name === "h") this.back();
  }

  async next(): Promise<void> {
    if (this.step === "type" && !this.types.length) return;
    this.step = this.steps[this.steps.indexOf(this.step) + 1];
  }

  /** One step back; from the first, cancel. */
  back(): void {
    if (this.creating) return;
    const i = this.steps.indexOf(this.step);
    if (i <= 0) return this.done(null);
    this.step = this.steps[i - 1];
    this.status = "";
  }

  async summaryKey(str: string | undefined, key: Key): Promise<void> {
    this.status = "";
    if (key.name === "return" || key.name === "enter") await this.create();
    else if (key.name === "backspace") this.summary = this.summary.slice(0, -1);
    else if (key.ctrl && key.name === "u") this.summary = "";
    else if (key.ctrl && key.name === "w") this.summary = this.summary.replace(/\S*\s*$/, "");
    else if (key.name === "left") this.back();
    else if (isTyping(str, key)) this.summary += str;
  }

  where(): string {
    return this.places[this.place]?.name ?? "the backlog";
  }

  async create(): Promise<void> {
    const summary = this.summary.trim();
    if (!summary) {
      this.status = "type a summary first";
      return;
    }
    const project = this.projects[this.project];
    const type = this.types[this.type];
    const place = this.places[this.place];
    const kind = type.name.toLowerCase();
    this.busy = this.creating = true;
    this.status = `creating ${kind === "issue" ? "an issue" : `a ${kind}`} in ${this.where()}…`;
    this.draw();
    let key: string;
    try {
      key = await createIssue({
        teamId: this.team!.id, title: summary, labelIds: type.id ? [type.id] : [],
        ...project ? { projectId: project.id } : {},
        ...place?.input.cycleId ? { cycleId: place.input.cycleId } : {},
        ...place?.input.stateId ? { stateId: place.input.stateId } : {},
      });
    } catch (e) {
      this.busy = this.creating = false;
      this.status = `creating the ${kind} failed: ${(e as Error).message}`;
      return;
    }
    this.done({ key, warning: "" });
  }

  /** The options of the step shown. */
  choices(): Choice[] {
    if (this.step === "project") return this.projects.map((p) => ({ label: [[p?.name ?? "No project", p ? null : "dim"]], note: "" }));
    if (this.step === "type") return this.types.map((t) => ({ label: [typeIcon(t.name), [` ${t.name}`, null]], note: "" }));
    return this.places.map((p) => ({ label: [[p.name, null]], note: p.note }));
  }

  /** The steps along the top: what was chosen in those done, the one shown highlighted, those to come dimmed. */
  trail(): Line {
    const steps = this.steps;
    const at = steps.indexOf(this.step);
    const chosen: Record<Step, () => string> = {
      project: () => this.projects[this.project]?.name ?? "No project",
      type: () => this.types[this.type]?.name ?? "",
      where: () => this.where(),
      summary: () => "",
    };
    return steps.flatMap((step, i): Line => [
      ...(i ? [[" › ", "dim"] as Segment] : []),
      i < at ? [chosen[step](), "accent"] : i === at ? [` ${STEP_NAMES[step]} `, "rev"] : [STEP_NAMES[step], "dim"],
    ]);
  }

  draw(): void {
    if (this.finished) return;
    const width = this.screen.columns || 80;
    const height = this.screen.rows || 24;
    const inner = boxInner(width, SHAPE);
    const rows: Line[] = Array.from({ length: height }, () => []);
    rows[0] = [[theme.icons.sprint ? ` ${theme.icons.sprint} ` : "", "accent"], ["lboard", "title"], ["   new issue", "name"]];

    const body: BoxRow[] = [{ line: this.trail() }, "rule"];
    if (this.step === "summary") {
      const shown = this.summary.length > inner - 3 ? `…${this.summary.slice(-(inner - 4))}` : this.summary;
      const type = this.types[this.type];
      body.push(
        { line: [["› ", "dim"], [shown, null], ["█", "dim"]] },
        { line: [] },
        { line: [typeIcon(type.name), [` ${type.name} in ${this.where()}`, "dim"]] },
      );
    } else {
      const choices = this.choices();
      choices.forEach((c, i) => {
        const note = shorten(c.note, Math.floor(inner / 2) - 2);
        const label = sliceLine(c.label, 0, inner - note.length - 1);
        const gap = " ".repeat(Math.max(1, inner - lineLen(label) - note.length));
        body.push({ line: [...label, [gap, null], [note, "dim"]], style: i === this.sel ? "rev" : null });
      });
      if (!choices.length && !this.status) body.push({ line: [["nothing to choose from", "dim"]] });
    }
    if (this.status) body.push("rule", { line: [[shorten(this.status, inner), "dim"]] });

    const first = this.steps.indexOf(this.step) === 0;
    const footer = this.step === "summary" ? "⏎ create · ^U clear · esc back"
      : `↑↓ choose · ⏎ next · esc ${first ? "cancel" : "back"}`;
    const project = this.step === "project" ? null : this.projects[this.project];
    const title = `New issue in ${this.teamKey.toUpperCase()}${project ? ` · ${project.name}` : ""}`;
    drawBox(rows, { width, height }, title, body, footer, SHAPE);

    // as the board draws: a synchronized update, every row positioned explicitly and cleared to the right
    const frame = rows.map((row, y) => `\x1b[${y + 1};1H${ansi(sliceLine(row, 0, width))}\x1b[K`).join("");
    this.screen.write(`\x1b[?2026h${frame}\x1b[?2026l`);
  }
}

/** The terminal, also when stdin or stdout is a pipe (as when another program reads the key). */
function terminal(): { input: ReadStream; output: WriteStream; own: boolean } {
  if (process.stdin.isTTY && process.stdout.isTTY) return { input: process.stdin, output: process.stdout, own: false };
  try {
    return { input: new ReadStream(openSync("/dev/tty", "r")), output: new WriteStream(openSync("/dev/tty", "w")), own: true };
  } catch {
    throw new LinearError("--create needs a terminal to ask in");
  }
}

/** Run the wizard on the terminal; resolves with the new issue, or null when it was cancelled. */
export function runCreate(team: string, project: string | undefined, summary: string): Promise<Created | null> {
  const { input, output, own } = terminal();
  return new Promise((resolve) => {
    let shown = true;
    const leave = () => {
      if (!shown) return;
      shown = false;
      input.setRawMode(false);
      output.write("\x1b[?7h\x1b[?25h\x1b[?1049l");
    };
    const wizard = new CreateWizard(output, team, project, summary, (created) => {
      leave();
      input.pause();
      if (own) {
        input.destroy();
        output.destroy();
      }
      resolve(created);
    });
    // alternate screen, hidden cursor, no line wrapping, keys one by one; undone on any exit
    output.write("\x1b[?1049h\x1b[?25l\x1b[?7l");
    input.setRawMode(true);
    process.on("exit", leave);
    // readline only reads escapeCodeTimeout from its interface argument; 50ms makes esc go back promptly
    emitKeypressEvents(input, { escapeCodeTimeout: 50 } as never);
    input.on("keypress", (str: string | undefined, key: Key | undefined) => {
      void wizard.key(str, key ?? {}).then(() => wizard.draw());
    });
    output.on("resize", () => wizard.draw());
    input.resume();
    wizard.draw();
  });
}
