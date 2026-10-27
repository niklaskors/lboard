// HTTP access to Linear's GraphQL API: the API key, retries and an error log.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { API_URL, TOKEN } from "../config.ts";

const RETRY_CODES = new Set([429, 502, 503, 504]);
const ATTEMPTS = 3;
const ERROR_LOG = join(homedir(), ".cache", "lboard", "errors.log");
// errors that mean the request never left this machine, so even a create can be sent again
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const timings = { request: 30_000, retry: 1_500 };

/** Anything that went wrong talking to Linear, with a message meant for the user. */
export class LinearError extends Error {}

/** A change Linear didn't answer: it may have made it anyway, so it isn't repeated blindly. */
export class LinearUnanswered extends LinearError {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a request may take and the pause before a retry; the tests shorten them. */
export function setTimings(changes: Partial<typeof timings>): void {
  Object.assign(timings, changes);
}

function log(attempt: number, what: string, details: string): void {
  try {
    mkdirSync(dirname(ERROR_LOG), { recursive: true });
    const stamp = new Date().toLocaleString("sv-SE"); // 2026-10-01 09:33:24
    appendFileSync(ERROR_LOG, `--- ${stamp} attempt ${attempt}/${ATTEMPTS} ${what}\n${details}\n\n`);
  } catch {
    // logging is best effort
  }
}

interface GraphQLError {
  message: string;
  extensions?: { code?: string; userPresentableMessage?: string };
}

/** Linear's own explanation from a response body, e.g. "Entity not found: Issue". */
export function linearMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { errors?: GraphQLError[] };
    return (parsed.errors ?? []).map((e) => e.extensions?.userPresentableMessage || e.message).join("; ");
  } catch {
    return "";
  }
}

/** The operation's name, `query Board(…)` -> Board, for messages and the error log. */
const operationName = (query: string) => /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "request";

/**
 * Send a query or mutation, retrying what fails intermittently. Without an answer a mutation is only sent again when
 * it is `repeatable` (setting a value is, creating something isn't) or never reached Linear; queries always are.
 */
export async function gql<T>(query: string, variables: Record<string, unknown> = {},
  opts: { repeatable?: boolean; token?: string } = {}): Promise<T> {
  const name = operationName(query);
  const repeatable = opts.repeatable ?? !/^\s*mutation/.test(query);
  const headers = { Authorization: opts.token ?? TOKEN, "Content-Type": "application/json", Accept: "application/json" };
  const body = JSON.stringify({ query, variables, operationName: name });
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(API_URL, { method: "POST", headers, body, signal: AbortSignal.timeout(timings.request) });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      const reason = cause?.code ?? cause?.message ?? (e as Error).message;
      log(attempt, `no answer ${name}`, reason);
      const notSent = NOT_SENT_CODES.has(cause?.code ?? "");
      if ((repeatable || notSent) && attempt < ATTEMPTS) {
        await sleep(timings.retry * attempt);
        continue;
      }
      if (!repeatable && !notSent) {
        throw new LinearUnanswered(`no answer from Linear on ${name} (${reason}); it may have done it anyway, `
          + "so check before trying again");
      }
      throw new LinearError(`cannot reach Linear: ${reason}` + (attempt > 1 ? ` (${attempt} attempts)` : ""));
    }
    const text = await res.text().catch(() => "");
    let parsed: { data?: T; errors?: GraphQLError[] } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      // not JSON, e.g. a proxy's error page
    }
    if (res.ok && parsed.data && !parsed.errors?.length) return parsed.data;

    log(attempt, `HTTP ${res.status} ${name}`, `${JSON.stringify(variables).slice(0, 500)}\n\n${text.slice(0, 500)}`);
    const limited = parsed.errors?.some((e) => e.extensions?.code === "RATELIMITED");
    if ((RETRY_CODES.has(res.status) || limited) && attempt < ATTEMPTS) {
      const retryAfter = res.headers.get("retry-after") ?? "";
      await sleep(/^\d+$/.test(retryAfter) ? Math.min(10, Number(retryAfter)) * 1000 : timings.retry * attempt);
      continue;
    }
    const message = linearMessage(text);
    if (res.status === 401 || parsed.errors?.some((e) => e.extensions?.code === "AUTHENTICATION_ERROR")) {
      throw new LinearError(`Linear refuses the API key${message ? ` (${message})` : ""}: run lboard --setup to enter a new one`);
    }
    throw new LinearError(`${res.ok ? `${name} failed` : `HTTP ${res.status} on ${name}`}`
      + (attempt > 1 ? ` after ${attempt} attempts` : "") + (message ? `: ${message}` : "") + ` - details in ${ERROR_LOG}`);
  }
}

export interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/** Every node of a paginated connection, a page at a time; `pick` finds the connection in each answer. */
export async function all<T, R>(query: string, variables: Record<string, unknown>, pick: (data: R) => Connection<T>): Promise<T[]> {
  const nodes: T[] = [];
  for (let after: string | null = null; ;) {
    const page: Connection<T> = pick(await gql<R>(query, { ...variables, after }));
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor || !page.nodes.length) return nodes;
    after = page.pageInfo.endCursor;
  }
}
