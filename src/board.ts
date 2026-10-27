// One team's board: its active cycle (or, without cycles, its active issues) or its backlog, optionally only one
// project's issues: columns, cards (with their sub-issues) and estimates.

import { setWorkspace } from "./config.ts";
import { loadTeam, ISSUE_FIELDS, toIssue, type Team, type IssueNode } from "./linear/api.ts";
import { all, LinearError, type Connection } from "./linear/client.ts";
import type { Card, Column, Issue, Project, Sprint, State, User } from "./linear/types.ts";

/** How many done cards are shown unless all are asked for. */
const DONE_LIMIT = 5;
/** Without cycles, the board shows what was done in this many days. */
const DONE_DAYS = 30;

export const assigneeName = (issue: Issue) => issue.fields.assignee?.name;

export function firstName(user: User | null): string {
  if (!user) return "-";
  const name = user.displayName || user.email || "?";
  return name.trim().split(/\s+/)[0]?.slice(0, 12) || "?";
}

export function fullName(user: User): string {
  return user.displayName || user.email || "?";
}

/** The board of a cycle (or of the active issues), or the backlog: what isn't planned yet, shown as one column. */
export type BoardKind = "sprint" | "backlog";

const WAITING = new Set(["triage", "backlog"]);
const WORK = new Set(["unstarted", "started"]);
const STATE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"];

/** The team's states in the order Linear shows them: by type, then by their position. */
export const sortStates = (states: State[]) =>
  [...states].sort((a, b) => STATE_ORDER.indexOf(a.type) - STATE_ORDER.indexOf(b.type) || a.position - b.position);

