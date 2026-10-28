import type { Device, Inventory } from './index.js';
export const PORTS: number[];
export const WELLKNOWN: string[];
export function observe(device: Device, opts?: { timeoutMs?: number; ports?: number[]; now?: () => Date }): Promise<Record<string, unknown> & { at: string }>;
export function observeInventory(inv: Inventory, opts?: { concurrency?: number; timeoutMs?: number; ports?: number[] }): Promise<Inventory>;
