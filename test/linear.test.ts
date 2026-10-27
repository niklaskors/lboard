// lboard's Linear client and operations against the fake Linear: what they send, and how they handle Linear's errors.

import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Board } from "../src/board.ts";
import {
  assignIssue, createIssue, createSubIssues, findProject, issueTypes, loadDescription, loadTeam, moveToCycle, places,
  searchUsers, teamProjects, transitionIssue, updateIssue,
} from "../src/linear/api.ts";
import { gql, LinearError, LinearUnanswered, setTimings } from "../src/linear/client.ts";
import { TEAM, TEAM_ID } from "./fakes/linear.ts";
import { errorLog, linear } from "./harness.ts";

const loadBoard = async (board = new Board(TEAM)) => {
  await board.reload();
  return board;
};

describe("the client", () => {
  test("sends the operation by name, with its variables", async () => {
    await transitionIssue("id-PROJ-1", "3");
    expect(linear.calls("UpdateIssue")[0].variables).toEqual({ id: "id-PROJ-1", input: { stateId: "3" } });
    expect(linear.get("PROJ-1").status).toBe("3");
  });

  test("retries what proxies fail intermittently, waiting as long as Retry-After says", async () => {
    linear.fail("Description", 503, {}, { times: 2, headers: { "Retry-After": "0" } });
    linear.get("PROJ-1").description = "hello";
    expect(await loadDescription("id-PROJ-1")).toBe("hello");
    expect(linear.calls("Description")).toHaveLength(3);
  });

  test("retries when Linear says to slow down", async () => {
    linear.fail("Description", 400, { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] },
      { headers: { "Retry-After": "0" } });
    expect(await loadDescription("id-PROJ-5")).toBe("");
    expect(linear.calls("Description")).toHaveLength(2);
  });

  test("gives up after three attempts, with Linear's message", async () => {
    linear.fail("Description", 503, { errors: [{ message: "Service unavailable" }] }, { times: 3, headers: { "Retry-After": "0" } });
    const error = await loadDescription("id-PROJ-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinearError);
    expect((error as Error).message).toBe(`HTTP 503 on Description after 3 attempts: Service unavailable - details in ${errorLog()}`);
  });

  test("logs every failed attempt with what was sent and the answer", async () => {
    linear.fail("Description", 502, "<html>Bad gateway</html>", { headers: { "Retry-After": "0" } });
    await loadDescription("id-PROJ-1");
    const log = readFileSync(errorLog(), "utf8");
    expect(log).toMatch(/attempt 1\/3 HTTP 502 Description\n\{"id":"id-PROJ-1"\}/);
    expect(log).toContain("Bad gateway");
  });

  test("a change Linear refuses is not retried, and says why", async () => {
    await expect(assignIssue("id-PROJ-5", { name: "ghost" })).rejects.toThrow(/^UpdateIssue failed: Entity not found: User - details in/);
    expect(linear.calls("UpdateIssue")).toHaveLength(1);
  });

  test("a refused API key says how to enter a new one", async () => {
    await expect(gql("query Me { viewer { id } }", {}, { token: "wrong" }))
      .rejects.toThrow("Linear refuses the API key (Authentication required, not authenticated): run lboard --setup to enter a new one");
  });
});

