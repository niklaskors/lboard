// A small in-memory Linear (GraphQL API) that answers just the operations lboard sends, by their name, so the tests run
// lboard's real HTTP client against it. Every request is recorded, and failures can be injected per operation.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const TOKEN = "lin_api_test";
export const TEAM = "PROJ";
export const TEAM_ID = "team-proj";
export const WORKSPACE = "acme";

/** The team's workflow states by id, in Linear's order. */
export const STATES: Record<string, { name: string; type: string; position: number }> = {
  backlog: { name: "Backlog", type: "backlog", position: 0 },
  "1": { name: "Todo", type: "unstarted", position: 1 },
  "3": { name: "In Progress", type: "started", position: 3 },
  "10": { name: "In Review", type: "started", position: 4 },
  "10001": { name: "Done", type: "completed", position: 5 },
  "6": { name: "Canceled", type: "canceled", position: 6 },
  "7": { name: "Duplicate", type: "duplicate", position: 7 },
};

export const USERS: Record<string, { id: string; name: string; email: string }> = {
  jdoe: { id: "jdoe", name: "Jane Doe", email: "jane@example.com" },
  asmith: { id: "asmith", name: "Alex Smith", email: "alex@example.com" },
  bwayne: { id: "bwayne", name: "Bruce Wayne", email: "bruce@example.com" },
  ckent: { id: "ckent", name: "Clark Kent", email: "clark@example.com" },
};

/** Labels: the kinds lboard knows (one of another team's, which it leaves alone) and one it doesn't. */
export const LABELS = [
  { id: "l-feature", name: "Feature", team: null },
  { id: "l-improvement", name: "Improvement", team: null },
  { id: "l-bug", name: "Bug", team: null },
  { id: "l-other-bug", name: "Bug", team: { id: "team-other" } },
  { id: "l-security", name: "Security", team: null },
];

export interface FakeCycle {
  id: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
}

export interface FakeProject {
  id: string;
  name: string;
  slugId: string;
  completedAt: string | null;
}

export interface FakeIssue {
  key: string;
  summary: string;
  status: string; // state id
  labels: string[]; // label names
  assignee: string | null;
  cycle: string | null;
  parent?: string;
  points?: number | null;
  priority?: number;
  project?: string | null;
  description?: string | null;
  updated: string;
  completedAt?: string;
}

interface RecordedRequest {
  operation: string;
  variables: any;
  query: string;
}

interface Stall {
  operation: string;
  ms: number;
  handled: boolean;
  times: number;
}

interface Failure {
  operation: string;
  status: number;
  body: unknown;
  headers: Record<string, string>;
  times: number;
}

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const at = (minute: number) => `2026-10-0${1 + Math.floor(minute / 60)}T09:${String(minute % 60).padStart(2, "0")}:00.000Z`;

const issue = (key: string, summary: string, status: string, labels: string[], assignee: string | null, more: Partial<FakeIssue> = {}): FakeIssue =>
  ({ key, summary, status, labels, assignee, cycle: "c12", points: null, priority: 0, project: null, description: null,
    updated: at(Number(key.split("-")[1])), completedAt: status === "10001" ? days(-1) : undefined, ...more });

/**
 * The team every test starts from: Cycle 12 is active, Cycle 13 comes next, and four issues have no cycle. PROJ-1 has
 * two sub-issues, PROJ-9 is a sub-issue whose parent isn't in the cycle, and the done column has six cards.
 */
