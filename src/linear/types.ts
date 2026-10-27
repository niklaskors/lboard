// What lboard keeps of Linear's issues, users, cycles and workflow states. Issues keep the shape the board was built
// around (a key and fields), so a Linear issue's identifier is its key and its title its summary.

export interface User {
  /** Linear's id of the user. */
  name?: string;
  /** Their full name. */
  displayName?: string;
  email?: string;
}

/** A workflow state's kind: backlog and triage are waiting, canceled and duplicate are closed without being done. */
export type StateType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled" | "duplicate";

export interface State {
  id: string;
  name: string;
  type: StateType;
  position: number;
}

export interface Issue {
  /** Linear's id, which mutations take. */
  id: string;
  /** The identifier, e.g. BO-12. */
  key: string;
  fields: {
    summary: string;
    status: { id: string; name: string };
    assignee: User | null;
    /** The kind of issue, from its labels: Bug, Feature or Improvement, else Issue; sub-issues are subtasks. */
    issuetype: { name: string; subtask?: boolean };
    updated: string;
    parent?: { key: string };
    /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
    priority: number;
    project: { id: string; name: string } | null;
    labels: { id: string; name: string }[];
  };
  points?: number | null; // the estimate
}

/** An issue on the board, with its sub-issues on this board. */
export interface Card extends Issue {
  subs: Issue[];
}

export interface Column {
  name: string;
  statuses: Set<string>;
}

/** A cycle; one with an empty id is the team's board of active issues, for a team without cycles. */
export interface Sprint {
  id: string;
  name: string;
  state?: "active" | "future" | "closed";
  startDate?: string;
  endDate?: string;
}

/** A status an issue can be moved to: in Linear any of the team's workflow states. */
export interface Transition {
  id: string;
  /** The state's type, e.g. "canceled". */
  name: string;
  to: { id: string; name: string };
}

export interface Project {
  id: string;
  name: string;
  slugId: string;
}
