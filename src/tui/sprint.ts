// `S`: move an issue (with its sub-issues) to another cycle or out of them; for a team without cycles, between its
// board and its backlog.

import { places, updateIssue, type Place } from "../linear/api.ts";
import type { Card } from "../linear/types.ts";
import type { Item } from "../render/layout.ts";
import type { Dialog, DialogHost } from "./dialog.ts";
import { Picker, type PickerOption } from "./picker.ts";

export function openSprint(host: DialogHost, item: Item): Dialog | null {
  const { board } = host;
  if (!board.teamInfo) return null;
  // sub-issues follow their card, so the card is what moves
  const card = item.parent ?? (item.issue as Card);
  // the cycles (or the board) first, so the cursor starts on the next one; the backlog last
  const [backlog, ...rest] = places(board.teamInfo);
  const list = backlog ? [...rest, backlog] : rest;
  const from = board.sprint.id;

  const move = (place: Place) => host.perform(`moving ${card.key} to ${place.name}…`, async () => {
    // a cycle takes the sub-issues along; a state only those that aren't done yet
    const subs = place.input.cycleId !== undefined ? card.subs : card.subs.filter((s) => !board.isDone(s));
    for (const issue of [card, ...subs]) await updateIssue(issue.id, place.input);
    await host.reload();
    host.focus(card.key); // when it is still shown, e.g. moved from one cycle to another while showing the backlog
    return `${card.key} moved to ${place.name}`;
  }, (message) => `moving ${card.key} failed: ${message}`);

  const option = (place: Place): PickerOption => ({
    label: place.name,
    note: place.note,
    current: place.id === from,
    choose: () => (place.id === from ? Promise.resolve(host.close()) : move(place)),
  });

  const picker = new Picker(host, {
    title: `Move ${card.key}${card.subs.length ? " (with its sub-issues)" : ""} to`,
    action: "move",
    options(query) {
      const q = query.trim().toLowerCase();
      return list.map(option).filter((o) => !q || o.label.toLowerCase().includes(q));
    },
    empty: () => "nowhere to move it",
    loading: () => false,
  });
  // start on the first place the issue isn't in
  picker.sel = Math.max(0, picker.source.options("").findIndex((o) => !o.current));
  return picker;
}