describe("when Linear doesn't answer in time", () => {
  beforeEach(() => setTimings({ request: 100, retry: 0 }));
  afterEach(() => setTimings({ request: 30_000, retry: 1_500 }));

  test("queries and updates are sent again", async () => {
    linear.stall("Description", 300);
    expect(await loadDescription("id-PROJ-5")).toBe("");
    linear.stall("UpdateIssue", 300, { handled: false });
    await assignIssue("id-PROJ-5", { name: "ckent" });
    expect(linear.get("PROJ-5").assignee).toBe("ckent");
    expect(linear.calls("UpdateIssue")).toHaveLength(2);
  });

  test("gives up after three attempts", async () => {
    linear.stall("Description", 300, { times: 3 });
    await expect(loadDescription("id-PROJ-1")).rejects.toThrow("cannot reach Linear: The operation was aborted due to timeout (3 attempts)");
    expect(readFileSync(errorLog(), "utf8")).toMatch(/attempt 3\/3 no answer Description\nThe operation was aborted/);
  });

  test("a create Linear made anyway is found by its id, not made twice", async () => {
    linear.stall("CreateIssue", 300);
    expect(await createIssue({ teamId: TEAM_ID, title: "Export to CSV" })).toBe("PROJ-100");
    expect(linear.issues.filter((i) => i.summary === "Export to CSV")).toHaveLength(1);
    expect(linear.calls("CreateIssue")).toHaveLength(1);
    expect(linear.calls("Created")[0].variables.id).toBe(linear.calls("CreateIssue")[0].variables.input.id);
  });

  test("a create that didn't get to Linear is sent again, with the same id", async () => {
    linear.stall("CreateIssue", 300, { handled: false });
    expect(await createIssue({ teamId: TEAM_ID, title: "Export to CSV" })).toBe("PROJ-100");
    const [first, second] = linear.calls("CreateIssue");
    expect(second.variables.input.id).toBe(first.variables.input.id);
  });

  test("a create is not sent again when Linear can't be asked whether it was made", async () => {
    linear.stall("CreateIssue", 300, { handled: false });
    linear.fail("Created", 500);
    await expect(createIssue({ teamId: TEAM_ID, title: "Export to CSV" })).rejects.toThrow(LinearUnanswered);
    expect(linear.calls("CreateIssue")).toHaveLength(1);
  });
});

describe("operations", () => {
  test("loads the team: its states, open cycles (the active one first) and who I am", async () => {
    const team = await loadTeam("proj");
    expect(team).toMatchObject({ id: TEAM_ID, key: TEAM, cyclesEnabled: true, workspace: "acme" });
    expect(team.cycles.map((c) => [c.name, c.state])).toEqual([["Cycle 12", "active"], ["Cycle 13", "future"]]);
    expect(team.viewer).toEqual({ name: "jdoe", displayName: "Jane Doe", email: "jane@example.com" });
    await expect(loadTeam("NOPE")).rejects.toThrow("no team NOPE in your Linear workspace (or you are not in it)");
  });

  test("assigns and unassigns", async () => {
    const [clark] = await searchUsers("kent");
    expect(clark).toEqual({ name: "ckent", displayName: "Clark Kent", email: "clark@example.com" });
    await assignIssue("id-PROJ-5", clark);
    expect(linear.get("PROJ-5").assignee).toBe("ckent");
    await assignIssue("id-PROJ-5", null);
    expect(linear.get("PROJ-5").assignee).toBeNull();
  });

  test("loads and changes descriptions and fields", async () => {
    linear.get("PROJ-4").description = "line one\r\nline two";
    expect(await loadDescription("id-PROJ-4")).toBe("line one\nline two");
    await updateIssue("id-PROJ-5", { estimate: 8, priority: 1 });
    expect(linear.get("PROJ-5")).toMatchObject({ points: 8, priority: 1 });
  });

  test("moves issues to a cycle and out of them", async () => {
    await moveToCycle(["id-PROJ-1", "id-PROJ-2"], "c13");
    expect(["PROJ-1", "PROJ-2"].map((k) => linear.get(k).cycle)).toEqual(["c13", "c13"]);
    await moveToCycle(["id-PROJ-1"], null);
    expect(linear.get("PROJ-1").cycle).toBeNull();
  });

  test("where issues can go: the backlog, then the cycles; without cycles the backlog or the board", async () => {
    expect(places(await loadTeam(TEAM)).map((p) => [p.name, p.input])).toEqual([
      ["Backlog", { cycleId: null }], ["Cycle 12", { cycleId: "c12" }], ["Cycle 13", { cycleId: "c13" }],
    ]);
    linear.cyclesEnabled = false;
    expect(places(await loadTeam(TEAM)).map((p) => [p.name, p.note, p.input])).toEqual([
      ["Backlog", "Backlog", { stateId: "backlog" }], ["Project", "the board, as Todo", { stateId: "1" }],
    ]);
  });

  test("the kinds of issue: plain, then the labels the team has, not another team's", async () => {
    expect(await issueTypes(TEAM_ID)).toEqual([
      { id: "", name: "Issue" }, { id: "l-feature", name: "Feature" }, { id: "l-improvement", name: "Improvement" }, { id: "l-bug", name: "Bug" },
    ]);
    await issueTypes(TEAM_ID);
    expect(linear.calls("Kinds").length).toBeLessThanOrEqual(1);
  });

  test("the team's open projects, found by name, its start or slug", async () => {
    expect((await teamProjects(TEAM_ID)).map((p) => p.name)).toEqual(["Billing", "Launch"]);
    expect((await findProject(TEAM_ID, "launch")).id).toBe("p-launch");
    expect((await findProject(TEAM_ID, "Bill")).id).toBe("p-billing");
    expect((await findProject(TEAM_ID, "launch-1a2b")).id).toBe("p-launch");
    await expect(findProject(TEAM_ID, "Old stuff")).rejects.toThrow('no open project "Old stuff" in this team; it has: Billing, Launch');
  });

  test("creates an issue with a label, in a project and a cycle", async () => {
    const key = await createIssue({
      teamId: TEAM_ID, title: "Export to CSV", description: "As a user…", labelIds: ["l-feature"], projectId: "p-launch", cycleId: "c13",
    });
    expect(key).toBe("PROJ-100");
    expect(linear.get(key)).toMatchObject({ summary: "Export to CSV", labels: ["Feature"], cycle: "c13", project: "p-launch", description: "As a user…" });
  });

  test("leaves an empty description and labels out", async () => {
    await createIssue({ teamId: TEAM_ID, title: "Plain", description: "", labelIds: [] });
    expect(Object.keys(linear.calls("CreateIssue")[0].variables.input).sort()).toEqual(["id", "teamId", "title"]);
  });

  test("creates sub-issues in the parent's project, reporting the ones Linear refuses", async () => {
    const board = await loadBoard();
    const parent = board.cards.find((c) => c.key === "PROJ-1")!;
    const result = await createSubIssues(parent, TEAM_ID, ["Reproduce", "FAIL this one", "Fix it"], { cycleId: "c12" });
    expect(result.created).toEqual(["PROJ-100", "PROJ-101"]);
    expect(result.failed).toEqual([{ summary: "FAIL this one", reason: expect.stringContaining("Title is invalid") }]);
    expect(linear.get("PROJ-100")).toMatchObject({ parent: "PROJ-1", project: "p-launch", cycle: "c12" });
  });
});

