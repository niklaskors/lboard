// Runs before each test file: the fake world first, so lboard's modules load with its settings.

import { beforeEach } from "vitest";
import { resetWorld } from "./harness.ts";

beforeEach(resetWorld);
