# lboard

Your Linear team's cycle as an interactive kanban board in the terminal. A sibling of
[jboard](https://github.com/niklaskors/jboard), which does the same for Jira.

- **The board you know**: a column per workflow state, the estimates of your team, one card per issue with its
  sub-issues folded underneath
- **Teams with or without cycles**: the active cycle, the next ones and the backlog as tabs; without cycles, the
  team's active issues (to do, in progress and done in the last 30 days) and its backlog
- **Work without the browser**: change status, assign people, set estimates and priorities, read and edit
  descriptions, create issues and sub-issues, move issues between cycles and projects, and show one project at a time
- **Start on an issue in one key**: `b` opens the issue's own git worktree in a new terminal tab, made in seconds by
  [bench](https://github.com/niklaskors/bench)
- **No build, no dependencies**: TypeScript that Node runs directly, so there is no build step and no `npm install`
  needed to use it

## Requirements

- **Node.js 22.18 or newer** (runs TypeScript directly)
- **A Linear personal API key**: in Linear, Settings → Security & access → Personal API keys

## Install

```sh
git clone https://github.com/niklaskors/lboard.git ~/.local/share/lboard && mkdir -p ~/.local/bin && ln -s ~/.local/share/lboard/bin/lboard.ts ~/.local/bin/lboard
```

`~/.local/bin` must be on your PATH (or link into another directory that is). The link must point at
`bin/lboard.ts` inside the clone (not a copy of it): it loads the rest of the code from `src/`.
To update: `lboard --update`; the board says so in its status line when a new version is out.

The first time you run `lboard`, it asks for your API key, your team and optionally a project, checks them with
Linear and saves them in `~/.config/lboard/config.json` (readable only by you, since it holds the key).
`lboard --setup` asks again.

## Usage

```sh
lboard              # interactive board for the active cycle (or the active issues)
lboard -m           # only cards assigned to me (or with a sub-issue of mine)
lboard -P Launch    # only the issues of one project
lboard -p           # print the board once, e.g. to pipe it somewhere
lboard -w           # open the board in the browser
lboard -t day       # light theme
lboard --team ENG   # another team than the config's
lboard --columns "Todo,Done"   # only these columns of the board
lboard --create "Export to CSV"   # create one issue in a small wizard and print its key
lboard --setup      # change your API key, team or project
lboard --update     # pull the latest lboard and show what's new
lboard -h           # all options
```

### Keys

| Key | Action |
|---|---|
| `h` `j` `k` `l` / arrows | Move between columns and cards |
| `g` / `G` | Top / bottom of the column |
| `Ctrl+D` / `Ctrl+U` | Half a screen down / up (also `PgDn` / `PgUp`) |
| `/` | Search the tab by key or summary, jumping to matches as you type: `Ctrl+N` / `Ctrl+P` next / previous, `⏎` keeps the match, `Esc` goes back. After `⏎`, `Ctrl+N` / `Ctrl+P` keep going through the matches |
| `Enter` / `Space` | Show or hide an issue's sub-issues |
| `e` | Show or hide all sub-issues |
| `s` | Change status: any of the team's workflow states, canceling last |
| `A` | Assign: the people on the board first, type to search the workspace |
| `p` | Set the estimate (empty clears it), on the team's scale |
| `!` | Set the priority; urgent issues are marked `!!` on the board, high ones `!` |
| `c` | Create sub-issues of the selected issue: type or paste a list, one per line, `Ctrl+S` to create. They go in its project, and in the cycle (or on the board) shown |
| `C` | Create an issue: `←`/`→` its kind (a plain issue, or a Feature, Improvement or Bug label when the team has those), the summary, `↑`/`↓` where it goes (the backlog, a cycle or the board), `Ctrl+E` for a description. On a board of one project, it goes in that project |
| `S` | Move the issue (with its sub-issues) to another cycle or out of them; without cycles, between the board and the backlog |
| `P` | Move the issue to another project |
| `f` | Show only one project's issues, or all again, in every tab |
| `Tab` / `Shift+Tab` | Next / previous tab: the open cycles (active first) and the backlog; without cycles the board and the backlog |
| `d` | Show the description, rendered from Markdown: `j`/`k` scroll, `h`/`l` scroll code sideways, `r` shows it as written, `e` edits it in `$VISUAL` / `$EDITOR` and saves it when you quit the editor |
| `b` | Open the issue's bench in a new terminal tab, making it first in the default repo (see [Benches](#benches)). On a card with sub-issues, choose the card or one of its sub-issues first |
| `B` | The same, choosing the repo first |
| `F` | Make a new bench whose branch starts from another branch (e.g. its parent's), choosing the repo (when there are several) and the branch |
| `M` | Open the merge request (or pull request) of the issue's bench in the browser |
| `D` | Remove one of the issue's benches, keeping or deleting its local branch |
| `n` | Notifications: issues whose merge request was merged, to move to done in one key (see [Notifications](#notifications)) |
| `o` / `w` | Open the selected issue / the board in the browser |
| `m` | Toggle "only mine" |
| `v` | Cards or a compact list, a line per issue, in every tab (until you press it, only the backlog is a list) |
| `a` | Show all done cards instead of the latest 5 |
| `r` | Reload from Linear (also done every 30 minutes, once nothing is open) |
| `?` | Show all keys |
| `Ctrl+C` | Quit |

Dialogs filter as you type; `Esc` closes them without changing anything.

Issues show their kind by label: `●` Feature, `■` Improvement, `▲` Bug, `•` anything else.

## Configuration

Settings live in `~/.config/lboard/config.json` (or `$XDG_CONFIG_HOME/lboard/config.json`), which setup writes:

```json
{
  "token": "lin_api_...",
  "team": "ENG",
  "project": "Launch",
  "columns": ["Todo", "In Progress", "Done"],
  "theme": "day"
}
```

Each setting can also come from an environment variable, which wins over the file, e.g. for one run:
`LINEAR_TEAM=OPS lboard`.

| Setting | Variable | Meaning |
|---|---|---|
| `token` | `LINEAR_API_KEY` | A personal API key (required) |
| `team` | `LINEAR_TEAM` | The team's key, e.g. `ENG` (required); or pass `--team` |
| `project` | `LBOARD_PROJECT` | Only this project's issues, by name or the start of it; or pass `-P` (`-P ""` for the whole team) |
| `columns` | `LBOARD_COLUMNS` | The board's columns to show, a list or comma separated, e.g. `Todo,In Progress,Done` (default: all); or pass `--columns`. Cards in other columns are left out |
| `hideEmpty` | `LBOARD_HIDE_EMPTY` | Columns to leave out while they have no cards (also with "only mine"), a list or comma separated, e.g. `["In Review"]` |
| `theme` | `LBOARD_THEME` | `night` (default), `day` or `classic` |
| `bench` | `LBOARD_BENCH` | The bench command for `b` and `B` (default `bench`) |
| `branch` | `LBOARD_BRANCH` | Branch name for a new bench, from `{type}` (`fix` for bugs, else `feat`), `{key}` and `{summary}` (default `{type}/{key}-{summary}`) |
| `truecolor` | `LBOARD_TRUECOLOR` | `true` (or `1`) forces 24-bit colour if your terminal supports it but doesn't say so |

The editor for descriptions is `$VISUAL` or `$EDITOR` (default `nvim` if installed, else `vi`); it may include
arguments, e.g. `code -w`.

### Columns

A column per workflow state the team works in (its unstarted and started states, in Linear's order), then one for
the completed states. Canceled and duplicate issues are left out. In a cycle, issues still in a backlog or triage
state show in the first column. The backlog tab is one list: with cycles, what is in no cycle and not done; without
them, what is in a backlog or triage state.

### Benches

`b` and `B` hand the selected issue to [bench](https://github.com/niklaskors/bench), a separate tool that gives a
branch its own git worktree with packages installed, from a pool of ready ones. Install it and add your repos
(`bench add <path>`) to use them; lboard works the same without it.

- An issue's bench is the one whose branch contains its key; otherwise `b` makes one, named after the issue
  (`feat/PROJ-123-short-summary`, or `fix/…` for bugs; see `branch` under [Configuration](#configuration))
- `b` on a sub-issue is for the sub-issue itself; on a card with sub-issues it asks whether the bench is for the card or
  one of its sub-issues (✓ marks those with a bench). `M` and `D` on a sub-issue without a bench of its own use its card's
- `B` picks the repo, so an issue that needs changes in two repos can have a bench in each; ✓ marks where it has one
- `F` makes the new branch from one you choose instead of the repo's base: the parent's branches come first (for a
  sub-issue, to build on its parent), then those with a bench, then the rest, newest first. Typing filters. It needs
  bench's `branches` command, and only makes new branches: an issue whose branch exists already opens with `b`
- `D` removes a bench; bench refuses while it has uncommitted changes or commits that aren't pushed
- Cards with a bench are marked with ⎇, followed by its merge request (e.g. `⎇ !123`) once bench has looked it up
  (with glab for GitLab, gh for GitHub), coloured by state: open, draft, merged or closed; `M` opens it
- Removing a bench keeps its merge request: the card still shows it (without ⎇) and `M` still opens it.
  `b` makes a bench on the same branch again
- The tab opens however bench is set up to open tabs (its `"tab"` and `"command"` settings), titled with the issue's
  key and summary (with oh-my-zsh, its automatic title is turned off in that tab so the title stays)
- When git or ssh needs something while bench runs, such as your SSH key's passphrase or whether to trust a host,
  lboard asks it on the board. A passphrase is hidden while you type it, asked once even when git connects a few
  times, and kept in memory (never on disk) until lboard quits; a wrong one is asked again. To not be asked at all,
  keep it in your SSH agent, e.g. on macOS with `UseKeychain yes` and `AddKeysToAgent yes` in `~/.ssh/config`

### Notifications

When the merge request of an issue's bench has been merged but the issue isn't in the last (done) column yet,
lboard notifies you: the status line says so and the bell top right shows how many (`🔔 2`). `n` lists them, each with the
suggested action of moving the issue to done:

- `⏎` moves it to done (the team's completed state, preferably one called Done)
- `x` dismisses it, `o` opens the merge request
- Handled notifications are remembered in `~/.local/state/lboard/handled.json`, so each comes up once
- Merge requests are looked up when the board starts, on `r`, and every 30 minutes while it is open
- Only merge requests bench knows about count (see [Benches](#benches)); an issue with another merge request
  still open is left alone

### Errors

Failed requests are logged with what was sent and Linear's answer to `~/.cache/lboard/errors.log`.

## Development

```sh
npm install      # TypeScript, Node types and Vitest, only needed for checking and testing
npm run check    # strict type check
npm test         # integration tests
```

The tests run lboard against stand-ins: a small in-memory Linear (`test/fakes/linear.ts`) that answers lboard's
GraphQL operations by name and that lboard's real HTTP client talks to, a fake `bench` (`test/fakes/bench.mjs`), and a
browser and an editor that only record what they were asked to do. `test/cli.test.ts` runs the `lboard` command as a
separate process; the `tui-*` tests drive the interactive board with key presses (`test/tui.ts`) and read back what
it draws as plain text.

Node only strips types, so lboard can only use erasable TypeScript syntax (no enums, namespaces or parameter properties)
and imports must name the `.ts` file; `tsconfig.json` enforces both.

### Project layout

```
bin/lboard.ts          entry point
bin/askpass.ts         run by git and ssh to ask a question, which it hands to lboard
src/cli.ts             options, help text, startup
src/config.ts          settings from the config file and the environment; Linear's web addresses
src/setup.ts           the first run's setup (and --setup): API key, team and project
src/askpass.ts         questions from git and ssh while bench runs, asked on the board (with bin/askpass.ts)
src/browser.ts         opening URLs on macOS, Linux and Windows
src/bench.ts           running the bench tool: listing, naming and opening benches
src/notify.ts          notifications: merged merge requests of issues that aren't done
src/board.ts           a cycle, the active issues or the backlog: columns, cards with their sub-issues, estimates
src/linear/client.ts   GraphQL over HTTP: the API key, retries, error log
src/linear/api.ts      Linear operations: the team, updating and creating issues, projects, labels
src/linear/types.ts    the Linear data lboard uses
src/render/line.ts     styled text lines: wrapping, fitting, overlaying
src/render/theme.ts    the night, day and classic themes
src/render/layout.ts   cards, column headers and the cycle header
src/render/print.ts    the printed board (-p)
src/render/markup.ts   descriptions: Markdown (and Jira wiki markup) as styled lines
src/tui/app.ts         the interactive board: navigation, drawing, keys
src/tui/dialog.ts      the dialog interface and box drawing
src/tui/picker.ts      filter-as-you-type list used by most dialogs
src/tui/assign.ts      A: assign
src/tui/status.ts      s: change status
src/tui/points.ts      p: estimate
src/tui/priority.ts    !: priority
src/tui/project.ts     f: show one project, P: move to a project
src/tui/description.ts d: show and edit the description
src/tui/notifications.ts  n: notifications
src/tui/search.ts      /: search
src/tui/prompt.ts      a question from git or ssh, e.g. a passphrase
src/tui/subtasks.ts    c: create sub-issues
src/tui/create.ts      C: create an issue
src/tui/sprint.ts      S: move to a cycle, or between the board and the backlog
src/tui/wizard.ts      lboard --create
src/tui/bench.ts       b and B: open a bench
```

A new dialog implements `Dialog` (`draw` and `key`) and gets a `DialogHost` to show messages and run Linear changes;
`src/tui/priority.ts` is a small example.

## License

[MIT](LICENSE)
