/** Set the password the phone (or any device that is not this Mac) logs in with: npm run password */
import readline from "node:readline";
import { setPassword } from "./auth.ts";

function ask(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
    let muted = false;
    out._writeToOutput = (s) => {
      if (!muted || s.includes(q)) out.output.write(s);
    };
    rl.question(q, (a) => {
      rl.close();
      process.stdout.write("\n");
      resolve(a);
    });
    muted = true;
  });
}

const pw = await ask("New Edit Room password: ");
if (pw.length < 10) {
  console.error("Use at least 10 characters (a few random words is good).");
  process.exit(1);
}
if ((await ask("Same again: ")) !== pw) {
  console.error("They don't match. Nothing changed.");
  process.exit(1);
}
setPassword(pw);
console.log("Saved. Every device that was logged in has been signed out.");
