import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fleetCost, matchAgents, monthlyCost, parseInventory, toCoinPayCosts, validateInventory } from '../src/index.js';

const example = JSON.parse(readFileSync(new URL('../example.json', import.meta.url), 'utf8'));
const now = new Date('2026-10-28T12:00:00Z');

test('smallest inventory is valid and gets defaults', () => {
  const inv = parseInventory({ devices: [{ name: 'app1' }] });
  assert.equal(inv.devices[0].id, 'app1');
  assert.equal(inv.devices[0].profile, 'other');
  assert.equal(inv.devices[0].status, 'active');
  assert.equal(validateInventory({ devices: [{ name: 'app1' }] }).valid, true);
});

test('profile defaults to server when the device has an address', () => {
  assert.equal(parseInventory({ devices: [{ name: 'x', addresses: { ipv4: ['203.0.113.1'] } }] }).devices[0].profile, 'server');
});

test('duplicate ids are made unique', () => {
  const inv = parseInventory({ devices: [{ name: 'a' }, { name: 'a' }] });
  assert.notEqual(inv.devices[0].id, inv.devices[1].id);
});

test('monthly run rate per interval', () => {
  const d = (cost, extra = {}) => parseInventory({ devices: [{ name: 'x', cost, ...extra }] }).devices[0];
  assert.deepEqual(monthlyCost(d({ amount: 10 }), { now }), { amount: 10, currency: 'USD', state: 'stated' });
  assert.equal(monthlyCost(d({ amount: 120, interval: 'year' }), { now }).amount, 10);
  assert.equal(monthlyCost(d({ amount: 0.01, interval: 'hour' }), { now }).amount, 7.3);
  assert.equal(monthlyCost(d({ amount: 500, interval: 'once' }), { now }).state, 'once');
  assert.equal(monthlyCost(d({ amount: 360, interval: 'once', amortize_months: 36, since: '2026-01-01' }), { now }).amount, 10);
  assert.equal(monthlyCost(d({ amount: 360, interval: 'once', amortize_months: 3, since: '2026-01-01' }), { now }).state, 'ended');
  assert.equal(monthlyCost(d({ amount: 10, until: '2026-10-01' }), { now }).state, 'ended');
  assert.equal(monthlyCost(d({ amount: 10 }, { status: 'retired' }), { now }).state, 'retired');
  assert.equal(monthlyCost(d(undefined), { now }).state, 'unstated');
  assert.equal(monthlyCost(d({ group: 'g' }), { now }).state, 'grouped');
});

test('fleet totals stay per currency and count groups once', () => {
  const c = fleetCost(example, { now });
  assert.deepEqual(c.monthly, { EUR: 10, USD: 214 });
  assert.equal(c.by_provider['Example Racks USD'], 149);
  assert.equal(c.by_profile['desktop USD'], 40);
  assert.equal(c.counted, 4);
  const grouped = fleetCost({ devices: [
    { name: 'a', cost: { amount: 100, group: 'bill' } },
    { name: 'b', cost: { group: 'bill' } },
    { name: 'c' },
  ] }, { now });
  assert.deepEqual(grouped.monthly, { USD: 100 });
  assert.deepEqual(grouped.unstated, ['c']);
});

test('validate rejects credentials and phone numbers, warns on missing cost', () => {
  const r = validateInventory({ devices: [
    { name: 'a', ssh: { password: 'x' } },
    { name: 'p', profile: 'phone', phone_number: '+15550100' },
    { name: 'c', cost: { amount: -1 } },
  ] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('credentials')));
  assert.ok(r.errors.some((e) => e.includes('phone number')));
  assert.ok(r.errors.some((e) => e.includes('non-negative')));
  assert.ok(r.warnings.some((w) => w.includes('no cost stated')));
});

test('CoinPay export: stable keys, monthly equivalents, next due', () => {
  const rows = toCoinPayCosts(example, { now });
  assert.equal(rows.length, 4);
  const app1 = rows.find((r) => r.key === 'device:app1');
  assert.equal(app1.payee, 'RACKS EXAMPLE');
  assert.equal(app1.monthlyEquivalent, 149);
  assert.equal(app1.cadence, 'monthly');
  assert.equal(app1.scope, 'business');
  assert.equal(app1.category, 'hosting');
  assert.equal(app1.paidWith, 'paypal');
  assert.equal(app1.nextExpected, '2026-11-17T00:00:00.000Z');
  const eu1 = rows.find((r) => r.key === 'device:eu1');
  assert.equal(eu1.cadence, 'yearly');
  assert.equal(eu1.payee, 'Euro VPS');
  assert.equal(rows.find((r) => r.key === 'device:design-laptop').category, 'devices');
});

test('matchAgents joins by hostname, name or ip and keeps devices without agents', () => {
  const agents = [
    { id: 's1', name: 'APP1.northwind.example.', hostname: null, ip_address: null },
    { id: 's2', name: 'stray', hostname: 'stray.example', ip_address: '198.51.100.9' },
  ];
  const m = matchAgents(example, agents);
  assert.equal(m.devices.length, 4);
  assert.deepEqual(m.devices.find((d) => d.device.id === 'app1').agents.map((a) => a.id), ['s1']);
  assert.deepEqual(m.devices.find((d) => d.device.id === 'eu1').agents, []);
  assert.deepEqual(m.unmatched.map((a) => a.id), ['s2']);
});

test('observe never port-scans the machine it runs on', async () => {
  const { observe, localAddresses } = await import('../src/observe.js');
  const mine = [...localAddresses()].find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a) && !a.startsWith('127.') && !a.startsWith('10.') && !a.startsWith('192.168.') && !a.startsWith('172.'));
  if (!mine) return; // no public IPv4 on this box
  const o = await observe({ id: 'self', hostnames: [], addresses: { ipv4: [mine], ipv6: [] } }, { timeoutMs: 500 });
  assert.equal(o.from_self, true);
  assert.equal(o.ports, undefined);
});
