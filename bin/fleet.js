#!/usr/bin/env node
// fleet: read an OpenDevice inventory, show what the fleet costs a month, observe
// public metadata, and export costs for CoinPay.
import { writeFile } from 'node:fs/promises';
import { fleetCost, formatMonthly, loadInventory, toCoinPayCosts, validateInventory } from '../src/index.js';
import { observeInventory } from '../src/observe.js';

const HELP = `fleet - OpenDevice inventories (https://logicsrc.com/docs/opendevice)

Usage:
  fleet list     [inventory]   Every device, its profile, provider and monthly cost
  fleet cost     [inventory]   Monthly run rate: total, by provider, profile, scope
  fleet validate [inventory]   Errors and warnings against the spec
  fleet observe  [inventory]   Collect public metadata (DNS, PTR, ASN, TLS, SSH, ports)
                               --write saves it back into the file
  fleet coinpay  [inventory]   Costs as CoinPay recurring charges (JSON)

  inventory is a path or an https URL; default $FLEET_INVENTORY or ./opendevice.json
  --json         machine output     --header "K: V"  send a header with a URL
`;

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] === '--header'));
const [cmd, where = process.env.FLEET_INVENTORY || './opendevice.json'] = positional;
const json = flag('--json');
const out = (v) => process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n`);

function headers() {
  const h = opt('--header');
  if (!h) return undefined;
  const i = h.indexOf(':');
  return { [h.slice(0, i).trim()]: h.slice(i + 1).trim() };
}

function pad(rows) {
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((v, c) => String(v).padEnd(w[c])).join('  ').trimEnd()).join('\n');
}

async function main() {
  if (!cmd || cmd === 'help' || flag('--help') || flag('-h')) return out(HELP);
  const inv = await loadInventory(where, { headers: headers() });
  if (cmd === 'validate') {
    const r = validateInventory(inv);
    if (json) return out(r);
    for (const e of r.errors) out(`error: ${e}`);
    for (const w of r.warnings) out(`warn:  ${w}`);
    out(r.valid ? `ok: ${inv.devices.length} devices` : 'invalid');
    process.exitCode = r.valid ? 0 : 1;
    return;
  }
  if (cmd === 'list' || cmd === 'cost') {
    const c = fleetCost(inv);
    if (json) return out(cmd === 'list' ? c.devices : c);
    if (cmd === 'list') {
      const rows = [['ID', 'PROFILE', 'STATUS', 'PROVIDER', '$/MO']];
      for (const d of c.devices) {
        const m = d.monthly;
        rows.push([d.id, d.profile, d.status, d.provider ?? '-', m.state === 'stated' ? formatMonthly({ [m.currency]: m.amount }) : m.state]);
      }
      out(pad(rows));
    }
    out(`\nMonthly: ${formatMonthly(c.monthly)}  (${c.counted} counted${c.unstated.length ? `, unstated: ${c.unstated.join(', ')}` : ''})`);
    if (cmd === 'cost') {
      for (const [label, m] of [['provider', c.by_provider], ['profile', c.by_profile], ['scope', c.by_scope]]) {
        out(`\nBy ${label}:`);
        for (const [k, v] of Object.entries(m)) {
          const cur = k.split(' ').pop();
          out(`  ${k.slice(0, -cur.length - 1).padEnd(20)} ${formatMonthly({ [cur]: v })}`);
        }
      }
    }
    return;
  }
  if (cmd === 'coinpay') return out(toCoinPayCosts(inv));
  if (cmd === 'observe') {
    const next = await observeInventory(inv);
    if (flag('--write')) {
      if (/^https?:/.test(where)) throw new Error('--write needs a local file');
      await writeFile(where, `${JSON.stringify({ ...next, updated: new Date().toISOString() }, null, 2)}\n`);
      return out(`observed ${next.devices.filter((d) => d.observed).length} devices -> ${where}`);
    }
    return out(next.devices.map((d) => ({ id: d.id, observed: d.observed ?? null })));
  }
  out(HELP);
  process.exitCode = 2;
}

main().catch((err) => {
  process.stderr.write(`fleet: ${err.message}\n`);
  process.exitCode = 1;
});
