// Run by ssh and git (as SSH_ASKPASS / GIT_ASKPASS) when they need a passphrase or an answer while lboard runs
// bench: hands the question to lboard, which asks it on the board, and prints the answer for them.

import { connect } from "node:net";

const socket = process.env.LBOARD_ASKPASS;
if (!socket) process.exit(1);

// pid: which ssh or git asks, so lboard can tell a retry (a wrong passphrase) from another connection
const question = { prompt: process.argv.slice(2).join(" "), confirm: process.env.SSH_ASKPASS_PROMPT === "confirm", pid: process.ppid };
const conn = connect(socket, () => conn.write(`${JSON.stringify(question)}\n`));
let reply = "";
conn.on("data", (chunk) => (reply += chunk));
conn.on("end", () => {
  const { answer } = JSON.parse(reply || "{}") as { answer?: string | null };
  if (answer == null) process.exit(1); // cancelled
  process.stdout.write(`${answer}\n`);
});
conn.on("error", () => process.exit(1));
