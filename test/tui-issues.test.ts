// Changing issues from the board: each dialog, the Linear requests it makes, and what the board shows afterwards.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bench, editor, linear, mr, opened } from "./harness.ts";
import { openBoard } from "./tui.ts";

const LAUNCH = { id: "p-launch", name: "Launch", slugId: "launch-1a2b" };

describe("s: status", () => {
  test("moves the issue to the status chosen, typing to filter", async () => {
    const board = await openBoard();
    board.select("PROJ-4");
    await board.press("s");
    expect(board.screen()).toContain("╭─ Move PROJ-4 (now In Progress)");
    // where each status is on the board; canceling comes last
    expect(board.box().slice(1)).toEqual([
      expect.stringMatching(/^Backlog +→ Todo$/), expect.stringMatching(/^Todo +→ Todo$/), expect.stringMatching(/^In Review +→ In Review$/),
      expect.stringMatching(/^Done +→ Done$/), expect.stringMatching(/^Canceled +not on this board$/),
      expect.stringMatching(/^Duplicate +not on this board$/),
    ]);
    await board.type("rev");
    expect(board.screen()).not.toContain("Canceled");
    await board.press("<enter>");
    expect(board.status()).toContain("PROJ-4 is now In Review");
    expect(linear.get("PROJ-4").status).toBe("10");
    expect(board.rows()[4]).toMatch(/IN PROGRESS +1 · 0 pts .* IN REVIEW +2 · 2 pts/);
    expect(board.selected()).toBe("PROJ-4"); // the cursor goes with it
  });

  test("a sub-issue's status changes under its card", async () => {
    const board = await openBoard();
    board.select("PROJ-2");
    await board.press("s");
    await board.type("done");
    await board.press("<enter>");
    expect(board.screen()).toMatch(/PROJ-1 3 pts ▾ 2\/2/);
    expect(board.screen()).toMatch(/↳ PROJ-2 Done/);
  });

  test("a refused change says what Linear said", async () => {
    const board = await openBoard();
    linear.refuse("UpdateIssue", "Issue is locked");
    await board.press("s");
    await board.type("done");
    await board.press("<enter>");
    expect(board.message()).toMatch(/^status change failed: UpdateIssue failed: Issue is locked - details in /);
    expect(linear.get("PROJ-1").status).toBe("1");
  });

  test("esc changes nothing", async () => {
    const board = await openBoard();
    await board.press("s", "<esc>");
    expect(board.screen()).not.toContain("╭─ Move");
    expect(linear.calls("UpdateIssue")).toEqual([]);
  });
});

describe("A: assign", () => {
  test("lists the people on the board, me first, and assigns", async () => {
    const board = await openBoard();
    board.select("PROJ-5");
    await board.press("A");
    expect(board.box().slice(1)).toEqual([
      "Unassigned ✓", expect.stringMatching(/^Jane Doe +me$/), expect.stringMatching(/^Alex Smith +on the board$/),
      expect.stringMatching(/^Bruce Wayne +on the board$/),
    ]);
    await board.press("<down>", "<enter>"); // it starts on me
    expect(board.status()).toContain("PROJ-5 assigned to Alex Smith");
    expect(linear.get("PROJ-5").assignee).toBe("asmith");
    expect(linear.calls("UpdateIssue")[0].variables).toEqual({ id: "id-PROJ-5", input: { assigneeId: "asmith" } });
    expect(board.screen()).toMatch(/PROJ-5 ! \? pts +Alex/);
  });

  test("typing searches everyone in the workspace", async () => {
    const board = await openBoard();
    board.select("PROJ-5");
    await board.press("A");
    await board.type("kent");
    expect(board.screen()).toContain("searching…");
    await board.waitFor(/│ Clark Kent +clark@example\.com │/);
    // once typing paused, not per key
    expect(linear.calls("Users").map((r) => r.variables.filter.or[0].name.containsIgnoreCase)).toEqual(["kent"]);
    await board.press("<enter>");
    expect(board.status()).toContain("PROJ-5 assigned to Clark Kent");
    expect(board.screen()).toMatch(/PROJ-5 ! \? pts +Clark/);
  });

  test("unassigns", async () => {
    const board = await openBoard();
    await board.press("A", "<up>", "<enter>");
    expect(board.status()).toContain("PROJ-1 assigned to nobody");
    expect(linear.get("PROJ-1").assignee).toBeNull();
  });
});

