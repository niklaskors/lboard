// The interactive board: what it shows, moving around, views, search, tabs and refreshing.

import { describe, expect, test } from "vitest";
import { linear, opened } from "./harness.ts";
import { openBoard } from "./tui.ts";

describe("the board", () => {
  test("shows the cycle's columns with their cards, the first card selected", async () => {
    const board = await openBoard();
    const [tabs, , header, , columns] = board.rows();
    expect(tabs).toMatch(/^ Cycle 12 +Backlog +🔔$/);
    expect(header).toMatch(/Cycle 12 +ends \d+ \w+ · 10d left +━+ +9\/14 pts done +10 cards/);
    expect(columns).toMatch(/TODO +1 · 3 pts +● IN PROGRESS +2 · 2 pts +● IN REVIEW +1 · 0 pts +● DONE +6 · 9 pts/);
    expect(board.screen()).toMatch(/▌ ● PROJ-1 3 pts ▸ 1\/2 +Jane/); // the selected card's bar is thicker
    expect(board.screen()).toMatch(/▎ ▲ PROJ-4 !! 2 pts +Alex/); // a bug of urgent priority
    expect(board.screen()).toContain("+1 more · press a");
    expect(board.status()).toMatch(/^\?  keys +\/  search +n  notifications/);
    expect(board.selected()).toBe("PROJ-1");
  });

  test("moves between columns and cards", async () => {
    const board = await openBoard();
    await board.press("l");
    expect(board.selected()).toBe("PROJ-4");
    await board.press("j");
    expect(board.selected()).toBe("PROJ-9");
    await board.press("j"); // stays on the last card
    expect(board.selected()).toBe("PROJ-9");
    await board.press("<right>", "<right>", "G");
    expect(board.selected()).toBe("PROJ-20");
    await board.press("g");
    expect(board.selected()).toBe("PROJ-26");
    await board.press("<left>", "<up>", "h", "h", "h");
    expect(board.selected()).toBe("PROJ-1");
  });

  test("scrolls a long column to keep the selected card in view", async () => {
    const board = await openBoard({ height: 16 });
    await board.press("l", "l", "l");
    expect(board.screen()).not.toContain("PROJ-20");
    expect(board.rows()[5]).toMatch(/─↓─$/);
    await board.press("G");
    expect(board.screen()).toContain("PROJ-20");
    expect(board.screen()).not.toContain("PROJ-26");
    expect(board.rows()[5]).toMatch(/↑$/);
    await board.press("<C-u>"); // half of 9 rows is one card of 3
    expect(board.selected()).toBe("PROJ-21");
    await board.press("<C-d>");
    expect(board.selected()).toBe("PROJ-20");
  });

  test("shows and hides an issue's sub-issues", async () => {
    const board = await openBoard();
    await board.press("<enter>");
    expect(board.screen()).toMatch(/PROJ-1 3 pts ▾ 1\/2/);
    expect(board.screen()).toMatch(/↳ PROJ-2 Todo +Jane/);
    expect(board.screen()).toMatch(/↳ PROJ-3 Done +Alex/);
    await board.press("j");
    expect(board.selected()).toBe("PROJ-2");
    await board.press("<space>"); // on a sub-issue: its card closes
    expect(board.screen()).not.toContain("↳ PROJ-2");
    expect(board.selected()).toBe("PROJ-1");

    await board.press("l", "<enter>");
    expect(board.status()).toContain("PROJ-4 has no sub-issues on this board");
  });

  test("e shows and hides all sub-issues", async () => {
    const board = await openBoard();
    await board.press("e");
    expect(board.screen()).toContain("↳ PROJ-2");
    await board.press("e");
    expect(board.screen()).not.toContain("↳ PROJ-2");
  });

  test("m shows only my cards", async () => {
    const board = await openBoard();
    await board.press("l", "m");
    expect(board.rows()[2]).toMatch(/3 cards  · mine$/);
    expect(board.screen()).not.toContain("PROJ-4");
    expect(board.selected()).toBe("PROJ-9");
    await board.press("m");
    expect(board.screen()).toContain("PROJ-4");
    expect(board.selected()).toBe("PROJ-9");
  });

  test("leaves out a hideEmpty column while it has no cards", async () => {
    const board = await openBoard({ hideEmpty: ["in review"] });
    expect(board.rows()[4]).toContain("REVIEW");
    await board.press("m"); // none of the review cards are mine
    expect(board.rows()[4]).toMatch(/TODO +1 · 3 pts +● IN PROGRESS +1 · 0 pts +● DONE +1 · 2 pts/);
    await board.press("l", "l"); // from in progress straight to done
    expect(board.selected()).toBe("PROJ-21");
    await board.press("m");
    expect(board.rows()[4]).toContain("REVIEW");
  });

  test("marks urgent and high priority issues", async () => {
    const board = await openBoard();
    expect(board.screen()).toMatch(/PROJ-4 !! 2 pts/);
    expect(board.screen()).toMatch(/■ PROJ-5 ! \? pts +-/); // an improvement of high priority, without an estimate or assignee
    expect(board.screen()).toMatch(/PROJ-1 3 pts/); // the others say nothing
    await board.press("v");
    expect(board.screen()).toMatch(/PROJ-4 !! Crash on empty board/);
  });

  test("a shows all done cards", async () => {
    const board = await openBoard();
    await board.press("a");
    expect(board.screen()).toContain("PROJ-6");
    expect(board.screen()).not.toContain("more · press a");
    await board.press("a");
    expect(board.screen()).not.toContain("PROJ-6");
  });

  test("v shows a line per issue instead of cards", async () => {
    const board = await openBoard({ width: 240 }); // room for points and names in a line
    await board.press("v");
    expect(board.screen()).toMatch(/● PROJ-1 ▸ Login with SSO +3 pts +Jane/);
    await board.press("<enter>");
    expect(board.screen()).toMatch(/↳ PROJ-2 Todo Add SAML config +Jane/);
    await board.press("v");
    expect(board.screen()).toMatch(/PROJ-1 3 pts ▾ 1\/2/);
  });

  test("? lists the keys", async () => {
    const board = await openBoard();
    await board.press("?");
    expect(board.screen()).toContain("╭─ Keys");
    expect(board.screen()).toMatch(/s +change status/);
    await board.press("<esc>");
    expect(board.screen()).not.toContain("╭─ Keys");
  });

  test("o and w open the issue and the board in the browser", async () => {
    const board = await openBoard();
    await board.press("l", "o");
    expect(board.status()).toContain("opened PROJ-4 in browser");
    await board.press("w");
    expect(board.status()).toContain("opened the board in the browser · press r to reload here");
    await expect.poll(() => opened().sort()).toEqual([
      "https://linear.example.com/acme/issue/PROJ-4", "https://linear.example.com/acme/team/PROJ/cycle/active",
    ]);
  });
});

