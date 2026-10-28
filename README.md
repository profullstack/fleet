# @profullstack/fleet

Read an [OpenDevice](https://logicsrc.com/docs/opendevice) inventory, the one file that lists every machine you run (servers, desktops, laptops, phones, tablets). Then:

- **cost**: add up what the fleet costs a month, per currency, by provider, profile and scope
- **observe**: collect each box's public metadata (DNS, reverse DNS, ASN, TLS certificate, SSH banner, HTTP server, open well-known ports, well-known files)
- **export**: turn the costs into CoinPay finances recurring charges, with stable keys and payees for matching against bank feeds
- **join**: match the inventory against agent-reported machines (ThreatCrush servers, W3BS fleet machines), so the boxes without an agent still show up

ThreatCrush's dashboard and w3bs.org/fleet read inventories through this package.

```sh
npm i @profullstack/fleet
npx fleet list opendevice.json
```

## CLI

```
fleet list     [inventory]   Every device, its profile, provider and monthly cost
fleet cost     [inventory]   Monthly run rate: total, by provider, profile, scope
fleet validate [inventory]   Errors and warnings against the spec
fleet observe  [inventory]   Collect public metadata; --write saves it into the file
fleet coinpay  [inventory]   Costs as CoinPay recurring charges (JSON)
```

`inventory` is a path or an https URL (`--header "Authorization: Bearer ..."` for a private one). It defaults to `$FLEET_INVENTORY`, then `./opendevice.json`. Add `--json` for machine output.

```
$ fleet list
ID             PROFILE  STATUS   PROVIDER       $/MO
app1           server   active   Example Racks  $149.00
eu1            server   active   Euro VPS       €10.00
ops-phone      phone    active   -              $25.00
design-laptop  desktop  active   -              $40.00

Monthly: €10.00 + $214.00  (4 counted)
```

## API

```js
import { parseInventory, validateInventory, fleetCost, toCoinPayCosts, matchAgents, loadInventory, formatMonthly } from '@profullstack/fleet';
import { observe, observeInventory } from '@profullstack/fleet/observe'; // Node only

const inv = await loadInventory('https://ops.example/opendevice.json', { headers: { authorization: `Bearer ${token}` } });
const cost = fleetCost(inv);            // { monthly: { USD: 590 }, by_provider, by_profile, by_scope, devices, unstated, counted }
formatMonthly(cost.monthly);            // "$590.00"
toCoinPayCosts(inv);                    // [{ key: 'device:dev2', payee: 'DEDIROCK', monthlyEquivalent: 149, cadence: 'monthly', ... }]
matchAgents(inv, threatcrushServers);   // { devices: [{ device, agents: [...] }], unmatched: [...] }
```

### Cost rules (from the spec)

- Monthly run rate: `month` as is, `year / 12`, `hour * 730`. `once` counts only with `amortize_months` and `since`.
- Totals stay per currency. Nothing is converted.
- A `group` shared by several devices on one bill counts once, from the device that states `amount`.
- A device with no `amount` is **unstated** and listed as such, never guessed.
- `retired` devices and costs past `until` count zero.

### Observation rules

Only what anyone could see without the device's credentials, and only for devices you run. Private addresses (RFC 1918, CGNAT, link-local, ULA) are never probed. Client profiles (desktop, phone, tablet) are not network-probed.

## License

MIT, Profullstack, Inc.
