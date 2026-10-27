#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --disable-warning=UNDICI-EHPA
// lboard: a Linear team's cycle or active issues as an interactive kanban board in the terminal.
// Node >= 22.18 runs this TypeScript directly; see the README.

import { run } from "../src/cli.ts";

run();