describe("p: estimate", () => {
  test("typing replaces the estimate", async () => {
    const board = await openBoard();
    await board.press("p");
    expect(board.screen()).toMatch(/currently 3 +· +fibonacci: 0 1 2 3 5 8/);
    await board.type("5");
    await board.press("<enter>");
    expect(board.status()).toContain("PROJ-1: estimate 5");
    expect(linear.calls("UpdateIssue")[0].variables.input).toEqual({ estimate: 5 });
    expect(board.rows()[2]).toContain("9/16 pts done");
  });

  test("empty clears it", async () => {
    const board = await openBoard();
    await board.press("p", "<bs>", "<enter>");
    expect(board.status()).toContain("PROJ-1: estimate cleared");
    expect(linear.get("PROJ-1").points).toBeNull();
    expect(board.screen()).toMatch(/PROJ-1 \? pts/);
  });

  test("on a sub-issue it goes on its card", async () => {
    const board = await openBoard();
    board.select("PROJ-2");
    await board.press("p");
    expect(board.screen()).toContain("Estimate of PROJ-1");
  });

  test("only digits are typed, and Linear refuses what the team's scale doesn't have", async () => {
    const board = await openBoard();
    await board.press("p");
    await board.type("x4.");
    await board.press("<enter>");
    expect(board.message()).toMatch(/^saving the estimate failed: UpdateIssue failed: Estimate is not valid for this team's scale/);
    expect(linear.get("PROJ-1").points).toBe(3);
  });

  test("not for a team that doesn't estimate", async () => {
    linear.estimation = "notUsed";
    const board = await openBoard();
    await board.press("p");
    expect(board.status()).toContain("this team does not estimate its issues");
  });
});

describe("!: priority", () => {
  test("chooses one, starting on the current one", async () => {
    const board = await openBoard();
    await board.press("!");
    expect(board.screen()).toContain("╭─ Priority of PROJ-1: Login with SSO");
    expect(board.box().slice(1)).toEqual(["Urgent", "High", "Medium", "Low", "No priority ✓"]);
    await board.type("urg");
    await board.press("<enter>");
    expect(board.status()).toContain("PROJ-1: urgent");
    expect(linear.get("PROJ-1").priority).toBe(1);
    expect(board.screen()).toMatch(/PROJ-1 !! 3 pts/);
  });
});

describe("c: new sub-issues", () => {
  test("creates a sub-issue per line, bullets dropped, in the cycle, and shows them", async () => {
    const board = await openBoard();
    board.select("PROJ-4");
    await board.press("c");
    await board.type("- Reproduce it");
    await board.press("<enter>");
    await board.type("2. Fix it");
    await board.press("<enter>", "<enter>");
    expect(board.screen()).toContain("ctrl+s create 2");
    await board.press("<C-s>");
    expect(board.status()).toContain("created PROJ-100, PROJ-101 under PROJ-4");
    expect(linear.calls("CreateIssue").map((r) => r.variables.input)).toEqual([
      expect.objectContaining({ title: "Reproduce it", parentId: "id-PROJ-4", cycleId: "c12" }),
      expect.objectContaining({ title: "Fix it", parentId: "id-PROJ-4", cycleId: "c12" }),
    ]);
    expect(board.screen()).toMatch(/PROJ-4 !! 2 pts ▾ 0\/2/);
    expect(board.screen()).toMatch(/↳ PROJ-100 Backlog/);
    expect(board.selected()).toBe("PROJ-100");
  });

  test("under a sub-issue, shown under its card", async () => {
    const board = await openBoard();
    board.select("PROJ-2");
    await board.press("c");
    expect(board.screen()).toContain("New sub-issues of PROJ-2");
    await board.type("Deeper");
    await board.press("<C-s>");
    expect(linear.get("PROJ-100").parent).toBe("PROJ-2");
    expect(board.screen()).toMatch(/PROJ-1 3 pts ▾ 1\/3/);
    expect(board.selected()).toBe("PROJ-100");
  });

  test("without cycles they go on the board, not in the backlog", async () => {
    linear.cyclesEnabled = false;
    const board = await openBoard();
    await board.press("c");
    await board.type("Docs");
    await board.press("<C-s>");
    expect(linear.get("PROJ-100")).toMatchObject({ status: "1", cycle: null, project: "p-launch" });
  });

  test("reports the lines Linear refused", async () => {
    const board = await openBoard();
    await board.press("c");
    await board.type("Good one");
    await board.press("<enter>");
    await board.type("FAIL this");
    await board.press("<C-s>");
    expect(board.message()).toContain('created PROJ-100 under PROJ-1 · failed: "FAIL this": CreateIssue failed: Title is invalid');
  });

  test("needs at least one line", async () => {
    const board = await openBoard();
    await board.press("c", "<C-s>");
    expect(board.status()).toContain("type at least one sub-issue, one per line");
  });
});

describe("d: description", () => {
  test("shows the Markdown rendered, and as written with r", async () => {
    const board = await openBoard();
    await board.press("d");
    await board.waitFor("Users sign in with SSO.");
    expect(board.screen()).toContain("╭─ PROJ-1: Login with SSO");
    expect(board.screen()).toContain("Goal");
    expect(board.screen()).not.toContain("# Goal");
    await board.press("r");
    expect(board.screen()).toContain("# Goal");
    expect(board.screen()).toContain("Users sign in with **SSO**.");
    await board.press("q");
    expect(board.screen()).not.toContain("╭─ PROJ-1");
  });

  test("w opens the issue in the browser", async () => {
    const board = await openBoard();
    await board.press("d");
    await board.waitFor("Users sign in with SSO.");
    await board.press("w");
    expect(board.screen()).toContain("opened PROJ-1 in the browser");
    await expect.poll(opened).toEqual(["https://linear.example.com/acme/issue/PROJ-1"]);
  });

  test("e edits it in $EDITOR and saves it to Linear", async () => {
    const board = await openBoard();
    await board.press("d");
    await board.waitFor("Users sign in with SSO.");
    editor.next({ text: "Users sign in with *SAML*.\n\n" });
    await board.press("e");
    expect(editor.seen()).toBe("# Goal\nUsers sign in with **SSO**.\n\n- one\n- two\n");
    expect(linear.get("PROJ-1").description).toBe("Users sign in with *SAML*.");
    await board.press("r"); // redraw
    expect(board.screen()).toContain("saved");
    expect(board.screen()).toContain("Users sign in with *SAML*.");
  });

  test("an editor that fails changes nothing", async () => {
    const board = await openBoard();
    await board.press("d");
    await board.waitFor("Users sign in with SSO.");
    editor.next({ text: "half-written", exit: 1 });
    await board.press("e", "j");
    expect(board.screen()).toContain("did not exit cleanly, the description is unchanged");
    expect(linear.calls("UpdateIssue")).toEqual([]);
  });

  test("an issue without one can get one", async () => {
    const board = await openBoard();
    board.select("PROJ-4");
    await board.press("d");
    await board.waitFor("no description · press e to write one");
    editor.next({ text: "Steps to reproduce" });
    await board.press("e", "j");
    expect(editor.seen()).toBe("");
    expect(linear.get("PROJ-4").description).toBe("Steps to reproduce");
  });
});

describe("S: move to a cycle", () => {
  test("moves an issue with its sub-issues to another cycle", async () => {
    const board = await openBoard();
    board.select("PROJ-2");
    await board.press("S");
    expect(board.screen()).toContain("╭─ Move PROJ-1 (with its sub-issues) to");
    expect(board.box().slice(1)).toEqual([
      expect.stringMatching(/^Cycle 12 ✓ +active · ends \d+ \w+$/), expect.stringMatching(/^Cycle 13 +future · starts \d+ \w+$/),
      expect.stringMatching(/^Backlog +no cycle$/),
    ]);
    await board.press("<enter>"); // it starts on the first cycle it isn't in
    expect(board.status()).toContain("PROJ-1 moved to Cycle 13");
    expect(["PROJ-1", "PROJ-2", "PROJ-3"].map((k) => linear.get(k).cycle)).toEqual(["c13", "c13", "c13"]);
    expect(board.tui.board.keys()).not.toContain("PROJ-1");
    expect(board.rows()[4]).toMatch(/TODO +0 · 0 pts/);
  });

  test("moves an issue out of the cycles, also shown in the backlog tab", async () => {
    const board = await openBoard();
    board.select("PROJ-4");
    await board.press("S");
    await board.type("back");
    await board.press("<enter>");
    expect(board.status()).toContain("PROJ-4 moved to Backlog");
    expect(linear.get("PROJ-4").cycle).toBeNull();
    await board.press("<tab>");
    expect(board.screen()).toContain("PROJ-4");
  });

  test("without cycles, moves between the board and the backlog by status, leaving done sub-issues done", async () => {
    linear.cyclesEnabled = false;
    const board = await openBoard();
    await board.press("S");
    expect(board.box().slice(1)).toEqual([
      expect.stringMatching(/^Project ✓ +the board, as Todo$/), expect.stringMatching(/^Backlog +Backlog$/),
    ]);
    await board.press("<enter>");
    expect(["PROJ-1", "PROJ-2", "PROJ-3"].map((k) => linear.get(k).status)).toEqual(["backlog", "backlog", "10001"]);
    expect(board.tui.board.keys()).not.toContain("PROJ-1");
  });
});

describe("C: new issue", () => {
  test("creates a plain issue in the backlog", async () => {
    const board = await openBoard();
    await board.press("C");
    expect(board.screen()).toContain("╭─ New issue in PROJ");
    await board.waitFor(/ Issue +Feature +Improvement +Bug /); // the kinds load in the background
    await board.type("Export to CSV");
    await board.press("<enter>");
    expect(board.status()).toContain("created PROJ-100 (Issue) in Backlog");
    expect(linear.get("PROJ-100")).toMatchObject({ summary: "Export to CSV", labels: [], cycle: null });
  });

  test("creates a bug with a description in the active cycle, and selects it", async () => {
    const board = await openBoard();
    await board.press("C");
    await board.waitFor(/Issue +Feature +Improvement +Bug/);
    await board.press("<right>", "<right>", "<right>", "<down>");
    await board.waitFor(/where +‹ Cycle 12 › +active/);
    editor.next({ text: "It crashes.\n" });
    await board.press("<C-e>");
    expect(board.screen()).toContain("description: 1 line · ctrl+e to change");
    await board.type("Crash on login");
    await board.press("<enter>");
    expect(board.status()).toContain("created PROJ-100 (Bug) in Cycle 12");
    expect(linear.get("PROJ-100")).toMatchObject({ labels: ["Bug"], cycle: "c12", description: "It crashes." });
    expect(board.selected()).toBe("PROJ-100");
    expect(board.screen()).toMatch(/▌ ▲ PROJ-100/);
  });

  test("on a board of one project, in that project", async () => {
    const board = await openBoard({ project: LAUNCH });
    await board.press("C");
    await board.waitFor("╭─ New issue in PROJ · Launch");
    await board.type("Launch checklist");
    await board.press("<enter>");
    expect(board.status()).toContain("created PROJ-100 (Issue) in Backlog, in Launch");
    expect(linear.get("PROJ-100").project).toBe("p-launch");
  });

  test("without cycles, on the board as Todo", async () => {
    linear.cyclesEnabled = false;
    const board = await openBoard();
    await board.press("C");
    await board.waitFor(/Issue +Feature/);
    await board.press("<down>");
    expect(board.screen()).toMatch(/where +‹ Project › +the board, as Todo/);
    await board.type("Write docs");
    await board.press("<enter>");
    expect(linear.get("PROJ-100")).toMatchObject({ status: "1", cycle: null });
    expect(board.selected()).toBe("PROJ-100");
  });

  test("needs a summary", async () => {
    const board = await openBoard();
    await board.press("C");
    await board.waitFor(/Issue +Feature/);
    await board.press("<enter>");
    expect(board.screen()).toContain("type a summary first");
    expect(linear.calls("CreateIssue")).toEqual([]);
  });
});

describe("projects", () => {
  test("f shows only one project's issues, in every tab, and all again", async () => {
    const board = await openBoard();
    await board.press("f");
    await board.waitFor("Launch");
    expect(board.box().slice(1)).toEqual([
      expect.stringMatching(/^All of PROJ ✓ +every project, and none$/), "Billing", "Launch",
    ]);
    await board.type("lau");
    await board.press("<enter>");
    expect(board.status()).toContain("only Launch · f to show all");
    expect(board.rows()[2]).toMatch(/Cycle 12 +· +Launch/);
    expect(board.tui.board.keys()).toEqual(["PROJ-1", "PROJ-2"]);
    await board.press("<tab>");
    expect(board.tui.board.keys()).toEqual(["PROJ-40"]);

    await board.press("f");
    await board.waitFor("Billing");
    await board.press("<up>", "<up>", "<enter>");
    expect(board.status()).toContain("all of PROJ");
    expect(board.tui.board.keys()).toContain("PROJ-41");
  });

  test("P moves an issue to another project, leaving a board of the one it was in", async () => {
    const board = await openBoard({ project: LAUNCH });
    await board.press("P");
    await board.waitFor("Billing");
    expect(board.box().slice(1)).toEqual(["No project", "Billing", "Launch ✓"]);
    await board.type("bil");
    await board.press("<enter>");
    expect(board.status()).toContain("PROJ-1 is in Billing");
    expect(linear.get("PROJ-1").project).toBe("p-billing");
    expect(board.tui.board.keys()).toEqual(["PROJ-2"]);
  });
});

describe("n: notifications", () => {
  const handledFile = () => join(process.env.XDG_STATE_HOME!, "lboard", "handled.json");

  test("a merged merge request of an issue that isn't done shows on the bell, and n moves the issue to done", async () => {
    const board = await openBoard();
    board.tui.showBenches();
    await board.waitFor("PROJ-4: !12 was merged · press n to move it to done");
    expect(board.rows()[0]).toMatch(/🔔 1$/);
    expect(board.screen()).toMatch(/PROJ-4 !! ⎇ !12/);

    await board.press("n");
    expect(board.screen()).toContain("╭─ Merged (1)");
    expect(board.screen()).toMatch(/PROJ-4  !12 merged +now In Progress → Done/);
    await board.press("<enter>");
    expect(linear.get("PROJ-4").status).toBe("10001");
    expect(board.status()).toContain("PROJ-4 is now Done");
    expect(board.screen()).not.toContain("╭─ Merged");
    expect(board.rows()[0]).toMatch(/🔔$/);
    expect(JSON.parse(readFileSync(handledFile(), "utf8"))).toEqual(["PROJ-4 https://gitlab.example.com/web/-/merge_requests/12"]);
  });

  /** Only these merged merge requests, not PROJ-4's from the fixture. */
  const merged = (...benches: [string, string][]) => bench.set((s) => {
    s.benches[0].mr = null;
    for (const [branch, id] of benches) s.benches.push({ repo: "web", branch, path: `/benches/${branch}`, mr: mr(id, "merged", branch) });
  });

  test("x dismisses one, o opens its merge request", async () => {
    merged(["feat/PROJ-5-upgrade-node", "!21"], ["feat/PROJ-2-saml", "!22"]);
    const board = await openBoard();
    board.tui.showBenches();
    await board.waitFor("2 merge requests were merged · press n");
    await board.press("n");
    expect(board.screen()).toMatch(/PROJ-2  !22 merged +now Todo → Done[^]*PROJ-5  !21 merged +now In Review → Done/);
    await board.press("x");
    expect(board.screen()).toContain("dismissed PROJ-2");
    expect(board.screen()).toContain("╭─ Merged (1)");
    await board.press("o");
    expect(board.screen()).toContain("opened !21 in the browser");
    await expect.poll(opened).toEqual(["https://gitlab.example.com/web/-/merge_requests/21"]);
    await board.press("x"); // the last one
    expect(board.screen()).not.toContain("╭─ Merged");
    expect(board.status()).toContain("dismissed PROJ-5");
    expect(linear.calls("UpdateIssue")).toEqual([]);
  });

  test("a move Linear refuses keeps the notification", async () => {
    merged(["feat/PROJ-5-upgrade-node", "!31"]);
    const board = await openBoard();
    board.tui.showBenches();
    await board.waitFor("PROJ-5: !31 was merged");
    linear.refuse("UpdateIssue", "Issue is locked");
    await board.press("n", "<enter>");
    expect(board.screen()).toContain("moving PROJ-5 failed: UpdateIssue failed: Issue is locked");
    expect(board.tui.notifications()).toHaveLength(1);
  });
});
