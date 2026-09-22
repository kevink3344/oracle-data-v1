import { useEffect, useState } from 'react';
import { sessionHeaders } from './session';

export type PinCategory = 'project' | 'invoice' | 'check' | 'purchase-order';

export interface Pin {
  id: number;
  category: PinCategory;
  entityKey: string;
  title: string;
  subtitle: string;
  href: string;
  createdAt: string;
}

const API = '/api/pins';
let pins: Pin[] = [];
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

async function readError(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) return new Error(body.error.message);
  } catch {
    /* Keep the HTTP status when the server did not return JSON. */
  }
  return new Error(`HTTP ${res.status} ${res.statusText}`);
}

async function load(): Promise<void> {
  if (loaded) return;
  if (loading) return loading;
  loading = fetch(API, { headers: sessionHeaders() })
    .then(async (res) => {
      if (!res.ok) throw await readError(res);
      const body = (await res.json()) as { data?: Pin[] };
      pins = Array.isArray(body.data) ? body.data : [];
      loaded = true;
      notify();
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export function usePins(): { pins: Pin[]; ready: boolean; error: Error | null; refresh: () => void } {
  const [, rerender] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const listener = () => rerender((value) => value + 1);
    listeners.add(listener);
    load().catch((err: unknown) => {
      setError(err instanceof Error ? err : new Error(String(err)));
    });
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return { pins, ready: loaded, error, refresh: () => { loaded = false; notify(); void load(); } };
}

export async function savePin(input: Omit<Pin, 'id' | 'createdAt'>): Promise<Pin> {
  const res = await fetch(API, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...sessionHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { data?: Pin };
  if (!body.data) throw new Error('The server saved the pin but returned no pin row.');
  pins = [body.data, ...pins.filter((pin) => !(pin.category === body.data!.category && pin.entityKey === body.data!.entityKey))];
  loaded = true;
  notify();
  return body.data;
}

export async function deletePin(category: PinCategory, entityKey: string): Promise<void> {
  const res = await fetch(`${API}/${encodeURIComponent(category)}/${encodeURIComponent(entityKey)}`, {
    method: 'DELETE',
    headers: sessionHeaders(),
  });
  if (!res.ok) throw await readError(res);
  pins = pins.filter((pin) => !(pin.category === category && pin.entityKey === entityKey));
  notify();
}

export function pinKey(category: PinCategory, entityKey: string): string {
  return `${category}:${entityKey}`;
}