// `s`: move an issue to another of its team's workflow states.

import { sortStates } from "../board.ts";
import { transitionIssue, transitions } from "../linear/api.ts";
import type { Transition } from "../linear/types.ts";
import type { Item } from "../render/layout.ts";
import type { Dialog, DialogHost } from "./dialog.ts";
import { Picker, type PickerOption } from "./picker.ts";

/** Closing an issue without doing it: canceled, or a duplicate. */
export const rejects = (t: Transition) => /cancel|duplicate|reject/i.test(`${t.name} ${t.to.name}`);

export function openStatus(host: DialogHost, item: Item): Dialog {
  const { issue } = item;
  const list = transitions(sortStates(host.board.teamInfo?.states ?? []), issue.fields.status.id);

  const option = (t: Transition): PickerOption => {
    const col = host.board.columns.find((c) => c.statuses.has(t.to.id));
    return {
      label: t.to.name,
      note: col ? `→ ${col.name}` : "not on this board",
      dim: !col || rejects(t),
      choose: () => host.perform(`moving ${issue.key} to ${t.to.name}…`, async () => {
        await transitionIssue(issue.id, t.id);
        issue.fields.status = { id: t.to.id, name: t.to.name };
        issue.fields.updated = new Date().toISOString(); // shows first among the done cards
        return `${issue.key} is now ${t.to.name}`;
      }, (message) => `status change failed: ${message}`),
    };
  };

  return new Picker(host, {
    title: `Move ${issue.key} (now ${issue.fields.status.name})`,
    action: "move",
    options(query) {
      const q = query.trim().toLowerCase();
      // canceling goes last, so the cursor never starts on it and a stray enter can't cancel
      return [...list.filter((t) => !rejects(t)), ...list.filter(rejects)]
        .filter((t) => !q || t.to.name.toLowerCase().includes(q))
        .map(option);
    },
    empty: () => (list.length ? "no matching status" : "no other status"),
    loading: () => false,
  });
}
