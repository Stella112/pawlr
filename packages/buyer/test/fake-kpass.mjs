// TEST DOUBLE for the kpass binary. Prints the JSON file named by FAKE_KPASS_OUT
// and exits with FAKE_KPASS_EXIT. Used only by payer.test.ts.
import { readFileSync } from "node:fs";
process.stdout.write(readFileSync(process.env.FAKE_KPASS_OUT, "utf8"));
process.exit(Number(process.env.FAKE_KPASS_EXIT ?? 0));
