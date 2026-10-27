// `!`: set an issue's priority.

import { PRIORITIES, updateIssue } from "../linear/api.ts";
import type { Item } from "../render/layout.ts";
import type { Dialog, DialogHost } from "./dialog.ts";
import { Picker } from "./picker.ts";

export function openPriority(host: DialogHost, item: Item): Dialog {
  const { issue } = item;
  return new Picker(host, {
    title: `Priority of ${issue.key}: ${issue.fields.summary}`,
    action: "set",
    options(query) {
      const q = query.trim().toLowerCase();
      return PRIORITIES.filter((p) => !q || p.name.toLowerCase().includes(q)).map((p) => ({
        label: p.name,
        note: "",
        current: p.value === issue.fields.priority,
        dim: p.value === 0,
        choose: () => host.perform(`setting the priority of ${issue.key}…`, async () => {
          await updateIssue(issue.id, { priority: p.value });
          issue.fields.priority = p.value;
          return `${issue.key}: ${p.name.toLowerCase()}`;
        }, (message) => `setting the priority failed: ${message}`),
      }));
    },
    empty: () => "no matching priority",
    loading: () => false,
  }, Math.max(0, PRIORITIES.findIndex((p) => p.value === issue.fields.priority)));
}