describe("search", () => {
  test("jumps to matches by key or summary as you type, opening a card to show its sub-issue", async () => {
    const board = await openBoard();
    await board.press("/");
    expect(board.status()).toContain("type a key or part of a summary");
    await board.type("saml");
    expect(board.selected()).toBe("PROJ-2");
    expect(board.screen()).toContain("↳ PROJ-2");
    expect(board.status()).toMatch(/\/ +saml█ +1\/1/);
    await board.press("<bs>", "<bs>", "<bs>", "<bs>");
    await board.type("proj-2");
    expect(board.selected()).toBe("PROJ-2");
    expect(board.status()).toMatch(/1\/6/); // PROJ-2, PROJ-20 … PROJ-23, PROJ-26
    await board.press("<C-n>");
    expect(board.selected()).toBe("PROJ-26");
    expect(board.screen()).not.toContain("↳ PROJ-2"); // the card opened for the last match closes again
  });

  test("enter keeps the match, and ctrl+n / ctrl+p go on from there", async () => {
    const board = await openBoard();
    await board.press("/");
    await board.type("crash");
    await board.press("<enter>");
    expect(board.selected()).toBe("PROJ-4");
    expect(board.status()).not.toContain("crash");
    await board.press("<C-n>");
    expect(board.status()).toContain('1/1 for "crash"');
  });

  test("esc goes back to where the search started", async () => {
    const board = await openBoard();
    await board.press("l", "/");
    await board.type("dark");
    expect(board.status()).toContain("no match"); // PROJ-6 is a hidden done card
    await board.press("<bs>", "<bs>", "<bs>", "<bs>");
    await board.type("tests");
    expect(board.selected()).toBe("PROJ-3");
    await board.press("<esc>");
    expect(board.selected()).toBe("PROJ-4");
    expect(board.screen()).not.toContain("↳ PROJ-3");
  });
});