export function fixture(): { cycles: FakeCycle[]; issues: FakeIssue[]; projects: FakeProject[] } {
  return {
    cycles: [
      // the future one first: lboard sorts the active one to the front itself
      { id: "c13", number: 13, name: null, startsAt: days(10), endsAt: days(24) },
      { id: "c12", number: 12, name: null, startsAt: days(-4), endsAt: days(10) },
      { id: "c11", number: 11, name: null, startsAt: days(-18), endsAt: days(-4) }, // over
    ],
    projects: [
      { id: "p-launch", name: "Launch", slugId: "launch-1a2b", completedAt: null },
      { id: "p-billing", name: "Billing", slugId: "billing-3c4d", completedAt: null },
      { id: "p-old", name: "Old stuff", slugId: "old-5e6f", completedAt: days(-30) },
    ],
    issues: [
      issue("PROJ-1", "Login with SSO", "1", ["Feature"], "jdoe",
        { points: 3, project: "p-launch", description: "# Goal\nUsers sign in with **SSO**.\n\n- one\n- two" }),
      issue("PROJ-2", "Add SAML config", "1", [], "jdoe", { parent: "PROJ-1", project: "p-launch" }),
      issue("PROJ-3", "Write login tests", "10001", [], "asmith", { parent: "PROJ-1" }),
      issue("PROJ-4", "Crash on empty board", "3", ["Bug"], "asmith", { points: 2, priority: 1 }),
      issue("PROJ-5", "Upgrade Node", "10", ["Improvement"], null, { priority: 2 }),
      issue("PROJ-9", "Fix flaky deploy", "3", [], "jdoe", { parent: "PROJ-50" }), // its parent is elsewhere
      // six done cards, one more than shown by default; PROJ-6 is the oldest
      issue("PROJ-6", "Dark mode", "10001", ["Feature"], "bwayne", { points: 5 }),
      issue("PROJ-20", "Release notes", "10001", ["Improvement"], "asmith", { points: 1 }),
      issue("PROJ-21", "Cache avatars", "10001", ["Feature"], "jdoe", { points: 2 }),
      issue("PROJ-22", "Retry uploads", "10001", ["Feature"], "bwayne", { points: 1 }),
      issue("PROJ-23", "Remove old flag", "10001", ["Improvement"], "asmith"),
      issue("PROJ-24", "Wrong date format", "6", ["Bug"], "jdoe"), // canceled: not shown
      issue("PROJ-26", "Polish icons", "10001", ["Improvement"], "asmith"),
      issue("PROJ-30", "Billing export", "1", ["Feature"], "asmith", { cycle: "c13", points: 8, project: "p-billing" }),
      issue("PROJ-40", "Search filters", "backlog", ["Feature"], null, { cycle: null, points: 3, project: "p-launch" }),
      issue("PROJ-41", "Typo in footer", "3", ["Bug"], "bwayne", { cycle: null }),
      issue("PROJ-42", "Closed long ago", "10001", ["Improvement"], null, { cycle: null, completedAt: days(-90) }),
      issue("PROJ-43", "Fix the sign-up form", "backlog", ["Bug"], null, { cycle: null, parent: "PROJ-40" }),
    ],
  };
}

const graphqlError = (message: string, code = "INVALID_INPUT") =>
  ({ errors: [{ message, extensions: { code, userPresentableMessage: message } }] });

