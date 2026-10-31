import type { VeinProfile } from '../types';

const KEY = 'vein.profiles.v1';
const SCHEMA = 1;

interface Store {
  schemaVersion: number;
  profiles: VeinProfile[];
}

function empty(): Store {
  return { schemaVersion: SCHEMA, profiles: [] };
}

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || !Array.isArray(parsed.profiles)) return empty();
    return {
      schemaVersion: parsed.schemaVersion ?? SCHEMA,
      profiles: parsed.profiles.filter((p) => p && typeof p.id === 'string'),
    };
  } catch {
    return empty();
  }
}

function write(store: Store): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

export function listProfiles(): VeinProfile[] {
  return read().profiles.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getProfile(id: string): VeinProfile | null {
  return read().profiles.find((p) => p.id === id) ?? null;
}

export function saveProfile(profile: VeinProfile): boolean {
  const store = read();
  const idx = store.profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) store.profiles[idx] = profile;
  else store.profiles.unshift(profile);
  // Cap at 50
  if (store.profiles.length > 50) store.profiles = store.profiles.slice(0, 50);
  return write(store);
}

export function renameProfile(id: string, label: string): boolean {
  const store = read();
  const p = store.profiles.find((x) => x.id === id);
  if (!p) return false;
  p.label = label.trim() || p.label;
  return write(store);
}

export function deleteProfile(id: string): boolean {
  const store = read();
  store.profiles = store.profiles.filter((p) => p.id !== id);
  return write(store);
}

export function nextSubjectLabel(): string {
  const n = listProfiles().length + 1;
  return `Subject ${String(n).padStart(2, '0')}`;
}
