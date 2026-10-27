// lboard --create: the wizard that creates one issue for another tool (e.g. punch), driven with key presses like
// the board, against the fake Linear. What it draws is read back as plain text.

import { describe, expect, test, vi } from "vitest";
import { TEAM } from "./fakes/linear.ts";
import { linear } from "./harness.ts";
import { CreateWizard, type Created } from "../src/tui/wizard.ts";
import type { Key } from "../src/tui/dialog.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const NAMED: Record<string, [string | undefined, Key]> = {
  "<enter>": ["\r", { name: "return" }], "<esc>": ["\x1b", { name: "escape" }], "<bs>": ["\x7f", { name: "backspace" }],
  "<up>": [undefined, { name: "up" }], "<down>": [undefined, { name: "down" }], "<C-u>": [undefined, { name: "u", ctrl: true }],
};

/** The wizard as `lboard --create` opens it, with what it draws kept, and how it finished. */
function open(summary: string, project?: string) {
  const frames: string[] = [];
  let result: Created | null | undefined;
  const wizard = new CreateWizard({ columns: 100, rows: 30, write: (s: string) => frames.push(s) }, TEAM, project, summary,
    (created) => (result = created));
  const screen = () => stripAnsi((frames.at(-1) ?? "").split(/\x1b\[\d+;1H/).join("\n"));
  return {
    wizard,
    screen,
    /** How it finished: the new issue, null when cancelled, undefined while still open. */
    result: () => result,
    async press(...keys: string[]) {
      for (const spec of keys) {
        const [str, key] = NAMED[spec] ?? [spec, { name: spec.toLowerCase() }];
        await wizard.key(str, key);
        wizard.draw();
      }
    },
    async waitFor(text: string | RegExp) {
      await vi.waitFor(() => {
        if (typeof text === "string") expect(screen()).toContain(text);
        else expect(screen()).toMatch(text);
      }, { timeout: 5000, interval: 10 });
    },
  };
}

describe("lboard --create", () => {
  test("goes through project, type, where and summary, and creates the issue there", async () => {
    const w = open("Export  the report to CSV ");
    await w.waitFor("╭─ New issue in PROJ");
    expect(w.screen()).toMatch(/ Project  › Type › Where › Summary/);
    expect(w.screen()).toMatch(/No project[^]*Billing[^]*Launch/);
    expect(w.screen()).not.toContain("Old stuff"); // completed

    await w.press("j", "j", "<enter>"); // Launch
    expect(w.screen()).toMatch(/Launch ›  Type  › Where › Summary/);
    expect(w.screen()).toContain("╭─ New issue in PROJ · Launch");
    expect(w.screen()).toMatch(/Issue[^]*Feature[^]*Improvement[^]*Bug/);

    await w.press("j", "j", "j", "<enter>"); // Bug
    expect(w.screen()).toMatch(/Bug ›  Where  › Summary/);
    expect(w.screen()).toMatch(/Backlog +no cycle/);
    expect(w.screen()).toMatch(/Cycle 12 +active/);

    await w.press("<down>", "<enter>"); // Cycle 12
    expect(w.screen()).toMatch(/Bug › Cycle 12 ›  Summary/);
    expect(w.screen()).toContain("› Export the report to CSV█"); // typed in already, spaces tidied
    expect(w.screen()).toContain("Bug in Cycle 12");

    await w.press("<bs>", "<bs>", "<bs>", "c", "s", "v", "<enter>");
    expect(w.result()).toEqual({ key: "PROJ-100", warning: "" });
    expect(linear.get("PROJ-100")).toMatchObject({ summary: "Export the report to csv", labels: ["Bug"], cycle: "c12", project: "p-launch" });
  });

  test("creates a plain issue in the backlog with enter, enter, enter, enter", async () => {
    const w = open("Search filters");
    await w.waitFor("Billing");
    await w.press("<enter>", "<enter>", "<enter>", "<enter>");
    expect(w.result()).toEqual({ key: "PROJ-100", warning: "" });
    expect(linear.get("PROJ-100")).toMatchObject({ labels: [], cycle: null, project: null });
  });

  test("starts on the project asked for, e.g. the config's", async () => {
    const w = open("Rotate keys", "billing");
    await w.waitFor("Billing");
    await w.press("<enter>", "<enter>", "<enter>", "<enter>");
    expect(linear.get("PROJ-100").project).toBe("p-billing");
  });

  test("without cycles: the backlog or the board", async () => {
    linear.cyclesEnabled = false;
    const w = open("Write docs");
    await w.waitFor("Billing");
    await w.press("<enter>", "<enter>");
    expect(w.screen()).toMatch(/Backlog +Backlog/);
    expect(w.screen()).toMatch(/Project +the board, as Todo/);
    await w.press("<down>", "<enter>", "<enter>");
    expect(linear.get("PROJ-100")).toMatchObject({ status: "1", cycle: null });
  });

  test("goes back a step with esc, and is cancelled by esc on the first", async () => {
    const w = open("Something");
    await w.waitFor("Billing");
    await w.press("<enter>", "<enter>", "<enter>");
    expect(w.screen()).toContain("Summary ");
    await w.press("<esc>");
    expect(w.screen()).toMatch(/ Where /);
    await w.press("<esc>", "<esc>", "<esc>");
    expect(w.result()).toBeNull();
    expect(linear.calls("CreateIssue")).toEqual([]);
  });

  test("skips the project when the team has none", async () => {
    linear.projects = [];
    const w = open("Rotate keys");
    await w.waitFor(/ Type  › Where › Summary/);
    await w.press("<enter>", "<enter>", "<enter>");
    expect(w.result()?.key).toBe("PROJ-100");
  });

  test("needs a summary", async () => {
    const w = open("");
    await w.waitFor("Billing");
    await w.press("<enter>", "<enter>", "<enter>", "<enter>");
    expect(w.screen()).toContain("type a summary first");
    await w.press("<C-u>", "F", "i", "x", "<enter>");
    expect(w.result()?.key).toBe("PROJ-100");
  });

  test("stays open when Linear refuses, to try again or go back", async () => {
    const w = open("FAIL on purpose");
    await w.waitFor("Billing");
    await w.press("<enter>", "<enter>", "<enter>", "<enter>");
    expect(w.screen()).toContain("creating the issue failed: CreateIssue failed: Title is invalid");
    expect(w.result()).toBeUndefined();
  });

  test("an unknown team is reported", async () => {
    const w = new CreateWizard({ columns: 100, rows: 30, write: () => {} }, "NOPE", undefined, "x", () => {});
    await vi.waitFor(() => expect(w.status).toContain("loading team NOPE failed: no team NOPE"));
  });
});
