// The Linear queries and changes lboard makes, apart from loading the board's issues (see board.ts).

import { randomUUID } from "node:crypto";
import { gql, LinearError, LinearUnanswered } from "./client.ts";
import type { Issue, Project, Sprint, State, Transition, User } from "./types.ts";

/** What lboard asks of every issue. */
export const ISSUE_FIELDS = `id identifier title updatedAt priority estimate
  state { id name } assignee { id name email } parent { identifier }
  project { id name } labels(first: 20) { nodes { id name } }`;

export interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  updatedAt: string;
  priority: number;
  estimate: number | null;
  state: { id: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
  parent: { identifier: string } | null;
  project: { id: string; name: string } | null;
  labels: { nodes: { id: string; name: string }[] };
}

/** The labels that say what kind of issue it is, in the order the create dialog offers them. */
const KINDS = ["Feature", "Improvement", "Bug"];

export const toUser = (u: { id: string; name: string; email?: string }): User => ({ name: u.id, displayName: u.name, email: u.email });

export function toIssue(node: IssueNode): Issue {
  const labels = node.labels.nodes;
  const kind = KINDS.find((k) => labels.some((l) => l.name.toLowerCase() === k.toLowerCase()));
  return {
    id: node.id,
    key: node.identifier,
    fields: {
      summary: node.title,
      status: node.state,
      assignee: node.assignee ? toUser(node.assignee) : null,
      issuetype: { name: kind ?? "Issue", subtask: !!node.parent },
      updated: node.updatedAt,
      ...node.parent ? { parent: { key: node.parent.identifier } } : {},
      priority: node.priority,
      project: node.project,
      labels,
    },
    points: node.estimate,
  };
}

export interface Team {
  id: string;
  key: string;
  name: string;
  cyclesEnabled: boolean;
  /** "notUsed", "exponential", "fibonacci", "linear" or "tShirt". */
  issueEstimationType: string;
  states: State[];
  /** The active cycle and the ones to come, active first. */
  cycles: Sprint[];
  viewer: User;
  /** The workspace's part of Linear's web addresses. */
  workspace: string;
}

interface CycleNode {
  id: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
}

/** A team by its key, with its workflow states and open cycles, and who I am. */
export async function loadTeam(key: string): Promise<Team> {
  type Answer = {
    viewer: { id: string; name: string; email: string };
    organization: { urlKey: string };
    teams: { nodes: (Omit<Team, "states" | "cycles" | "viewer" | "workspace"> & {
      states: { nodes: State[] };
      cycles: { nodes: CycleNode[] };
    })[] };
  };
  const res = await gql<Answer>(`query Team($key: String!) {
    viewer { id name email }
    organization { urlKey }
    teams(first: 1, filter: { key: { eqIgnoreCase: $key } }) {
      nodes {
        id key name cyclesEnabled issueEstimationType
        states(first: 50) { nodes { id name type position } }
        cycles(first: 20, filter: { endsAt: { gt: ${JSON.stringify(new Date().toISOString())} } }) {
          nodes { id number name startsAt endsAt isActive }
        }
      }
    }
  }`, { key });
  const team = res.teams.nodes[0];
  if (!team) throw new LinearError(`no team ${key} in your Linear workspace (or you are not in it)`);
  const cycles = team.cycles.nodes
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.startsAt.localeCompare(b.startsAt))
    .map((c): Sprint => ({
      id: c.id, name: c.name || `Cycle ${c.number}`, state: c.isActive ? "active" : "future", startDate: c.startsAt, endDate: c.endsAt,
    }));
  return {
    ...team, states: team.states.nodes, cycles, viewer: toUser(res.viewer), workspace: res.organization.urlKey,
  };
}

/** The teams I am in, for setup. */
export async function myTeams(token?: string): Promise<{ key: string; name: string }[]> {
  const res = await gql<{ viewer: { teams: { nodes: { key: string; name: string }[] } } }>(
    "query MyTeams { viewer { teams(first: 100) { nodes { key name } } } }", {}, { token });
  return res.viewer.teams.nodes.sort((a, b) => a.name.localeCompare(b.name));
}

/** Who the API key belongs to; also checks that Linear takes it. */
export async function whoAmI(token?: string): Promise<User> {
  return toUser((await gql<{ viewer: { id: string; name: string; email: string } }>(
    "query Me { viewer { id name email } }", {}, { token })).viewer);
}

