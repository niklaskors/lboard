// `f`: show only one project's issues on the board, or all again; `P`: move an issue to another project.

import { teamProjects, updateIssue } from "../linear/api.ts";
import type { Project } from "../linear/types.ts";
import type { Item } from "../render/layout.ts";
import type { Dialog, DialogHost } from "./dialog.ts";
import { Picker, type PickerOption } from "./picker.ts";

/** A picker of the team's open projects, after `first`; loaded in the background. */
function projectPicker(host: DialogHost, title: string, action: string, first: string,
  option: (project: Project | null, label: string) => PickerOption): Picker {
  let projects: Project[] = [];
  let loading = true;
  const picker = new Picker(host, {
    title,
    action,
    options(query) {
      const q = query.trim().toLowerCase();
      return [option(null, first), ...projects.map((p) => option(p, p.name))].filter((o) => !q || o.label.toLowerCase().includes(q));
    },
    empty: () => (loading ? "loading projects…" : "no matching project"),
    loading: () => loading,
  });
  teamProjects(host.board.teamId).then((list) => {
    projects = list;
    loading = false;
    picker.sel = Math.max(0, picker.source.options("").findIndex((o) => o.current));
    if (host.dialog === picker) host.draw();
  }, (e: Error) => {
    if (host.dialog !== picker) return;
    host.close();
    host.msg = `could not load projects: ${e.message}`;
    host.draw();
  });
  return picker;
}

export function openProjectFilter(host: DialogHost, apply: (project: Project | null) => Promise<void>): Dialog {
  const shown = host.board.project?.id ?? null;
  return projectPicker(host, `Show the issues of`, "show", `All of ${host.board.team}`, (project, label) => ({
    label,
    note: project ? "" : "every project, and none",
    current: (project?.id ?? null) === shown,
    choose: () => host.perform(`loading ${label}…`, async () => {
      await apply(project);
      return project ? `only ${project.name} · f to show all` : `all of ${host.board.team}`;
    }, (message) => `loading ${label} failed: ${message}`),
  }));
}

export function openSetProject(host: DialogHost, item: Item): Dialog {
  const { issue } = item;
  const now = issue.fields.project?.id ?? null;
  return projectPicker(host, `Move ${issue.key} to the project`, "move", "No project", (project, label) => ({
    label,
    note: "",
    current: (project?.id ?? null) === now,
    dim: !project,
    choose: () => host.perform(`moving ${issue.key} to ${label}…`, async () => {
      await updateIssue(issue.id, { projectId: project?.id ?? null });
      issue.fields.project = project && { id: project.id, name: project.name };
      if (host.board.project && project?.id !== host.board.project.id) await host.reload(); // it leaves this board
      return project ? `${issue.key} is in ${project.name}` : `${issue.key} is in no project`;
    }, (message) => `moving ${issue.key} failed: ${message}`),
  }));
}