describe("loading the board", () => {
  test("the active cycle: a column per state, sub-issues under their parent, estimates", async () => {
    const board = await loadBoard();
    expect(board.sprint.name).toBe("Cycle 12");
    expect(board.columns.map((c) => c.name)).toEqual(["Todo", "In Progress", "In Review", "Done"]);
    expect(board.me).toBe("jdoe");
    expect(board.pointsField).toBe("estimate");
    const card = board.cards.find((c) => c.key === "PROJ-1")!;
    expect(card.points).toBe(3);
    expect(card.fields.issuetype).toEqual({ name: "Feature", subtask: false });
    expect(card.subs.map((s) => s.key)).toEqual(["PROJ-2", "PROJ-3"]);
    // a sub-issue whose parent is elsewhere is a card of its own
    expect(board.cards.find((c) => c.key === "PROJ-9")?.subs).toEqual([]);
    expect(board.cards.map((c) => c.key)).not.toContain("PROJ-2");
    // canceled issues are left out
    expect(board.keys()).not.toContain("PROJ-24");
    expect(board.keys()).toHaveLength(12);
  });

  test("sub-issues of sub-issues hang under the card at the top", async () => {
    linear.issues.push({ ...linear.get("PROJ-2"), key: "PROJ-7", summary: "Deeper", parent: "PROJ-2" });
    const board = await loadBoard();
    expect(board.cards.find((c) => c.key === "PROJ-1")!.subs.map((s) => s.key)).toEqual(["PROJ-2", "PROJ-7", "PROJ-3"]);
  });

  test("sub-issues in board order: to do, in progress, review, done", async () => {
    linear.get("PROJ-2").status = "10001";
    linear.get("PROJ-3").status = "10";
    linear.issues.push({ ...linear.get("PROJ-2"), key: "PROJ-7", status: "3" }, { ...linear.get("PROJ-2"), key: "PROJ-8", status: "1" });
    const board = await loadBoard();
    expect(board.cards.find((c) => c.key === "PROJ-1")!.subs.map((s) => s.key)).toEqual(["PROJ-8", "PROJ-7", "PROJ-3", "PROJ-2"]);
  });

  test("buckets cards by column, the latest 5 done cards unless all are asked for", async () => {
    const board = await loadBoard();
    const { buckets, hidden, points } = board.buckets(false, false);
    expect(buckets.map((b) => b.map((c) => c.key))).toEqual([
      ["PROJ-1"], ["PROJ-4", "PROJ-9"], ["PROJ-5"], ["PROJ-26", "PROJ-23", "PROJ-22", "PROJ-21", "PROJ-20"],
    ]);
    expect(hidden).toBe(1);
    expect(points).toEqual([3, 2, 0, 9]);
    expect(board.buckets(false, true).buckets[3]).toHaveLength(6);
    expect(board.buckets(true, true).buckets.flat().map((c) => c.key).sort()).toEqual(["PROJ-1", "PROJ-21", "PROJ-9"]);
  });

  test("the people: me first, then everyone with work on the board by name", async () => {
    const board = await loadBoard();
    expect(board.teamMembers().map((u) => u.name)).toEqual(["jdoe", "asmith", "bwayne"]);
  });

  test("reads every page of a big cycle", async () => {
    linear.pageSize = 5;
    const board = await loadBoard();
    expect(board.keys()).toHaveLength(12);
    expect(linear.calls("BoardIssues").map((r) => r.variables.after)).toEqual([null, "5", "10"]);
  });

  test("another cycle by id", async () => {
    const board = await loadBoard(new Board(TEAM).view("c13"));
    expect(board.kind).toBe("sprint");
    expect(board.sprint.name).toBe("Cycle 13");
    expect(board.keys()).toEqual(["PROJ-30"]);
  });

  test("the backlog: one column of what is in no cycle and not done", async () => {
    const board = await loadBoard(new Board(TEAM, ["In Review"]).view(null));
    expect(board.kind).toBe("backlog");
    expect(board.columns.map((c) => c.name)).toEqual(["Backlog"]);
    // also issues in columns the cycle doesn't show; done ones are not in it
    const { buckets, hidden } = board.buckets(false, false);
    expect(buckets[0].map((c) => c.key)).toEqual(["PROJ-40", "PROJ-41"]);
    expect(buckets[0][0].subs.map((s) => s.key)).toEqual(["PROJ-43"]);
    expect(hidden).toBe(0);
  });

  test("only one project's issues", async () => {
    const board = new Board(TEAM);
    board.project = { id: "p-launch", name: "Launch", slugId: "launch-1a2b" };
    await board.reload();
    expect(board.keys()).toEqual(["PROJ-1", "PROJ-2"]);
    expect(linear.calls("BoardIssues")[0].variables.filter.project).toEqual({ id: { eq: "p-launch" } });
  });

  test("without cycles: what is to do, in progress or done lately; the backlog is the Backlog state", async () => {
    linear.cyclesEnabled = false;
    const board = await loadBoard();
    expect(board.sprint).toEqual({ id: "", name: "Project" });
    expect(board.keys()).toContain("PROJ-30"); // whatever cycle it was in
    expect(board.keys()).toContain("PROJ-41");
    expect(board.keys()).not.toContain("PROJ-42"); // done three months ago
    expect(board.keys()).not.toContain("PROJ-40"); // in the backlog
    const backlog = await loadBoard(board.view(null));
    expect(backlog.buckets(false, false).buckets[0].map((c) => c.key)).toEqual(["PROJ-40"]);
  });

  test("a team that doesn't estimate shows no points", async () => {
    linear.estimation = "notUsed";
    const board = await loadBoard();
    expect(board.pointsField).toBeNull();
    expect(board.cards.find((c) => c.key === "PROJ-1")!.points).toBeNull();
  });

  test("columns to show and to hide when empty must be on the board", async () => {
    await expect(loadBoard(new Board(TEAM, ["Doing"]))).rejects.toThrow(
      'no column "Doing" on this board; it has: Todo, In Progress, In Review, Done');
  });

  test("a failed reload keeps what was loaded", async () => {
    const board = await loadBoard();
    linear.get("PROJ-1").summary = "Changed";
    linear.fail("BoardIssues", 500, { errors: [{ message: "Internal error" }] });
    await expect(board.reload()).rejects.toThrow("Internal error");
    expect(board.cards.find((c) => c.key === "PROJ-1")?.fields.summary).toBe("Login with SSO");
    await board.reload();
    expect(board.cards.find((c) => c.key === "PROJ-1")?.fields.summary).toBe("Changed");
  });

  test("errors are logged under the home directory", async () => {
    linear.fail("Team", 500);
    await expect(new Board(TEAM).reload()).rejects.toThrow(LinearError);
    expect(existsSync(errorLog())).toBe(true);
  });
});
