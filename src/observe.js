// Observe a device's public metadata, per the OpenDevice rule: only what anyone on
// the internet could see without the device's credentials. DNS, reverse DNS, the
// routing registry (Team Cymru's public DNS service), the TLS certificate and SSH
// banner the device hands every connection, the HTTP Server header, which of a
// fixed list of ports answer, and which well-known files are served.
//
// Only observe devices you run. Node-only.
import { promises as dns } from 'node:dns';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import tls from 'node:tls';

export const PORTS = [22, 25, 53, 80, 443, 465, 587, 993, 2202, 3000, 5432, 6379, 8080, 8443];
export const WELLKNOWN = ['security.txt', 'openprofile.md', 'openserver.json', 'opendevice.json'];

const settle = async (p, fallback = null) => {
  try {
    return await p;
  } catch {
    return fallback;
  }
};

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref?.());
}

const race = (p, ms) => Promise.race([p, timeout(ms)]);

// Addresses of the machine running the observer. Probing one of these goes over
// loopback and skips the firewall, so open ports would be reported that the
// internet cannot reach.
export function localAddresses() {
  return new Set(Object.values(networkInterfaces()).flat().filter(Boolean).map((i) => i.address.toLowerCase()));
}

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd');
}

function portOpen(host, port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function sshBanner(host, port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let buf = '';
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(ms, () => done(null));
    s.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      const line = buf.split(/\r?\n/)[0];
      if (buf.includes('\n')) done(line.startsWith('SSH-') ? { port, banner: line.trim() } : null);
    });
    s.once('error', () => done(null));
  });
}

function tlsCert(host, servername, port, ms) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port, servername, rejectUnauthorized: false });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(ms, () => done(null));
    s.once('secureConnect', () => {
      const c = s.getPeerCertificate();
      if (!c || !c.subject) return done(null);
      done({
        port,
        subject: c.subject.CN ?? null,
        names: (c.subjectaltname ?? '').split(/,\s*/).filter(Boolean).map((n) => n.replace(/^DNS:/, '')),
        issuer: c.issuer?.O ?? c.issuer?.CN ?? null,
        not_after: c.valid_to ? new Date(c.valid_to).toISOString() : null,
        valid: s.authorized,
      });
    });
    s.once('error', () => done(null));
  });
}

async function asnOf(ip) {
  if (!net.isIPv4(ip)) return null;
  const rev = ip.split('.').reverse().join('.');
  const origin = await settle(dns.resolveTxt(`${rev}.origin.asn.cymru.com`));
  const first = origin?.[0]?.join('').split('|').map((s) => s.trim());
  if (!first?.[0]) return null;
  const number = Number(first[0].split(' ')[0]);
  const detail = await settle(dns.resolveTxt(`AS${number}.asn.cymru.com`));
  const org = detail?.[0]?.join('').split('|').map((s) => s.trim())[4] ?? null;
  return { number, org, prefix: first[1] ?? null, country: first[2] ?? null };
}

/**
 * Observe one device. Returns an `observed` block; it never throws for an
 * unreachable device, it just reports less.
 */
export async function observe(device, { timeoutMs = 4000, ports = PORTS, now = () => new Date() } = {}) {
  const hostnames = device.hostnames ?? [];
  const out = { at: now().toISOString() };
  const a = new Set(device.addresses?.ipv4 ?? []);
  const aaaa = new Set(device.addresses?.ipv6 ?? []);
  if (hostnames.length) {
    out.dns = { a: [], aaaa: [] };
    for (const h of hostnames) {
      for (const ip of (await settle(race(dns.resolve4(h), timeoutMs), [])) ?? []) {
        out.dns.a.includes(ip) || out.dns.a.push(ip);
        a.add(ip);
      }
      for (const ip of (await settle(race(dns.resolve6(h), timeoutMs), [])) ?? []) {
        out.dns.aaaa.includes(ip) || out.dns.aaaa.push(ip);
        aaaa.add(ip);
      }
    }
  }
  const publicIps = [...a, ...aaaa].filter((ip) => !isPrivate(ip));
  if (!publicIps.length) return out;
  const target = [...a].find((ip) => !isPrivate(ip)) ?? publicIps[0];

  const self = publicIps.some((ip) => localAddresses().has(ip.toLowerCase()));
  if (self) out.from_self = true;

  out.ptr = [];
  for (const ip of publicIps) for (const n of (await settle(race(dns.reverse(ip), timeoutMs), [])) ?? []) out.ptr.includes(n) || out.ptr.push(n);
  out.asn = await settle(race(asnOf(target), timeoutMs));

  if (self) return out; // ports, banners and TLS would be seen from inside; observe from another box
  const open = await Promise.all(ports.map((p) => portOpen(target, p, timeoutMs).then((ok) => (ok ? p : null))));
  out.ports = open.filter((p) => p != null);

  const sshPorts = out.ports.filter((p) => p === 22 || p === 2202);
  for (const p of sshPorts) {
    const b = await sshBanner(target, p, timeoutMs);
    if (b) {
      out.ssh = out.ssh ?? [];
      out.ssh.push(b);
    }
  }
  const name = hostnames[0] ?? target;
  if (out.ports.includes(443)) out.tls = await tlsCert(target, net.isIP(name) ? undefined : name, 443, timeoutMs);
  if (out.ports.includes(443) || out.ports.includes(80)) {
    const base = `${out.ports.includes(443) ? 'https' : 'http'}://${name}`;
    const res = await settle(fetch(base, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }));
    if (res) out.http = { status: res.status, server: res.headers.get('server') };
    out.wellknown = [];
    for (const file of WELLKNOWN) {
      const r = await settle(fetch(`${base}/.well-known/${file}`, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) }));
      if (r?.status === 200) out.wellknown.push(file);
    }
  }
  return out;
}

/** Observe every server/other device in an inventory, a few at a time. */
export async function observeInventory(inv, { concurrency = 3, ...opts } = {}) {
  const targets = inv.devices.filter((d) => (d.profile === 'server' || d.profile === 'other') && d.status !== 'retired');
  const results = new Map();
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      while (i < targets.length) {
        const d = targets[i++];
        results.set(d.id, await observe(d, opts));
      }
    }),
  );
  return {
    ...inv,
    devices: inv.devices.map((d) => (results.has(d.id) ? { ...d, observed: { ...d.observed, ...results.get(d.id) } } : d)),
  };
}
