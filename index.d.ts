export const SPEC: string;
export type Profile = 'server' | 'desktop' | 'phone' | 'tablet' | 'other';
export type Status = 'active' | 'standby' | 'retired' | 'unknown';
export type Interval = 'hour' | 'month' | 'year' | 'once';
export const PROFILES: Profile[];
export const STATUSES: Status[];
export const INTERVALS: Interval[];

export interface Cost {
  amount?: number | null;
  currency?: string;
  interval?: Interval;
  payee?: string;
  paid_with?: string;
  scope?: 'business' | 'personal';
  category?: string;
  next_due?: string;
  since?: string;
  until?: string;
  amortize_months?: number;
  group?: string;
  note?: string;
  [key: string]: unknown;
}

export interface Device {
  id: string;
  name: string;
  profile: Profile;
  status: Status;
  role?: string;
  hostnames: string[];
  addresses: { ipv4: string[]; ipv6: string[]; private?: string[] };
  provider?: { name?: string; web?: string; offer?: { descriptor?: string; id?: string }; account?: string };
  location?: { country?: string; region?: string };
  hardware?: Record<string, unknown>;
  os?: { name?: string; version?: string; patch?: string };
  cost?: Cost;
  agents?: Array<{ name: string; version?: string; id?: string }>;
  tags?: string[];
  observed?: Record<string, unknown> & { at?: string };
  vendor?: string;
  model?: string;
  form?: string;
  [key: string]: unknown;
}

export interface Inventory {
  operator?: { name?: string; web?: string; profile?: string };
  updated?: string;
  currency?: string;
  devices: Device[];
  [key: string]: unknown;
}

export type CostState = 'stated' | 'unstated' | 'grouped' | 'ended' | 'once' | 'retired';
export interface Monthly { amount: number | null; currency: string | null; state: CostState }

export interface FleetCost {
  /** Per currency; nothing is converted. */
  monthly: Record<string, number>;
  /** Keys are "<name> <CUR>". */
  by_provider: Record<string, number>;
  by_profile: Record<string, number>;
  by_scope: Record<string, number>;
  devices: Array<{ id: string; name: string; profile: Profile; status: Status; provider: string | null; monthly: Monthly }>;
  unstated: string[];
  counted: number;
}

export interface CoinPayCost {
  key: string;
  payee: string;
  amount: number;
  currency: string;
  cadence: 'monthly' | 'yearly';
  monthlyEquivalent: number;
  scope: string;
  category: string;
  paidWith: string | null;
  nextExpected: string | null;
  device: { id: string; name: string; profile: Profile; provider: string | null };
  source: string;
}

export function parseInventory(input: string | object): Inventory;
export function validateInventory(input: string | object): { valid: boolean; errors: string[]; warnings: string[] };
export function monthlyCost(device: Device, opts?: { now?: Date }): Monthly;
export function fleetCost(input: string | object, opts?: { now?: Date }): FleetCost;
export function toCoinPayCosts(input: string | object, opts?: { now?: Date; source?: string }): CoinPayCost[];
export function matchAgents<A>(
  input: string | object,
  agents: A[],
  opts?: { hostname?: (a: A) => string | null | undefined; name?: (a: A) => string | null | undefined; ip?: (a: A) => string | null | undefined },
): { devices: Array<{ device: Device; agents: A[] }>; unmatched: A[] };
export function loadInventory(where: string, opts?: { headers?: Record<string, string> }): Promise<Inventory>;
export function formatMonthly(monthly: Record<string, number> | undefined): string;
