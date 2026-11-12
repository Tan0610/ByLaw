const DEC = 6;

/** "100000000" -> "100.00" (6 decimals). */
export function fmtToken(raw: string | number | bigint | undefined | null, digits = 2): string {
  if (raw === undefined || raw === null || raw === "") return "0.00";
  let v: bigint;
  try { v = BigInt(raw); } catch { return String(raw); }
  const neg = v < 0n; if (neg) v = -v;
  const base = 10n ** BigInt(DEC);
  const whole = v / base;
  const frac = (v % base).toString().padStart(DEC, "0").slice(0, digits);
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${w}${digits ? "." + frac : ""}`;
}

/** "12.5" -> "12500000". Throws on bad input. */
export function parseToken(input: string): string {
  const s = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error("Enter a number with up to 6 decimals");
  const [w, f = ""] = s.split(".");
  return (BigInt(w) * 10n ** 6n + BigInt(f.padEnd(6, "0"))).toString();
}

export function pct(part: string, whole: string): number {
  const w = BigInt(whole || "0");
  if (w === 0n) return 0;
  const p = BigInt(part || "0");
  const r = Number((p * 10000n) / w) / 100;
  return Math.max(0, Math.min(100, r));
}

export function fmtNs(ns: string | number): string {
  const n = Number(ns) / 1e9;
  if (n >= 86400) return `${+(n / 86400).toFixed(1)} d`;
  if (n >= 3600) return `${+(n / 3600).toFixed(1)} h`;
  if (n >= 60) return `${+(n / 60).toFixed(1)} min`;
  return `${n} s`;
}

export function fmtTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** "analyst1.tan-bylaw-app.testnet" -> "analyst1". Two-part names (alice.testnet) are shown in full. */
export function shortAcct(a?: string | null): string {
  if (!a) return "";
  const parts = a.split(".");
  return parts.length > 2 ? parts[0] : a;
}

export function shortHash(h?: string | null): string {
  if (!h) return "";
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

export function bpsPct(bps: number): string {
  return `${+(bps / 100).toFixed(2)}%`;
}

/** Waterfall preview exactly as CONTRACT_SPEC 4.9 (treasury gets all rounding). */
export function waterfall(price: string, split: { reviewer: number; producer: number; sales: number; seats: number }) {
  const P = BigInt(price);
  const part = (b: number) => (P * BigInt(b)) / 10000n;
  const reviewer = part(split.reviewer), producer = part(split.producer), sales = part(split.sales), seats = part(split.seats);
  const treasury = P - reviewer - producer - sales - seats;
  return {
    reviewer: reviewer.toString(), producer: producer.toString(), sales: sales.toString(),
    seats: seats.toString(), treasury: treasury.toString(),
  };
}
