// Command line: options, help text and startup.

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { benchedIssues, listBenches } from "./bench.ts";
import { Board } from "./board.ts";
import { openUrl } from "./browser.ts";
import { boardUrl, CONFIG_ERROR, CONFIG_FILE, setting, setWorkspace, TOKEN } from "./config.ts";
import { findProject, loadTeam } from "./linear/api.ts";
import { LinearError } from "./linear/client.ts";
import { printBoard } from "./render/print.ts";
import { THEME_NAMES, useTheme } from "./render/theme.ts";
import { setup } from "./setup.ts";
import { Tui } from "./tui/app.ts";
import { runCreate } from "./tui/wizard.ts";
import { update } from "./update.ts";

const USAGE = `Usage: lboard [-m] [-a] [--team KEY] [-P PROJECT] [--columns NAMES] [-w] [-p] [-t THEME] [--setup]
       lboard --update
       lboard --create SUMMARY [--team KEY] [-P PROJECT] [-t THEME]
  -m, --mine     start with only my cards (assigned to me, or with a sub-issue of mine)
  -a, --all      show every card in the done column, not just the 5 latest
      --team     the team's key, e.g. ENG (default: the config's team)
  -P, --project  only this project's issues: its name, or the start of it (default: the config's
                 project, else the whole team); "" for the whole team
      --columns  the board's columns to show, comma separated, e.g. "Todo,In Progress,Done"
                 (default: the config's columns, else all); cards in other columns are left out
  -w, --web      open the board in the browser instead
  -p, --print    print the board once instead of the interactive view
                 (automatic when output is not a terminal)
  -t, --theme    night (default, dark), day (light terminals) or classic (16 colours);
                 or set it in the config. 24-bit colour is used when $COLORTERM says so
      --setup    ask for your API key, team and project again and save them in the config
                 (also what happens on the first run, when there is no config yet)
      --update   pull the latest lboard into its clone and show what's new
      --create   create one issue with this summary in a small wizard: its project, its kind,
                 the backlog or a cycle, then the summary to change. Prints the new key, e.g.
                 for punch: key=$(lboard --create "Export to CSV"); exits with 130 when cancelled

The board is the team's active cycle; for a team without cycles, its issues that are to do, in
progress or done in the last 30 days. Tab shows the next cycles and the backlog.

Keys: h/j/k/l or arrows  move          enter/space  expand/collapse sub-issues
      g/G                top/bottom    e            expand/collapse all
      o                  open the selected issue in the browser
      w                  open the whole board in the browser
      s                  change the status of the selected issue (type to filter)
      A                  assign the selected issue (type to search, enter to assign)
      p                  set the estimate of the selected card (empty clears)
      !                  set the priority of the selected issue
      c                  create sub-issues under the selected issue: one per line, ctrl+s to create
      C                  create an issue
      S                  move the selected card to a cycle, or between the board and the backlog
      P                  move the selected issue to another project
      f                  show only one project's issues, or all again
      b                  open the selected issue's bench (its own git worktree) in a new terminal tab,
                         making it in the default repo first
      B                  the same, choosing the repo first
      M                  open the merge request of the selected issue's bench in the browser
      D                  remove one of the selected issue's benches, keeping or deleting its branch
                         (refused while it has uncommitted or unpushed work)
      m                  toggle mine   a            toggle all done cards
      r                  refresh       ctrl+c       quit
      ?                  show all keys

Config: ${CONFIG_FILE}, e.g.
  { "token": "lin_api_...", "team": "ENG", "project": "Launch" }

  token      a personal API key (Linear: Settings → Security & access)  (required)
  team       the team's key                                            (or use --team)
  project    only this project's issues, by name                       (or use --project)
  columns    columns to show, a list or comma separated                (or use --columns)
  hideEmpty  columns to leave out while they have no cards, e.g. ["In Review"]
  theme      night, day or classic                                     (or use --theme)
  bench      the bench command, for b and B (default: bench; see github.com/niklaskors/bench)
  branch     branch name for a new bench, from {type} (fix for bugs, else feat), {key} and
             {summary} (default: {type}/{key}-{summary})
  truecolor  true forces 24-bit colour

Each can also be set in the environment, which wins over the file: LINEAR_API_KEY, LINEAR_TEAM,
LBOARD_PROJECT, LBOARD_COLUMNS, LBOARD_HIDE_EMPTY, LBOARD_THEME, LBOARD_BENCH, LBOARD_BRANCH,
LBOARD_TRUECOLOR.`;

async function main(): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        mine: { type: "boolean", short: "m" },
        all: { type: "boolean", short: "a" },
        team: { type: "string" },
        project: { type: "string", short: "P" },
        columns: { type: "string" },
        web: { type: "boolean", short: "w" },
        print: { type: "boolean", short: "p" },
        theme: { type: "string", short: "t" },
        setup: { type: "boolean" },
        update: { type: "boolean" },
        create: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    console.error(`lboard: ${(e as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.update) {
    update();
    return;
  }
  // the first run, without a config or the settings in the environment: set it up
  const firstRun = !existsSync(CONFIG_FILE) && !TOKEN;
  // --create's caller reads stdout, so setup's questions wouldn't be seen
  if (values.setup || (firstRun && process.stdin.isTTY && values.create === undefined)) {
    await setup();
    if (values.setup) return;
  } else if (firstRun) {
    throw new LinearError(`no config yet: run lboard in a terminal to set it up, or write ${CONFIG_FILE}`);
  }
  if (CONFIG_ERROR) {
    console.error(`lboard: ${CONFIG_ERROR}`);
    process.exit(2);
  }
  const themeName = values.theme ?? setting("theme") ?? "night";
  if (!useTheme(themeName)) {
    console.error(`lboard: unknown theme "${themeName}", choose from: ${THEME_NAMES.join(", ")}`);
    process.exit(2);
  }
  if (!TOKEN) throw new LinearError(`set "token" in ${CONFIG_FILE} (or LINEAR_API_KEY): a personal API key from Linear`);

  const team = values.team ?? setting("team");
  if (!team) throw new LinearError(`no team: set "team" in ${CONFIG_FILE} or pass --team <key>`);
  const projectName = values.project ?? setting("project") ?? "";
  if (values.create !== undefined) {
    const created = await runCreate(team, projectName || undefined, values.create);
    if (!created) process.exit(130);
    if (created.warning) console.error(`lboard: ${created.warning}`);
    console.log(created.key);
    return;
  }
  const project = projectName ? await loadTeam(team).then((t) => findProject(t.id, projectName)) : null;
  if (values.web) {
    const info = await loadTeam(team);
    setWorkspace(info.workspace);
    openUrl(boardUrl(info.key, info.cyclesEnabled ? "cycle" : "active", project));
    return;
  }

  const columns = (values.columns ?? setting("columns") ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const board = new Board(team, columns);
  board.project = project;
  board.hideEmpty = (setting("hideEmpty") ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  await board.reload();
  if (values.print || !process.stdout.isTTY || !process.stdin.isTTY) {
    printBoard(board, !!values.mine, !!values.all, benchedIssues(await listBenches({ mrs: true, keys: board.keys() }), board.keys()));
  } else {
    new Tui(board, !!values.mine, !!values.all).start();
  }
}

/** Run lboard; Linear problems end it with a readable message instead of a stack trace. */
export function run(): void {
  main().catch((e: unknown) => {
    if (!(e instanceof LinearError)) throw e;
    console.error(`lboard: ${e.message}`);
    process.exit(1);
  });
}