describe("cycles and the backlog", () => {
  test("tab shows the next cycle and the backlog, loading each the first time", async () => {
    const board = await openBoard();
    board.tui.loadTabs();
    board.tui.draw();
    expect(board.rows()[0]).toMatch(/^ Cycle 12 +Cycle 13 +Backlog/);

    await board.press("<tab>");
    expect(board.rows()[2]).toMatch(/Cycle 13 +starts \d+ \w+/);
    expect(board.screen()).toContain("PROJ-30");
    expect(board.screen()).not.toContain("PROJ-1 ");

    await board.press("<tab>");
    // the backlog is one list, without what is done
    expect(board.rows()[4]).toMatch(/BACKLOG +2 · 3 pts/);
    expect(board.screen()).toMatch(/● PROJ-40 ▸ Search filters +3 pts +-/);
    expect(board.screen()).toMatch(/▲ PROJ-41 Typo in footer +\? pts +Bruce/);
    expect(board.screen()).not.toContain("PROJ-42");

    await board.press("<tab>", "<tab>", "<tab>");
    expect(linear.calls("BoardIssues")).toHaveLength(3); // each tab once
  });

  test("a team without cycles has its board and its backlog as tabs", async () => {
    linear.cyclesEnabled = false;
    const board = await openBoard();
    board.tui.loadTabs();
    board.tui.draw();
    expect(board.rows()[0]).toMatch(/^ Project +Backlog/);
    expect(board.rows()[2]).toMatch(/Project +━+/);
    expect(board.screen()).toContain("PROJ-30");
    await board.press("<tab>");
    expect(board.screen()).toContain("PROJ-40");
    expect(board.screen()).not.toContain("PROJ-41");
    await board.press("w");
    await expect.poll(() => opened()).toEqual(["https://linear.example.com/acme/team/PROJ/backlog"]);
  });

  test("coming back to a tab puts the cursor where it was", async () => {
    const board = await openBoard();
    await board.press("l", "j", "<tab>", "<S-tab>");
    expect(board.selected()).toBe("PROJ-9");
  });

  test("a tab that fails to load is not shown", async () => {
    const board = await openBoard();
    linear.fail("BoardIssues", 500, { errors: [{ message: "Backlog unavailable" }] });
    await board.press("<tab>");
    expect(board.status()).toContain("loading the backlog failed: HTTP 500 on BoardIssues: Backlog unavailable");
    expect(board.rows()[2]).toContain("Cycle 12");
    await board.press("<tab>");
    expect(board.screen()).toContain("PROJ-40");
  });
});

describe("refreshing", () => {
  test("r loads the board again", async () => {
    const board = await openBoard();
    linear.get("PROJ-1").summary = "Login with SAML";
    linear.get("PROJ-5").status = "10001";
    await board.press("r");
    expect(board.status()).toContain("refreshed");
    expect(board.screen()).toContain("Login with SAML");
    expect(board.rows()[4]).toMatch(/IN REVIEW +0 · 0 pts/);
  });

  test("a failed refresh keeps the board as it was", async () => {
    const board = await openBoard();
    linear.get("PROJ-1").summary = "Login with SAML";
    linear.fail("BoardIssues", 500, { errors: [{ message: "Down for maintenance" }] });
    await board.press("r");
    expect(board.status()).toContain("refresh failed: HTTP 500");
    expect(board.status()).toContain("Down for maintenance");
    expect(board.screen()).toContain("Login with SSO");
  });

  test("every half hour the board loads again in the background, keeping the cursor and the status line", async () => {
    const board = await openBoard();
    await board.press("l");
    board.tui.msg = "PROJ-4: moved";
    linear.get("PROJ-1").summary = "Login with SAML";
    await board.tui.refreshInBackground();
    expect(board.screen()).toContain("Login with SAML");
    expect(board.selected()).toBe("PROJ-4");
    expect(board.status()).toContain("PROJ-4: moved");
  });

  test("the timed refresh waits while a description is open", async () => {
    const board = await openBoard();
    await board.press("d");
    await board.waitFor("Users sign in with SSO.");
    linear.get("PROJ-1").summary = "Login with SAML";
    await board.tui.refreshInBackground();
    expect(board.screen()).toContain("Users sign in with SSO.");
    expect(linear.calls("BoardIssues")).toHaveLength(1); // only the first load
    await board.press("<esc>");
    expect(board.screen()).toContain("Login with SSO");
    await board.tui.refreshInBackground(); // the retry a minute later
    expect(board.screen()).toContain("Login with SAML");
  });

  test("the timed refresh is dropped when a key comes in while it loads", async () => {
    const board = await openBoard();
    linear.get("PROJ-1").summary = "Login with SAML";
    const refresh = board.tui.refreshInBackground();
    await board.press("d"); // the description opens on the card as it was
    await refresh;
    await board.press("<esc>");
    expect(board.screen()).toContain("Login with SSO");
    await board.tui.refreshInBackground();
    expect(board.screen()).toContain("Login with SAML");
  });

  test("a failed timed refresh is quiet and keeps the board", async () => {
    const board = await openBoard();
    linear.get("PROJ-1").summary = "Login with SAML";
    linear.fail("BoardIssues", 500);
    await board.tui.refreshInBackground();
    expect(board.screen()).toContain("Login with SSO");
    expect(board.status()).not.toContain("failed");
  });

  test("mentions a new lboard in the status line until a key is pressed, without hiding another message", async () => {
    const board = await openBoard();
    board.tui.showUpdate(0);
    expect(board.status()).toMatch(/^\?  keys/);
    board.tui.showUpdate(3);
    expect(board.status()).toContain("a new lboard is out (3 changes): quit and run lboard --update");
    await board.press("j");
    expect(board.status()).toMatch(/^\?  keys/);

    board.tui.msg = "PROJ-1 is now Done";
    board.tui.showUpdate(1);
    expect(board.tui.msg).toBe("PROJ-1 is now Done");
  });
});