const ISSUES_QUERY = `query BoardIssues($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: 100, after: $after) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

export class Board {
  /** The team's key, e.g. BO. */
  team: string;
  kind: BoardKind;
  /** A cycle chosen by id; otherwise the board shows whichever cycle is active, or the active issues without one. */
  sprintId: string | null;
  /** Only this project's issues, or all of the team's. */
  project: Project | null = null;
  teamInfo: Team | null = null;
  columns: Column[] = [];
  /** Statuses of the last column, where issues are done (also in the backlog, which has one column). */
  doneStatuses = new Set<string>();
  sprint: Sprint = { id: "", name: "" };
  me = "";
  meUser: User = {};
  cards: Card[] = [];
  /** "estimate" when the team estimates its issues, else null. */
  pointsField: string | null = null;

  /** Names of the board columns to show (any case), or all of them. */
  only: string[];
  /** Names of the board columns (any case) left out while they have no cards. */
  hideEmpty: string[] = [];

  /** A cycle, or with no `sprintId` the active one; or with kind "backlog" the backlog. */
  constructor(team: string, only: string[] = [], kind: BoardKind = "sprint", sprintId?: string) {
    this.team = team;
    this.only = only;
    this.kind = kind;
    this.sprintId = sprintId || null;
  }

  /** Another cycle of this team ("" for the active one), or its backlog (`null`), not loaded yet. */
  view(sprintId: string | null): Board {
    const board = new Board(this.team, this.only, sprintId === null ? "backlog" : "sprint", sprintId ?? undefined);
    board.hideEmpty = this.hideEmpty;
    board.project = this.project;
    return board;
  }

  /** The team's id, once loaded. */
  get teamId(): string {
    return this.teamInfo?.id ?? "";
  }

  /** Whether the team plans its work in cycles; without them the backlog is a state rather than "no cycle". */
  get cycles(): boolean {
    return !!this.teamInfo?.cyclesEnabled;
  }

  async reload(): Promise<void> {
    (await this.fetch())();
  }

  /** Load everything from Linear without showing it yet: the returned function puts it on the board. */
  async fetch(): Promise<() => void> {
    const backlog = this.kind === "backlog";
    const team = await loadTeam(this.team);
    const states = sortStates(team.states);
    const typed = (...types: string[]) => states.filter((s) => types.includes(s.type));

    let cycle: Sprint | null = null;
    if (!backlog && team.cyclesEnabled) {
      cycle = this.sprintId ? team.cycles.find((c) => c.id === this.sprintId) ?? null : team.cycles.find((c) => c.state === "active") ?? null;
      if (this.sprintId && !cycle) throw new LinearError(`cycle ${this.sprintId} is over or not in team ${team.key}`);
    }
    const filter: Record<string, unknown> = { team: { id: { eq: team.id } } };
    if (this.project) filter.project = { id: { eq: this.project.id } };
    const since = new Date(Date.now() - DONE_DAYS * 86_400_000).toISOString();
    if (backlog && team.cyclesEnabled) {
      filter.cycle = { null: true };
      filter.state = { type: { nin: ["completed", "canceled", "duplicate"] } };
    } else if (backlog) {
      filter.state = { type: { in: ["triage", "backlog"] } };
    } else if (cycle) {
      filter.cycle = { id: { eq: cycle.id } };
      filter.state = { type: { nin: ["canceled", "duplicate"] } };
    } else { // no cycle: what is being worked on, and what was done lately
      filter.or = [{ state: { type: { in: ["unstarted", "started"] } } }, { state: { type: { eq: "completed" } }, completedAt: { gt: since } }];
    }
    const nodes = await all<IssueNode, { issues: Connection<IssueNode> }>(ISSUES_QUERY, { filter }, (d) => d.issues);
    const issues = nodes.map(toIssue);
    if (team.issueEstimationType === "notUsed") for (const issue of issues) issue.points = null;

    // sub-issues hang under the topmost of their ancestors on the board; the others are cards themselves
    const byKey = new Map(issues.map((i) => [i.key, i]));
    const top = (issue: Issue): Issue => {
      const seen = new Set<string>();
      let at = issue;
      for (let up = byKey.get(at.fields.parent?.key ?? ""); up && !seen.has(up.key); up = byKey.get(at.fields.parent?.key ?? "")) {
        seen.add(at.key);
        at = up;
      }
      return at;
    };
    const subs = new Map<string, Issue[]>();
    const cards: Card[] = [];
    for (const issue of issues) {
      const root = top(issue);
      if (root !== issue) subs.set(root.key, [...(subs.get(root.key) ?? []), issue]);
      else cards.push({ ...issue, subs: [] });
    }
    for (const card of cards) card.subs = subs.get(card.key) ?? [];

    // a column per state being worked on, then one for done; waiting issues in a cycle go in the first column
    const toColumn = (name: string, list: State[]): Column => ({ name, statuses: new Set(list.map((s) => s.id)) });
    const done = typed("completed");
    const boardColumns = [...typed("unstarted", "started").map((s) => toColumn(s.name, [s])), toColumn(done[0]?.name ?? "Done", done)];
    if (cycle && boardColumns.length > 1) for (const s of typed("triage", "backlog")) boardColumns[0].statuses.add(s.id);
    const wanted = new Set(this.only.map((name) => name.toLowerCase()));
    const unknown = [...this.only, ...this.hideEmpty].filter((name) => !boardColumns.some((c) => c.name.toLowerCase() === name.toLowerCase()));
    if (unknown.length) {
      throw new LinearError(`no column ${unknown.map((n) => `"${n}"`).join(", ")} on this board; it has: ${boardColumns.map((c) => c.name).join(", ")}`);
    }
    // sub-issues in board order (to do, in progress, review, done)
    const order = (issue: Issue) => {
      const idx = boardColumns.findIndex((c) => c.statuses.has(issue.fields.status.id));
      return idx < 0 ? boardColumns.length : idx;
    };
    for (const card of cards) card.subs.sort((a, b) => order(a) - order(b));
    const shown = boardColumns.filter((c) => !wanted.size || wanted.has(c.name.toLowerCase()));
    const waiting = team.cyclesEnabled ? states.filter((s) => WAITING.has(s.type) || WORK.has(s.type)) : typed("triage", "backlog");
    const columns = backlog ? [toColumn("Backlog", waiting)] : shown;
    const sprint: Sprint = backlog ? { id: "backlog", name: "Backlog" } : cycle ?? { id: "", name: team.name };

    // only replace state once everything loaded, so a failed refresh keeps the old board
    return () => {
      setWorkspace(team.workspace);
      this.teamInfo = team;
      this.columns = columns;
      this.doneStatuses = new Set(done.map((s) => s.id));
      this.sprint = sprint;
      this.me = team.viewer.name ?? "";
      this.meUser = team.viewer;
      this.cards = cards;
      this.pointsField = team.issueEstimationType === "notUsed" ? null : "estimate";
    };
  }

  /** Me first, then everyone assigned to something on the board, by name. */
  teamMembers(): User[] {
    const users = new Map<string, User>();
    for (const card of this.cards) {
      for (const issue of [card, ...card.subs]) {
        const user = issue.fields.assignee;
        if (user?.name && user.name !== this.me) users.set(user.name, user);
      }
    }
    return [this.meUser, ...[...users.values()].sort((a, b) => fullName(a).localeCompare(fullName(b)))];
  }

  /** Keys of every card and sub-issue on the board. */
  keys(): string[] {
    return this.cards.flatMap((card) => [card.key, ...card.subs.map((sub) => sub.key)]);
  }

  /** Index of the board column showing this issue's status, or -1. */
  columnOf(issue: Issue): number {
    return this.columns.findIndex((c) => c.statuses.has(issue.fields.status.id));
  }

  isDone(issue: Issue): boolean {
    return this.doneStatuses.has(issue.fields.status.id);
  }

  isMine(card: Card): boolean {
    return [card, ...card.subs].some((i) => assigneeName(i) === this.me);
  }

  /**
   * Cards per shown column, the index in `columns` of each (empty `hideEmpty` columns are left out),
   * how many done cards were left out, and estimates per column of `columns` (hidden cards included).
   */
  buckets(mine: boolean, showAll: boolean): { buckets: Card[][]; cols: number[]; hidden: number; points: number[] } {
    const buckets: Card[][] = this.columns.map(() => []);
    for (const card of this.cards) {
      const idx = this.columnOf(card);
      if (idx >= 0 && (!mine || this.isMine(card))) buckets[idx].push(card);
    }
    const points = buckets.map((b) => b.reduce((sum, card) => sum + (card.points ?? 0), 0));
    let hidden = 0;
    const last = buckets.length - 1;
    if (!showAll && this.kind === "sprint" && buckets[last].length > DONE_LIMIT) {
      buckets[last].sort((a, b) => b.fields.updated.localeCompare(a.fields.updated));
      hidden = buckets[last].length - DONE_LIMIT;
      buckets[last] = buckets[last].slice(0, DONE_LIMIT);
    }
    const hideable = new Set(this.hideEmpty.map((name) => name.toLowerCase()));
    const cols = this.columns.flatMap((c, i) => (buckets[i].length || !hideable.has(c.name.toLowerCase()) ? [i] : []));
    return { buckets: cols.map((i) => buckets[i]), cols, hidden, points };
  }
}
