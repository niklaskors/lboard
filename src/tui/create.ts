// `C`: create an issue: a plain one, or a feature, improvement or bug (a label); in the backlog, a cycle or, for a
// team without cycles, on its board. On a board of one project, it goes in that project.

import { createIssue, issueTypes, places, type IssueType, type Place } from "../linear/api.ts";
import { shorten, type Line, type Segment } from "../render/line.ts";
import { EDITOR, editInEditor } from "./description.ts";
import { boxInner, drawBox, isTyping, type BoxRow, type Dialog, type DialogHost, type Key } from "./dialog.ts";

const SHAPE = { max: 80, pad: 2, padY: 1 };

class CreateDialog implements Dialog {
  host: DialogHost;
  types: IssueType[] = [];
  type = 0;
  /** The backlog, then the cycles or the board; the backlog is the default. */
  places: Place[];
  place = 0;
  summary = "";
  description = "";
  status = "loading issue types…";

  constructor(host: DialogHost) {
    this.host = host;
    this.places = host.board.teamInfo ? places(host.board.teamInfo) : [];
    issueTypes(host.board.teamId).then((types) => {
      this.types = types;
      this.status = "";
    }).catch((e: Error) => {
      this.status = `loading issue types failed: ${e.message}`;
    }).then(() => {
      if (host.dialog === this) host.draw();
    });
  }

  async key(str: string | undefined, key: Key): Promise<void> {
    const ready = this.types.length > 0;
    if (key.name === "escape") return this.host.close();
    if (!ready) return;
    this.status = "";
    if (key.name === "tab" || key.name === "right" || key.name === "left") {
      const d = key.name === "left" || key.shift ? -1 : 1;
      this.type = (this.type + d + this.types.length) % this.types.length;
    } else if (key.name === "up" || key.name === "down") {
      const d = key.name === "up" ? -1 : 1;
      this.place = (this.place + d + this.places.length) % Math.max(1, this.places.length);
    } else if (key.name === "return" || key.name === "enter" || (key.ctrl && key.name === "s")) await this.create();
    else if (key.ctrl && key.name === "e") this.editDescription();
    else if (key.name === "backspace") this.summary = this.summary.slice(0, -1);
    else if (isTyping(str, key)) this.summary += str;
  }

  editDescription(): void {
    const edited = editInEditor(this.host, "new-issue", this.description);
    if (edited === null) this.status = `${EDITOR} did not exit cleanly, the description is unchanged`;
    else {
      this.description = edited.replace(/\s+$/, "");
      this.status = "";
    }
  }

  async create(): Promise<void> {
    const summary = this.summary.trim();
    if (!summary) {
      this.status = "type a summary first";
      return;
    }
    const { board } = this.host;
    const type = this.types[this.type];
    const place = this.places[this.place];
    const kind = type.name.toLowerCase();
    const where = place?.name ?? "the backlog";
    await this.host.perform(`creating ${kind === "issue" ? "an issue" : `a ${kind}`} in ${where}…`, async () => {
      const key = await createIssue({
        teamId: board.teamId, title: summary, description: this.description,
        labelIds: type.id ? [type.id] : [],
        ...board.project ? { projectId: board.project.id } : {},
        ...place?.input.cycleId ? { cycleId: place.input.cycleId } : {},
        ...place?.input.stateId ? { stateId: place.input.stateId } : {},
      });
      await this.host.reload(); // shows it where it went, when that is shown
      this.host.focus(key);
      return `created ${key} (${type.name}) in ${where}${board.project ? `, in ${board.project.name}` : ""}`;
    }, (message) => `creating the ${kind} failed: ${message}`);
  }

  draw(rows: Line[]): void {
    const inner = boxInner(this.host.width, SHAPE);
    const tabs: Line = [];
    this.types.forEach((t, i) => tabs.push(...(i ? [["  ", null] as Segment] : []), [` ${t.name} `, i === this.type ? "rev" : "dim"]));
    // show the end of a long summary while it is being typed
    const summary = this.summary.length > inner - 3 ? `…${this.summary.slice(-(inner - 4))}` : this.summary;
    const lines = this.description ? this.description.split("\n").length : 0;
    const place = this.places[this.place];
    const body: BoxRow[] = [
      { line: tabs.length ? tabs : [[this.status, "dim"]] },
      "rule",
      { line: [["› ", "dim"], [summary, null], ["█", "dim"]] },
      { line: [] },
      { line: [["where   ", "dim"], ["‹ ", "dim"], [place?.name ?? "Backlog", place?.id !== "backlog" ? "accent" : null], [" ›", "dim"],
        [place ? `  ${place.note}` : "", "dim"]] },
      { line: [[lines ? `description: ${lines} line${lines === 1 ? "" : "s"} · ctrl+e to change` : "no description · ctrl+e to write one in " + EDITOR.split(" ")[0], "dim"]] },
    ];
    if (tabs.length && this.status) body.push("rule", { line: [[shorten(this.status, inner), "dim"]] });
    const { team, project } = this.host.board;
    drawBox(rows, this.host, `New issue in ${team}${project ? ` · ${project.name}` : ""}`, body,
      "←→ type · ↑↓ where · ⏎ create · ctrl+e description · esc cancel", SHAPE);
  }
}

export const openCreate = (host: DialogHost): Dialog => new CreateDialog(host);