export class FakeLinear {
  server: Server;
  url = "";
  cycles: FakeCycle[] = [];
  issues: FakeIssue[] = [];
  projects: FakeProject[] = [];
  /** Whether the team plans in cycles; without them its backlog is the Backlog state. */
  cyclesEnabled = true;
  estimation = "fibonacci";
  requests: RecordedRequest[] = [];
  failures: Failure[] = [];
  stalls: Stall[] = [];
  /** Issues per page, whatever `first` asks for. */
  pageSize = 100;
  /** Ids of issues created, by key, to answer a lookup by id. */
  private ids = new Map<string, string>();
  private nextKey = 100;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.reset();
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/graphql`;
    return this.url;
  }

  reset(): void {
    ({ cycles: this.cycles, issues: this.issues, projects: this.projects } = fixture());
    this.cyclesEnabled = true;
    this.estimation = "fibonacci";
    this.requests = [];
    this.failures = [];
    this.stalls = [];
    this.pageSize = 100;
    this.ids = new Map();
    this.nextKey = 100;
  }

  /** Answer the next `times` requests of this operation with this HTTP status and body instead. */
  fail(operation: string, status: number, body: unknown = {}, { times = 1, headers = {} } = {}): void {
    this.failures.push({ operation, status, body, headers, times });
  }

  /** Answer the next `times` requests of this operation with a GraphQL error, as Linear does for a refused change. */
  refuse(operation: string, message: string, { times = 1, code = "INVALID_INPUT" } = {}): void {
    this.fail(operation, 200, graphqlError(message, code), { times });
  }

  /**
   * Answer the next `times` requests of this operation only after `ms`, as a busy Linear does; with `handled` false
   * the request is dropped, as when it never got to Linear.
   */
  stall(operation: string, ms: number, { times = 1, handled = true } = {}): void {
    this.stalls.push({ operation, ms, handled, times });
  }

  get(key: string): FakeIssue {
    const found = this.issues.find((i) => i.key === key);
    if (!found) throw new Error(`no issue ${key}`);
    return found;
  }

  /** The requests of this operation, e.g. "UpdateIssue". */
  calls(operation: string): RecordedRequest[] {
    return this.requests.filter((r) => r.operation === operation);
  }

  // -- the GraphQL API

  private idOf = (i: FakeIssue) => this.ids.get(i.key) ?? `id-${i.key}`;

  private find(id: string): FakeIssue | undefined {
    return this.issues.find((i) => this.idOf(i) === id || i.key === id);
  }

  private toNode(i: FakeIssue): unknown {
    const project = this.projects.find((p) => p.id === i.project);
    return {
      id: this.idOf(i),
      identifier: i.key,
      title: i.summary,
      updatedAt: i.updated,
      priority: i.priority ?? 0,
      estimate: i.points ?? null,
      state: { id: i.status, name: STATES[i.status].name },
      assignee: i.assignee ? USERS[i.assignee] : null,
      parent: i.parent ? { identifier: i.parent } : null,
      project: project ? { id: project.id, name: project.name } : null,
      labels: { nodes: i.labels.map((name) => LABELS.find((l) => l.name === name && !l.team)!).map(({ id, name }) => ({ id, name })) },
      description: i.description ?? null,
    };
  }

  /** Whether an issue matches the parts of IssueFilter lboard uses. */
  private matches(i: FakeIssue, f: any): boolean {
    if (!f) return true;
    const type = STATES[i.status].type;
    const comparator = (value: string | null | undefined, c: any) => {
      if (!c) return true;
      if ("null" in c) return c.null ? value == null : value != null;
      if ("eq" in c) return value === c.eq;
      if ("in" in c) return c.in.includes(value);
      if ("nin" in c) return !c.nin.includes(value);
      if ("gt" in c) return !!value && value > c.gt;
      throw new Error(`comparator ${JSON.stringify(c)} not faked`);
    };
    return comparator(TEAM_ID, f.team?.id)
      && (!f.project || comparator(i.project ?? null, "null" in f.project ? f.project : f.project.id))
      && (!f.cycle || comparator(i.cycle, "null" in f.cycle ? f.cycle : f.cycle.id))
      && comparator(type, f.state?.type)
      && comparator(i.completedAt, f.completedAt)
      && comparator(this.idOf(i), f.id)
      && (!f.or || f.or.some((g: any) => this.matches(i, g)));
  }

  private update(id: string, input: any): [number, unknown] {
    const i = this.find(id);
    if (!i) return [200, graphqlError("Entity not found: Issue", "INVALID_INPUT")];
    if (input.assigneeId && !USERS[input.assigneeId]) return [200, graphqlError("Entity not found: User")];
    if (input.stateId && !STATES[input.stateId]) return [200, graphqlError("Entity not found: WorkflowState")];
    if ("estimate" in input && input.estimate !== null && ![0, 1, 2, 3, 5, 8, 13, 21].includes(input.estimate)) {
      return [200, graphqlError("Estimate is not valid for this team's scale")];
    }
    if ("stateId" in input) {
      i.status = input.stateId;
      i.completedAt = STATES[i.status].type === "completed" ? new Date().toISOString() : undefined;
    }
    if ("assigneeId" in input) i.assignee = input.assigneeId;
    if ("estimate" in input) i.points = input.estimate;
    if ("description" in input) i.description = input.description;
    if ("cycleId" in input) i.cycle = input.cycleId;
    if ("projectId" in input) i.project = input.projectId;
    if ("priority" in input) i.priority = input.priority;
    i.updated = new Date().toISOString();
    return [200, { data: { issueUpdate: { success: true } } }];
  }

  private create(input: any): [number, unknown] {
    if (input.teamId !== TEAM_ID) return [200, graphqlError("Entity not found: Team")];
    if (!input.title || /FAIL/.test(input.title)) return [200, graphqlError("Title is invalid")];
    if (input.id && [...this.ids.values()].includes(input.id)) return [200, graphqlError("Entity already exists")];
    const parent = input.parentId ? this.find(input.parentId) : undefined;
    const created: FakeIssue = {
      key: `${TEAM}-${this.nextKey++}`, summary: input.title, status: input.stateId ?? "backlog",
      labels: (input.labelIds ?? []).map((id: string) => LABELS.find((l) => l.id === id)!.name), assignee: null,
      cycle: input.cycleId ?? null, parent: parent?.key, points: null, priority: 0, project: input.projectId ?? null,
      description: input.description ?? null, updated: new Date().toISOString(),
    };
    if (input.id) this.ids.set(created.key, input.id);
    this.issues.push(created);
    return [200, { data: { issueCreate: { success: true, issue: { identifier: created.key } } } }];
  }

  private team() {
    const now = new Date().toISOString();
    return {
      id: TEAM_ID, key: TEAM, name: "Project", cyclesEnabled: this.cyclesEnabled, issueEstimationType: this.estimation,
      states: { nodes: Object.entries(STATES).map(([id, s]) => ({ id, ...s })) },
      cycles: {
        nodes: (this.cyclesEnabled ? this.cycles : []).filter((c) => c.endsAt > now)
          .map((c) => ({ ...c, isActive: c.startsAt <= now && now < c.endsAt })),
      },
    };
  }

  private route(operation: string, v: any): [number, unknown] {
    const data = (d: unknown): [number, unknown] => [200, { data: d }];
    switch (operation) {
      case "Team": {
        const teams = v.key.toLowerCase() === TEAM.toLowerCase() ? [this.team()] : [];
        return data({ viewer: USERS.jdoe, organization: { urlKey: WORKSPACE }, teams: { nodes: teams } });
      }
      case "MyTeams":
        return data({ viewer: { teams: { nodes: [{ key: TEAM, name: "Project" }, { key: "OPS", name: "Operations" }] } } });
      case "Me":
        return data({ viewer: USERS.jdoe });
      case "BoardIssues": {
        const list = this.issues.filter((i) => this.matches(i, v.filter));
        const start = Number(v.after ?? 0);
        const page = list.slice(start, start + this.pageSize);
        const end = start + page.length;
        return data({ issues: { nodes: page.map((i) => this.toNode(i)), pageInfo: { hasNextPage: end < list.length, endCursor: String(end) } } });
      }
      case "Created":
        return data({ issues: { nodes: this.issues.filter((i) => this.matches(i, { id: { eq: v.id } })).map((i) => ({ identifier: i.key })) } });
      case "Description": {
        const i = this.find(v.id);
        return i ? data({ issue: { description: i.description ?? null } }) : [200, graphqlError("Entity not found: Issue")];
      }
      case "UpdateIssue":
        return this.update(v.id, v.input);
      case "CreateIssue":
        return this.create(v.input);
      case "Users": {
        const q = (v.filter.or[0].name.containsIgnoreCase as string).toLowerCase();
        return data({ users: { nodes: Object.values(USERS).filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(q)) } });
      }
      case "Kinds": {
        const names = (v.filter.or as { name: { eqIgnoreCase: string } }[]).map((o) => o.name.eqIgnoreCase.toLowerCase());
        return data({ issueLabels: { nodes: LABELS.filter((l) => names.includes(l.name.toLowerCase())) } });
      }
      case "Projects":
        return data({ team: { projects: { nodes: this.projects.map((p) => ({ ...p, canceledAt: null })) } } });
      default:
        return [400, graphqlError(`unknown operation ${operation}`, "GRAPHQL_VALIDATION_FAILED")];
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const operation: string = body.operationName ?? "";
    this.requests.push({ operation, variables: body.variables ?? {}, query: body.query ?? "" });

    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };
    if (req.headers.authorization !== TOKEN) {
      return send(400, graphqlError("Authentication required, not authenticated", "AUTHENTICATION_ERROR"));
    }
    const stall = this.stalls.find((f) => f.operation === operation);
    if (stall) {
      if (--stall.times <= 0) this.stalls.splice(this.stalls.indexOf(stall), 1);
      const [status, payload] = stall.handled ? this.route(operation, body.variables ?? {}) : [504, {}];
      await new Promise((resolve) => setTimeout(resolve, stall.ms));
      if (!res.destroyed) send(status, payload);
      return;
    }
    const failure = this.failures.find((f) => f.operation === operation);
    if (failure) {
      if (--failure.times <= 0) this.failures.splice(this.failures.indexOf(failure), 1);
      return send(failure.status, failure.body, failure.headers);
    }
    const [status, payload] = this.route(operation, body.variables ?? {});
    send(status, payload);
  }
}