/** The statuses an issue can move to: all the team's states but its own, in Linear's order. */
export function transitions(states: State[], current: string): Transition[] {
  return states.filter((s) => s.id !== current).map((s) => ({ id: s.id, name: s.type, to: { id: s.id, name: s.name } }));
}

const UPDATE = `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

/** Change fields of an issue, e.g. { stateId } or { estimate: null }; setting values can safely be sent twice. */
export async function updateIssue(issueId: string, input: Record<string, unknown>): Promise<void> {
  const res = await gql<{ issueUpdate: { success: boolean } }>(UPDATE, { id: issueId, input }, { repeatable: true });
  if (!res.issueUpdate.success) throw new LinearError("Linear did not make the change");
}

export const transitionIssue = (issueId: string, stateId: string) => updateIssue(issueId, { stateId });

/** Assign the issue, or unassign it with `null`. */
export const assignIssue = (issueId: string, user: User | null) => updateIssue(issueId, { assigneeId: user?.name ?? null });

/** Active users whose name, display name or email has the text. */
export async function searchUsers(query: string): Promise<User[]> {
  const q = { containsIgnoreCase: query };
  const res = await gql<{ users: { nodes: { id: string; name: string; email: string }[] } }>(`query Users($filter: UserFilter) {
    users(first: 20, filter: $filter) { nodes { id name email } }
  }`, { filter: { active: { eq: true }, or: [{ name: q }, { displayName: q }, { email: q }] } });
  return res.users.nodes.map(toUser);
}

/** The issue's description, in Markdown; "" when it has none. */
export async function loadDescription(issueId: string): Promise<string> {
  const res = await gql<{ issue: { description: string | null } }>(
    "query Description($id: String!) { issue(id: $id) { description } }", { id: issueId });
  return (res.issue.description ?? "").replace(/\r\n?/g, "\n");
}

/** Move issues to a cycle, or out of any with `null`. */
export async function moveToCycle(issueIds: string[], cycleId: string | null): Promise<void> {
  for (const id of issueIds) await updateIssue(id, { cycleId });
}

export interface IssueType {
  /** The label's id, "" for a plain issue without one. */
  id: string;
  name: string;
}

const typeCache = new Map<string, Promise<IssueType[]>>();

/** What the team's issues can be: a plain issue, or one labelled Feature, Improvement or Bug, as far as it has those. */
export function issueTypes(teamId: string): Promise<IssueType[]> {
  let types = typeCache.get(teamId);
  if (!types) {
    types = gql<{ issueLabels: { nodes: { id: string; name: string; team: { id: string } | null }[] } }>(`query Kinds($filter: IssueLabelFilter) {
      issueLabels(first: 50, filter: $filter) { nodes { id name team { id } } }
    }`, { filter: { or: KINDS.map((k) => ({ name: { eqIgnoreCase: k } })) } }).then((res) => {
      const labels = res.issueLabels.nodes.filter((l) => !l.team || l.team.id === teamId);
      const kinds = KINDS.flatMap((k) => labels.filter((l) => l.name.toLowerCase() === k.toLowerCase()).slice(0, 1));
      return [{ id: "", name: "Issue" }, ...kinds.map((l) => ({ id: l.id, name: l.name }))];
    });
    types.catch(() => typeCache.delete(teamId)); // try again next time
    typeCache.set(teamId, types);
  }
  return types;
}

/** The team's projects that are not completed or canceled, by name. */
export async function teamProjects(teamId: string): Promise<Project[]> {
  type Node = Project & { completedAt: string | null; canceledAt: string | null };
  const res = await gql<{ team: { projects: { nodes: Node[] } } }>(`query Projects($id: String!) {
    team(id: $id) { projects(first: 100) { nodes { id name slugId completedAt canceledAt } } }
  }`, { id: teamId });
  return res.team.projects.nodes.filter((p) => !p.completedAt && !p.canceledAt)
    .map(({ id, name, slugId }) => ({ id, name, slugId })).sort((a, b) => a.name.localeCompare(b.name));
}

/** A project of the team by its name (any case, or the start of it), slug or id. */
export async function findProject(teamId: string, wanted: string): Promise<Project> {
  const projects = await teamProjects(teamId);
  const w = wanted.toLowerCase();
  const found = projects.find((p) => p.id === wanted || p.slugId === wanted || p.name.toLowerCase() === w)
    ?? projects.find((p) => p.name.toLowerCase().startsWith(w));
  if (!found) {
    throw new LinearError(`no open project "${wanted}" in this team; it has: ${projects.map((p) => p.name).join(", ") || "none"}`);
  }
  return found;
}

const CREATE_ATTEMPTS = 3;

export interface NewIssue {
  teamId: string;
  title: string;
  description?: string;
  labelIds?: string[];
  parentId?: string;
  projectId?: string;
  cycleId?: string;
  stateId?: string;
}

/**
 * Create an issue; returns its key. It is given its id up front, so when Linear doesn't answer, whether it was made
 * anyway can be looked up before it is sent again, and Linear refuses a second one with the same id.
 */
export async function createIssue(issue: NewIssue): Promise<string> {
  const input: Record<string, unknown> = { id: randomUUID(), ...issue };
  if (!issue.description) delete input.description;
  if (!issue.labelIds?.length) delete input.labelIds;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await gql<{ issueCreate: { success: boolean; issue: { identifier: string } | null } }>(
        `mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier } } }`, { input });
      if (!res.issueCreate.success || !res.issueCreate.issue) throw new LinearError("Linear did not create the issue");
      return res.issueCreate.issue.identifier;
    } catch (e) {
      if (!(e instanceof LinearUnanswered)) throw e;
      const key = await findCreated(input.id as string).catch(() => undefined);
      if (key) return key;
      if (key === undefined || attempt >= CREATE_ATTEMPTS) throw e; // unknown whether it exists, or out of tries
    }
  }
}

/** The key of the issue with this id, or null when there is none. */
async function findCreated(id: string): Promise<string | null> {
  const res = await gql<{ issues: { nodes: { identifier: string }[] } }>(
    "query Created($id: ID!) { issues(filter: { id: { eq: $id } }) { nodes { identifier } } }", { id });
  return res.issues.nodes[0]?.identifier ?? null;
}

/** Create sub-issues under an issue, one by one; one that Linear refuses doesn't stop the rest. */
export async function createSubIssues(parent: Issue, teamId: string, titles: string[], more: Partial<NewIssue> = {}):
  Promise<{ created: string[]; failed: { summary: string; reason: string }[] }> {
  const created: string[] = [];
  const failed: { summary: string; reason: string }[] = [];
  for (const title of titles) {
    try {
      created.push(await createIssue({
        teamId, title, parentId: parent.id, ...parent.fields.project ? { projectId: parent.fields.project.id } : {}, ...more,
      }));
    } catch (e) {
      if (!(e instanceof LinearError)) throw e;
      failed.push({ summary: title, reason: e.message });
    }
  }
  return { created, failed };
}

/** Linear's priorities, in the order they are offered. */
export const PRIORITIES: { value: number; name: string }[] = [
  { value: 1, name: "Urgent" }, { value: 2, name: "High" }, { value: 3, name: "Medium" }, { value: 4, name: "Low" },
  { value: 0, name: "No priority" },
];

/** Somewhere an issue can be planned: a cycle or out of them, or for a team without cycles its board or backlog. */
export interface Place {
  /** "backlog", or the cycle's id ("" for the board of a team without cycles). */
  id: string;
  name: string;
  note: string;
  /** What to change on an issue to put it here; for a cycle with its sub-issues. */
  input: { cycleId?: string | null; stateId?: string };
}

/** Where the team's issues can go, the backlog first. */
export function places(team: Team): Place[] {
  if (team.cyclesEnabled) {
    const day = (date?: string) => (date ? new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
    return [
      { id: "backlog", name: "Backlog", note: "no cycle", input: { cycleId: null } },
      ...team.cycles.map((c): Place => ({
        id: c.id, name: c.name, input: { cycleId: c.id },
        note: c.state === "active" ? `active${c.endDate ? ` · ends ${day(c.endDate)}` : ""}` : `future${c.startDate ? ` · starts ${day(c.startDate)}` : ""}`,
      })),
    ];
  }
  const states = [...team.states].sort((a, b) => a.position - b.position);
  const backlog = states.find((s) => s.type === "backlog") ?? states.find((s) => s.type === "triage");
  const todo = states.find((s) => s.type === "unstarted") ?? states.find((s) => s.type === "started");
  return [
    ...backlog ? [{ id: "backlog", name: "Backlog", note: backlog.name, input: { stateId: backlog.id } }] : [],
    ...todo ? [{ id: "", name: team.name, note: `the board, as ${todo.name}`, input: { stateId: todo.id } }] : [],
  ];
}
