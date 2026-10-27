// `c`: create sub-issues under an issue from a typed or pasted list.

import { createSubIssues, places } from "../linear/api.ts";
import type { Card, Issue } from "../linear/types.ts";
import type { Item } from "../render/layout.ts";
import { shorten, type Line, type Segment } from "../render/line.ts";
import { boxInner, drawBox, isTyping, type BoxRow, type Dialog, type DialogHost, type Key } from "./dialog.ts";

/** Titles from a typed or pasted list: one per line, bullets/numbering and blank lines dropped. */
export function subtaskSummaries(lines: string[]): string[] {
  return lines.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean);
}

class SubtasksDialog implements Dialog {
  host: DialogHost;
  parent: Issue;
  /** The card it is on, which shows the new ones. */
  card: Card;
  lines = [""];

  constructor(host: DialogHost, parent: Issue, card: Card) {
    this.host = host;
    this.parent = parent;
    this.card = card;
  }

  async key(str: string | undefined, key: Key): Promise<void> {
    const last = this.lines.length - 1;
    if (key.name === "escape") {
      this.host.close();
    } else if (key.ctrl && (key.name === "s" || key.name === "d")) {
      await this.create();
    } else if (key.name === "return" || key.name === "enter") {
      this.lines.push(""); // pasted lists arrive as text + return, one line each
    } else if (key.name === "backspace") {
      if (this.lines[last]) this.lines[last] = this.lines[last].slice(0, -1);
      else if (last > 0) this.lines.pop();
    } else if (isTyping(str, key)) {
      this.lines[last] += str;
    }
  }

  async create(): Promise<void> {
    const summaries = subtaskSummaries(this.lines);
    if (!summaries.length) {
      this.host.msg = "type at least one sub-issue, one per line";
      return;
    }
    const { host, parent } = this;
    const { board } = host;
    // on the board they are shown on: in its cycle, or for a team without cycles on its board rather than the backlog
    const here = board.teamInfo ? places(board.teamInfo).find((p) => p.id === board.sprint.id) : undefined;
    const more = here && board.kind === "sprint" ? { ...here.input, cycleId: here.input.cycleId ?? undefined } : {};
    await host.perform(`creating ${summaries.length} sub-issue(s) under ${parent.key}…`, async () => {
      const { created, failed } = await createSubIssues(parent, board.teamId, summaries, more);
      if (created.length) {
        await host.board.reload(); // new sub-issues need their fields from Linear
        host.expand(this.card.key);
        host.focus(created[0], parent.key, this.card.key);
      }
      return (created.length ? `created ${created.join(", ")} under ${parent.key}` : "nothing created")
        + (failed.length ? ` · failed: ${failed.map((f) => `"${shorten(f.summary, 30)}": ${f.reason}`).join("; ")}` : "");
    }, (message) => `creating sub-issues failed: ${message}`);
  }

  draw(rows: Line[]): void {
    const inner = boxInner(this.host.width);
    const count = subtaskSummaries(this.lines).length;
    const visible = Math.max(1, Math.min(12, this.host.height - 10));
    const shown = this.lines.slice(-visible); // keep the line being typed in view
    const body: BoxRow[] = [{ line: [["one sub-issue per line · paste a list · bullets are ignored", "dim"]] }, "rule"];
    if (this.lines.length > visible) body.push({ line: [[`… ${this.lines.length - visible} more above`, "dim"]] });
    shown.forEach((text, i) => {
      const isLast = i === shown.length - 1;
      // show the end of a long line while it is being typed
      const visibleText = isLast && text.length > inner - 3 ? `…${text.slice(-(inner - 4))}` : text;
      body.push({ line: [["• ", "dim"], [visibleText, null], ...(isLast ? [["█", "dim"] as Segment] : [])] });
    });
    drawBox(rows, this.host, `New sub-issues of ${this.parent.key}: ${this.parent.fields.summary}`, body,
      `⏎ new line · ctrl+s create ${count} · esc cancel`);
  }
}

/** Sub-issues of the selected issue, also of a sub-issue: Linear nests them. */
export const openSubtasks = (host: DialogHost, item: Item): Dialog => new SubtasksDialog(host, item.issue, item.parent ?? (item.issue as Card));
