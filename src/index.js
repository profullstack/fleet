// @profullstack/fleet: read an OpenDevice inventory (logicsrc.com/docs/opendevice),
// add up what the fleet costs a month, and hand those costs to the tools that need
// them (CoinPay finances, the ThreatCrush dashboard, w3bs.org/fleet).
//
// Pure functions only; nothing here touches the network except loadInventory.
// Observation of public metadata lives in ./observe.js and is Node-only.

export const SPEC = 'https://logicsrc.com/docs/opendevice';
export const PROFILES = ['server', 'desktop', 'phone', 'tablet', 'other'];
export const STATUSES = ['active', 'standby', 'retired', 'unknown'];
export const INTERVALS = ['hour', 'month', 'year', 'once'];
const HOURS_PER_MONTH = 730;

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);

function defaultProfile(d) {
  if (PROFILES.includes(d.profile)) return d.profile;
  const hasNet = list(d.hostnames).length || list(d.addresses?.ipv4).length || list(d.addresses?.ipv6).length;
  return hasNet ? 'server' : 'other';
}

/**
 * Normalize an inventory: every device gets an id, a profile and a status, and the
 * inventory's default currency is applied to costs that state none. Unknown keys
 * are kept, per the spec.
 */
export function parseInventory(input) {
  const doc = typeof input === 'string' ? JSON.parse(input) : input;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.devices)) {
    throw new TypeError('OpenDevice inventory needs a "devices" array');
  }
  const currency = typeof doc.currency === 'string' ? doc.currency.toUpperCase() : undefined;
  const seen = new Set();
  const devices = doc.devices.map((raw, i) => {
    const d = { ...raw };
    d.name = typeof d.name === 'string' && d.name ? d.name : `device-${i + 1}`;
    let id = typeof d.id === 'string' && d.id ? d.id : slug(d.name) || `device-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    d.id = id;
    d.profile = defaultProfile(d);
    d.status = STATUSES.includes(d.status) ? d.status : 'active';
    d.hostnames = list(d.hostnames);
    d.addresses = { ...d.addresses, ipv4: list(d.addresses?.ipv4), ipv6: list(d.addresses?.ipv6) };
    if (d.cost && typeof d.cost === 'object') {
      d.cost = { ...d.cost };
      d.cost.currency = (d.cost.currency || currency || 'USD').toUpperCase();
      if (!d.cost.interval) d.cost.interval = 'month';
      if (!d.cost.category) d.cost.category = d.profile === 'server' || d.profile === 'other' ? 'hosting' : 'devices';
    }
    return d;
  });
  return { ...doc, currency, devices };
}

const SECRET_KEYS = ['password', 'secret', 'token', 'private_key', 'api_key'];

function hasKey(value, keys) {
  if (!value || typeof value !== 'object') return null;
  for (const [k, v] of Object.entries(value)) {
    if (keys.includes(k.toLowerCase())) return k;
    const inner = hasKey(v, keys);
    if (inner) return inner;
  }
  return null;
}

/** Problems a reader should show; an inventory with only warnings is still usable. */
export function validateInventory(input) {
  const errors = [];
  const warnings = [];
  let inv;
  try {
    inv = parseInventory(input);
  } catch (err) {
    return { valid: false, errors: [err.message], warnings };
  }
  const raw = (typeof input === 'string' ? JSON.parse(input) : input).devices;
  const groups = new Map();
  inv.devices.forEach((d, i) => {
    const at = `devices[${i}] (${d.id})`;
    if (!raw[i]?.name) errors.push(`${at}: name is required`);
    if (raw[i]?.profile && !PROFILES.includes(raw[i].profile)) warnings.push(`${at}: unknown profile "${raw[i].profile}"`);
    if (raw[i]?.number || raw[i]?.phone_number) errors.push(`${at}: a phone number is never part of an OpenDevice record`);
    const secret = hasKey(raw[i], SECRET_KEYS);
    if (secret) errors.push(`${at}: credentials ("${secret}") never belong in an inventory`);
    const c = d.cost;
    if (c) {
      if (!INTERVALS.includes(c.interval)) errors.push(`${at}: cost.interval must be one of ${INTERVALS.join(', ')}`);
      if (c.amount != null && !(typeof c.amount === 'number' && Number.isFinite(c.amount) && c.amount >= 0)) {
        errors.push(`${at}: cost.amount must be a non-negative number`);
      }
      if (c.amount == null && !c.group) warnings.push(`${at}: cost has no amount (counted as unstated)`);
      if (c.group) {
        const g = groups.get(c.group) ?? [];
        g.push({ id: d.id, amount: c.amount });
        groups.set(c.group, g);
      }
    } else if (d.status !== 'retired') {
      warnings.push(`${at}: no cost stated`);
    }
  });
  for (const [g, members] of groups) {
    const payers = members.filter((m) => m.amount != null);
    if (payers.length !== 1) warnings.push(`cost.group "${g}": exactly one device should state the amount (found ${payers.length})`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

function inWindow(cost, now) {
  const t = now.getTime();
  if (cost.since && Date.parse(cost.since) > t) return false;
  if (cost.until && Date.parse(cost.until) < t) return false;
  return true;
}

const round = (n) => Math.round(n * 100) / 100;

/**
 * One device's monthly run rate, per the spec's Cost section.
 * state: stated | unstated | grouped | ended | once | retired
 */
export function monthlyCost(device, { now = new Date() } = {}) {
  const c = device.cost;
  if (device.status === 'retired') return { amount: 0, currency: c?.currency ?? null, state: 'retired' };
  if (!c) return { amount: null, currency: null, state: 'unstated' };
  if (c.amount == null) return { amount: null, currency: c.currency ?? null, state: c.group ? 'grouped' : 'unstated' };
  if (!inWindow(c, now)) return { amount: 0, currency: c.currency, state: 'ended' };
  const a = c.amount;
  switch (c.interval) {
    case 'hour':
      return { amount: round(a * HOURS_PER_MONTH), currency: c.currency, state: 'stated' };
    case 'year':
      return { amount: round(a / 12), currency: c.currency, state: 'stated' };
    case 'once': {
      const months = Number(c.amortize_months);
      if (!(months > 0) || !c.since) return { amount: 0, currency: c.currency, state: 'once' };
      const end = new Date(c.since);
      end.setMonth(end.getMonth() + months);
      if (now > end) return { amount: 0, currency: c.currency, state: 'ended' };
      return { amount: round(a / months), currency: c.currency, state: 'stated' };
    }
    default:
      return { amount: round(a), currency: c.currency, state: 'stated' };
  }
}

const add = (map, key, n) => map.set(key, round((map.get(key) ?? 0) + n));
const obj = (map) => Object.fromEntries([...map.entries()].sort());

/**
 * The fleet's monthly run rate. Totals are per currency; nothing is converted.
 * A group's cost is counted once, from the device that states the amount.
 */
export function fleetCost(input, { now = new Date() } = {}) {
  const inv = parseInventory(input);
  const total = new Map();
  const byProvider = new Map();
  const byProfile = new Map();
  const byScope = new Map();
  const devices = inv.devices.map((d) => {
    const m = monthlyCost(d, { now });
    if (m.state === 'stated' && m.amount > 0) {
      add(total, m.currency, m.amount);
      add(byProvider, `${d.provider?.name ?? 'self'} ${m.currency}`, m.amount);
      add(byProfile, `${d.profile} ${m.currency}`, m.amount);
      add(byScope, `${d.cost.scope ?? 'business'} ${m.currency}`, m.amount);
    }
    return { id: d.id, name: d.name, profile: d.profile, status: d.status, provider: d.provider?.name ?? null, monthly: m };
  });
  return {
    monthly: obj(total),
    by_provider: obj(byProvider),
    by_profile: obj(byProfile),
    by_scope: obj(byScope),
    devices,
    unstated: devices.filter((d) => d.monthly.state === 'unstated').map((d) => d.id),
    counted: devices.filter((d) => d.monthly.state === 'stated').length,
  };
}

/** Next billing date: next_due if stated, else the next monthly anniversary of since. */
function nextDue(cost, now) {
  if (cost.next_due) return new Date(cost.next_due).toISOString();
  if (!cost.since || cost.interval !== 'month') return null;
  const d = new Date(cost.since);
  while (d <= now) d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

const CADENCE = { hour: 'monthly', month: 'monthly', year: 'yearly', once: 'monthly' };

/**
 * Costs in the shape CoinPay finances uses for a recurring charge, one per device
 * with a stated run rate. `key` is stable, so re-importing updates instead of
 * adding. CoinPay matches each one against bank charges by payee before counting it.
 */
export function toCoinPayCosts(input, { now = new Date(), source = 'opendevice' } = {}) {
  const inv = parseInventory(input);
  return inv.devices
    .map((d) => ({ d, m: monthlyCost(d, { now }) }))
    .filter(({ m }) => m.state === 'stated' && m.amount > 0)
    .map(({ d, m }) => ({
      key: `device:${d.id}`,
      payee: d.cost.payee ?? d.provider?.name ?? d.name,
      amount: d.cost.interval === 'hour' || d.cost.interval === 'once' ? m.amount : d.cost.amount,
      currency: m.currency,
      cadence: CADENCE[d.cost.interval],
      monthlyEquivalent: m.amount,
      scope: d.cost.scope ?? 'business',
      category: d.cost.category,
      paidWith: d.cost.paid_with ?? null,
      nextExpected: nextDue(d.cost, now),
      device: { id: d.id, name: d.name, profile: d.profile, provider: d.provider?.name ?? null },
      source,
    }));
}

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\.$/, '');

/**
 * Join inventory devices with agent-reported machines (ThreatCrush servers,
 * W3BS fleet machines). An agent row matches a device when its hostname, name or
 * IP equals one of the device's id, name, hostnames or addresses. Returns every
 * device, agent or not, plus the agent rows that match no device.
 */
export function matchAgents(input, agents, { hostname = (a) => a.hostname, name = (a) => a.name, ip = (a) => a.ip_address } = {}) {
  const inv = parseInventory(input);
  const used = new Set();
  const devices = inv.devices.map((d) => {
    const keys = new Set([d.id, d.name, ...d.hostnames, ...d.addresses.ipv4, ...d.addresses.ipv6].map(norm));
    const hits = [];
    agents.forEach((a, i) => {
      if (used.has(i)) return;
      if ([hostname(a), name(a), ip(a)].some((v) => v && keys.has(norm(v)))) {
        used.add(i);
        hits.push(a);
      }
    });
    return { device: d, agents: hits };
  });
  return { devices, unmatched: agents.filter((_, i) => !used.has(i)) };
}

/** Read an inventory from an http(s) URL or a local path (Node). */
export async function loadInventory(where, { headers } = {}) {
  if (/^https?:\/\//.test(where)) {
    const res = await fetch(where, { headers });
    if (!res.ok) throw new Error(`${where}: HTTP ${res.status}`);
    return parseInventory(await res.text());
  }
  const { readFile } = await import('node:fs/promises');
  return parseInventory(await readFile(where, 'utf8'));
}

/** A per-currency total for display: "$1,234.00 + €53.00". */
export function formatMonthly(monthly) {
  const parts = Object.entries(monthly ?? {}).map(([cur, n]) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n),
  );
  return parts.length ? parts.join(' + ') : '—';
}
