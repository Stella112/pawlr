import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Pays one x402 request. The only real implementation is KpassPayer, which
 * drives the Kite Passport CLI (kpass 6.13.2). Command, flags and output
 * fields come from `kpass session execute --help` and Kite's bundled
 * reference ~/.kpass/skills/x402-execute/references/commands.md.
 */
export interface PayRequest {
  url: string;
  headers: Record<string, string>;
  idempotencyKey: string;
}

export type PayResult =
  /** Merchant answered 2xx after payment. `body` is the merchant's JSON. */
  | { kind: "paid"; status: number; body: unknown; raw: unknown; txHash?: string | null }
  /** Nothing was charged (refused before paying, e.g. caps, scope, allowlist, empty wallet). */
  | { kind: "not-charged"; errorCode: string; message: string; raw: unknown }
  /** A payment may have gone through or is held; never pay this tick again. */
  | { kind: "uncertain"; errorCode: string; message: string; txHash: string | null; raw: unknown };

export interface Payer {
  pay(req: PayRequest): Promise<PayResult>;
  /** Looks up the settlement tx hash of a paid request, if the payer can. */
  lookupTxHash?(url: string): Promise<string | null>;
}

const DEFAULT_KPASS = join(homedir(), ".kpass", "bin", process.platform === "win32" ? "kpass.exe" : "kpass");

function run(bin: string, args: string[], cwd?: string, prefix: string[] = []): Promise<{ code: number; json: any; text: string }> {
  return new Promise((resolve) => {
    execFile(bin, [...prefix, ...args], { cwd, timeout: 5 * 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout ?? ""}`.trim() || `${stderr ?? ""}`.trim();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, json, text });
    });
  });
}

export class KpassPayer implements Payer {
  /** `prefixArgs` lets tests run a script in place of kpass (bin = node, prefixArgs = [script]). */
  constructor(private opts: { bin?: string; cwd?: string; sessionId?: string; prefixArgs?: string[] } = {}) {}

  async pay(req: PayRequest): Promise<PayResult> {
    const args = ["session", "execute", "--url", req.url, "--method", "GET", "--headers", JSON.stringify(req.headers), "--idempotency-key", req.idempotencyKey, "--no-interactive", "--output", "json"];
    if (this.opts.sessionId) args.push("--session-id", this.opts.sessionId);
    const { code, json, text } = await run(this.opts.bin ?? DEFAULT_KPASS, args, this.opts.cwd, this.opts.prefixArgs);
    const raw = json ?? text;
    if (code === 0 && json?.status === "success" && json.x402) {
      const status = Number(json.x402.status_code);
      if (status >= 200 && status < 300) {
        let body = json.x402.parsed_response_body;
        if (body === undefined && typeof json.x402.response_body === "string") {
          try {
            body = JSON.parse(json.x402.response_body);
          } catch {
            body = json.x402.response_body;
          }
        }
        return { kind: "paid", status, body, raw };
      }
      // Documented: x402.status_code is the merchant's status. A non-2xx after "success" is treated as uncertain.
      return { kind: "uncertain", errorCode: `merchant_http_${status}`, message: "merchant answered with a non-2xx status", txHash: null, raw };
    }
    const errorCode: string = json?.error_code ?? `exit_${code}`;
    const message: string = json?.error ?? text.slice(0, 300);
    // Exit 7 = payment outcome pending / held (documented). Never retry with a new key.
    if (code === 7) return { kind: "uncertain", errorCode, message, txHash: json?.details?.tx_hash ?? null, raw };
    return { kind: "not-charged", errorCode, message, raw };
  }

  /**
   * Documented in Kite's activity reference: x402_payment events carry
   * details.transaction.tx_hash, and details.transaction.x402 holds the request
   * URL. The exact key of the URL inside `x402` is not documented, so this
   * matches any string value equal to the URL.
   */
  async lookupTxHash(url: string): Promise<string | null> {
    const { json } = await run(this.opts.bin ?? DEFAULT_KPASS, ["activity", "--kind", "x402_payment", "--limit", "20", "--output", "json"], this.opts.cwd, this.opts.prefixArgs);
    for (const ev of json?.events ?? []) {
      const x = ev?.details?.transaction?.x402;
      if (x && Object.values(x).some((v) => v === url)) return ev.details.transaction.tx_hash ?? null;
    }
    return null;
  }
}
