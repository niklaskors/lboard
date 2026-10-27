// The lboard command, run as a separate process against the fake Linear, as a user would run it.

import { execFile, execFileSync } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { updatesAvailable } from "../src/update.ts";
import { TOKEN } from "./fakes/linear.ts";
import { bench, configFile, linear, opened, ROOT } from "./harness.ts";

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** Run lboard with these arguments; stdout is a pipe, so it prints the board instead of opening it. */
function lboard(args: string[], env: Record<string, string | undefined> = {}, input = ""): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, ["--disable-warning=ExperimentalWarning", "--disable-warning=UNDICI-EHPA", join(ROOT, "bin", "lboard.ts"), ...args],
      { env: { ...process.env, COLUMNS: "200", ...env } }, (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) });
      });
    child.stdin!.end(input); // answers to setup's questions
  });
}

/** The printed board's cells, one entry per card line with its key. */
const keysIn = (out: string) => [...out.matchAll(/PROJ-\d+/g)].map((m) => m[0]);

describe("printing the board", () => {
  test("shows the active cycle's columns with their cards, points and assignees", async () => {
    const { code, stdout } = await lboard(["-p"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Cycle 12");
    expect(stdout).toMatch(/ends \d+ \w+ · 10d left/);
    for (const column of ["TODO", "IN PROGRESS", "IN REVIEW", "DONE"]) expect(stdout).toContain(column);
    expect(stdout).toMatch(/PROJ-1 .*3 pts ▸ 1\/2 +Jane/); // estimate, sub-issues done/total, first name
    expect(stdout).toContain("Login with SSO");
    expect(stdout).toMatch(/PROJ-5 .*\? pts +-/); // not estimated, unassigned
    expect(stdout).toContain("PROJ-9"); // a sub-issue whose parent isn't in the cycle is a card itself
    expect(stdout).not.toContain("PROJ-30"); // in the next cycle
    expect(stdout).not.toContain("PROJ-40"); // in the backlog
    // points of all done cards count, also of the one left out
    expect(stdout).toMatch(/━+ +9\/14 pts done +10 cards/);
  });

  test("shows the 5 latest done cards, and all of them with -a", async () => {
    const latest = await lboard(["-p"]);
    expect(latest.stdout).toContain("+1 more (lboard -a)");
    expect(keysIn(latest.stdout)).not.toContain("PROJ-6"); // the oldest done card

    const all = await lboard(["-p", "-a"]);
    expect(all.stdout).not.toContain("more (lboard -a)");
    expect(keysIn(all.stdout)).toContain("PROJ-6");
  });

  test("-m shows only my cards: assigned to me, or with a sub-issue of mine", async () => {
    const { stdout } = await lboard(["-p", "-m"]);
    expect(stdout).toContain("· mine");
    expect(keysIn(stdout).sort()).toEqual(["PROJ-1", "PROJ-21", "PROJ-9"]);
  });

  test("--columns and $LBOARD_COLUMNS show only some columns, in any case", async () => {
    const flag = await lboard(["-p", "--columns", "in progress, in review"]);
    expect(flag.stdout).toContain("IN PROGRESS");
    expect(flag.stdout).toContain("IN REVIEW");
    expect(flag.stdout).not.toContain("TODO");
    expect(keysIn(flag.stdout).sort()).toEqual(["PROJ-4", "PROJ-5", "PROJ-9"]);

    const env = await lboard(["-p"], { LBOARD_COLUMNS: "Todo" });
    expect(keysIn(env.stdout)).toEqual(["PROJ-1"]);
  });

  test("$LBOARD_HIDE_EMPTY leaves out those columns while they have no cards", async () => {
    expect((await lboard(["-p"], { LBOARD_HIDE_EMPTY: "In Review" })).stdout).toContain("IN REVIEW");
    const mine = await lboard(["-p", "-m"], { LBOARD_HIDE_EMPTY: "In Review" });
    expect(mine.stdout).not.toContain("IN REVIEW");
    expect(mine.stdout).toContain("DONE");
  });

  test("an unknown column is refused, naming the board's columns", async () => {
    const { code, stderr } = await lboard(["-p", "--columns", "Doing"]);
    expect(code).toBe(1);
    expect(stderr).toContain('lboard: no column "Doing" on this board; it has: Todo, In Progress, In Review, Done');
  });

  test("-P and $LBOARD_PROJECT show only one project's issues", async () => {
    const flag = await lboard(["-p", "-P", "launch"]);
    expect(flag.stdout).toMatch(/Cycle 12 +· +Launch/);
    expect(keysIn(flag.stdout)).toEqual(["PROJ-1"]);
    expect(keysIn((await lboard(["-p"], { LBOARD_PROJECT: "Billing" })).stdout)).toEqual([]);
    expect(keysIn((await lboard(["-p", "-P", ""], { LBOARD_PROJECT: "Billing" })).stdout)).toContain("PROJ-4"); // "" is the whole team

    const { code, stderr } = await lboard(["-p", "-P", "nope"]);
    expect(code).toBe(1);
    expect(stderr).toContain('lboard: no open project "nope" in this team; it has: Billing, Launch');
  });

  test("marks issues with a bench, and their merge request", async () => {
    const { stdout } = await lboard(["-p"]);
    expect(stdout).toMatch(/PROJ-4 !! ⎇ !12/);
    expect(stdout).toMatch(/PROJ-1 ⎇ !7/);
    // bench was asked about this cycle's issues only, merge requests included
    const ls = bench.calls().find((args) => args[0] === "ls")!;
    expect(ls).toContain("--mr");
    expect(ls[ls.indexOf("--match") + 1]).toContain("PROJ-1|PROJ-2|PROJ-3");
  });

  test("works without bench installed", async () => {
    const { code, stdout } = await lboard(["-p"], { LBOARD_BENCH: "/nonexistent/bench" });
    expect(code).toBe(0);
    expect(stdout).toContain("PROJ-4");
    expect(stdout).not.toContain("!12");
  });

  test("--team picks another team than $LINEAR_TEAM", async () => {
    const { code, stderr } = await lboard(["-p", "--team", "NOPE"]);
    expect(code).toBe(1);
    expect(stderr).toContain("lboard: no team NOPE in your Linear workspace (or you are not in it)");
  });

  test("between cycles, the board shows the team's active issues", async () => {
    linear.cycles = linear.cycles.filter((c) => c.id !== "c12");
    const { code, stdout } = await lboard(["-p"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^ *◆ Project/m);
    expect(keysIn(stdout)).toContain("PROJ-30");
  });

  test("the classic theme prints without the night theme's card bars", async () => {
    const night = await lboard(["-p"]);
    const classic = await lboard(["-p", "-t", "classic"]);
    expect(night.stdout).toContain("▎");
    expect(classic.stdout).not.toContain("▎");
    expect(classic.stdout).toContain("PROJ-1");
  });
});

describe("options and settings", () => {
  test("--help prints the usage", async () => {
    const { code, stdout } = await lboard(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^Usage: lboard/);
    expect(linear.requests).toEqual([]);
  });

  test("an unknown option prints the usage and exits with 2", async () => {
    const { code, stderr } = await lboard(["--nope"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown option '--nope'");
    expect(stderr).toContain("Usage: lboard");
  });

  test("an unknown theme is refused", async () => {
    const { code, stderr } = await lboard(["-p", "-t", "neon"]);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown theme "neon", choose from: night, day, classic');
  });

  test("a team is required", async () => {
    const { code, stderr } = await lboard(["-p"], { LINEAR_TEAM: undefined });
    expect(code).toBe(1);
    expect(stderr).toContain(`no team: set "team" in ${configFile()} or pass --team <key>`);
  });

  test("-w opens the board in the browser without loading its issues", async () => {
    expect((await lboard(["-w"])).code).toBe(0);
    await expect.poll(opened).toEqual(["https://linear.example.com/acme/team/PROJ/cycle/active"]);
    expect(linear.calls("BoardIssues")).toEqual([]);
  });

  test("-w with a project opens the project", async () => {
    expect((await lboard(["-w", "-P", "billing"])).code).toBe(0);
    await expect.poll(opened).toEqual(["https://linear.example.com/acme/project/billing-3c4d/issues"]);
  });

  test("a wrong API key says how to enter a new one", async () => {
    const { code, stderr } = await lboard(["-p"], { LINEAR_API_KEY: "wrong" });
    expect(code).toBe(1);
    expect(stderr).toContain("lboard: Linear refuses the API key (Authentication required, not authenticated): run lboard --setup to enter a new one");
  });

  test("an unreachable Linear is reported", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    const { code, stderr } = await lboard(["-p"], { LINEAR_API_URL: `http://127.0.0.1:${port}/graphql` });
    expect(code).toBe(1);
    expect(stderr).toContain("lboard: cannot reach Linear: ECONNREFUSED");
  });
});

describe("the config file", () => {
  const writeConfig = (config: unknown) => {
    mkdirSync(dirname(configFile()), { recursive: true });
    writeFileSync(configFile(), typeof config === "string" ? config : JSON.stringify(config));
  };
  /** lboard with only the config file, none of the settings in the environment. */
  const fromFile = (args: string[], env: Record<string, string | undefined> = {}, input = "") =>
    lboard(args, { LINEAR_API_KEY: undefined, LINEAR_TEAM: undefined, LBOARD_BENCH: undefined, ...env }, input);

  test("holds the settings", async () => {
    writeConfig({ token: TOKEN, team: "proj", columns: ["Todo", "In Review"], theme: "classic", bench: bench.command });
    const { code, stdout } = await fromFile(["-p"]);
    expect(code).toBe(0);
    expect(stdout).toContain("TODO (1 · 3 pts)"); // the classic theme's column header
    expect(keysIn(stdout)).toEqual(["PROJ-1", "PROJ-5"]);
    expect(stdout).toMatch(/PROJ-1 \* !7/); // bench, from the config, marked as the classic theme does
  });

  test("the environment and the options win over it", async () => {
    writeConfig({ token: "wrong", team: "NOPE", columns: "Done", project: "Billing" });
    const { code, stdout } = await fromFile(["-p", "--columns", "In Review"], { LINEAR_API_KEY: TOKEN, LINEAR_TEAM: "PROJ", LBOARD_PROJECT: "" });
    expect(code).toBe(0);
    expect(keysIn(stdout)).toEqual(["PROJ-5"]);
  });

  test("a file that isn't valid JSON is reported", async () => {
    writeConfig("{ token: nope");
    const { code, stderr } = await fromFile(["-p"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(new RegExp(`^lboard: ${configFile().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .*JSON`));
  });

  test("an unknown setting is reported, naming the known ones", async () => {
    writeConfig({ tokn: TOKEN });
    const { code, stderr } = await fromFile(["-p"]);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown setting "tokn", choose from: token, team, project, columns, hideEmpty, theme, bench, branch, truecolor');
  });

  test("needs an API key", async () => {
    writeConfig({ team: "PROJ" });
    const { code, stderr } = await fromFile(["-p"]);
    expect(code).toBe(1);
    expect(stderr).toContain(`lboard: set "token" in ${configFile()} (or LINEAR_API_KEY): a personal API key from Linear`);
  });

  test("without one, lboard says how to set it up", async () => {
    const { code, stderr } = await fromFile(["-p"]);
    expect(code).toBe(1);
    expect(stderr).toContain(`lboard: no config yet: run lboard in a terminal to set it up, or write ${configFile()}`);
  });

  test("--setup asks for an API key, a team and a project, checks them with Linear and saves them", async () => {
    const answers = ["", "wrong-key", TOKEN, "nope", "2", "Launch"];
    const { code, stdout } = await fromFile(["--setup"], {}, `${answers.join("\n")}\n`);
    expect(code).toBe(0);
    expect(stdout).toContain("that didn't work: Linear refuses the API key");
    expect(stdout).toContain("signed in as Jane Doe");
    expect(stdout).toMatch(/1\. OPS +Operations\n +2\. PROJ +Project/);
    expect(stdout).toContain('no team "nope"');
    expect(stdout).not.toContain(TOKEN);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ token: TOKEN, team: "PROJ", project: "Launch" });
    expect(statSync(configFile()).mode & 0o777).toBe(0o600); // it holds the API key

    // and from now on lboard runs with it
    writeConfig({ ...JSON.parse(readFileSync(configFile(), "utf8")), bench: bench.command });
    expect((await fromFile(["-p"])).stdout).toMatch(/Cycle 12 +· +Launch/);
  });

  test("--setup again keeps the other settings, and - drops the project", async () => {
    writeConfig({ token: "old", team: "OPS", project: "Billing", theme: "day" });
    const { code } = await fromFile(["--setup"], {}, `${TOKEN}\nproj\n-\n`);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ token: TOKEN, team: "PROJ", theme: "day" });
  });

  test("--help works whatever is in it", async () => {
    writeConfig("not json");
    const { code, stdout } = await fromFile(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain(`Config: ${configFile()}`);
  });
});

describe("--update", () => {
  /** A clone of a repo holding this lboard, with git's output kept quiet and nameless commits allowed. */
  function clone(): { origin: string; clone: string; git: (cwd: string, ...args: string[]) => string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "lboard-update-")));
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: "pipe" });
    const origin = join(base, "origin");
    for (const part of ["bin", "src", "package.json"]) cpSync(join(ROOT, part), join(origin, part), { recursive: true });
    git(base, "init", "-q", "-b", "main", origin);
    git(origin, "add", ".");
    git(origin, "commit", "-qm", "First");
    git(base, "clone", "-q", origin, join(base, "clone"));
    return { origin, clone: join(base, "clone"), git };
  }

  const update = (cloneDir: string) => new Promise<Result>((resolve) => {
    execFile(process.execPath, ["--disable-warning=ExperimentalWarning", "--disable-warning=UNDICI-EHPA", join(cloneDir, "bin", "lboard.ts"), "--update"],
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
  });

  test("pulls the new commits into the clone it runs from and lists them", async () => {
    const repo = clone();
    writeFileSync(join(repo.origin, "NEW"), "");
    repo.git(repo.origin, "add", ".");
    repo.git(repo.origin, "commit", "-qm", "Add a new thing");

    const { code, stdout } = await update(repo.clone);
    expect(code).toBe(0);
    expect(stdout).toContain(`Updating lboard in ${repo.clone}`);
    expect(stdout).toMatch(/New in lboard:\n +[0-9a-f]+ Add a new thing/);
    expect(existsSync(join(repo.clone, "NEW"))).toBe(true);
  });

  test("the board's check counts the commits waiting upstream, and is 0 when it can't tell", async () => {
    const repo = clone();
    expect(await updatesAvailable(repo.clone)).toBe(0);
    for (const n of [1, 2]) {
      writeFileSync(join(repo.origin, `NEW${n}`), "");
      repo.git(repo.origin, "add", ".");
      repo.git(repo.origin, "commit", "-qm", `Change ${n}`);
    }
    expect(await updatesAvailable(repo.clone)).toBe(2);
    expect(await updatesAvailable(tmpdir())).toBe(0); // not a clone
  });

  test("says nothing is new when it is up to date", async () => {
    const { code, stdout } = await update(clone().clone);
    expect(code).toBe(0);
    expect(stdout).not.toContain("New in lboard");
  });
});
