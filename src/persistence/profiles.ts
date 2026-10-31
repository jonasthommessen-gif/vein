import type { FeatureScores, FeatureVector, ProfileScores, RadarValues, VeinProfile } from '../types';
import { radarFromScores } from '../domain/profile';

const LS_KEY = 'vein.profiles.v1';
const DB_NAME = 'vein.profiles';
const DB_VERSION = 1;
const STORE = 'profiles';
const SCHEMA = 2;
const MAX_PROFILES = 50;

interface LegacyStore {
  schemaVersion: number;
  profiles: VeinProfile[];
}

let dbPromise: Promise<IDBDatabase> | null = null;
let migrated = false;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function emptyScores(): ProfileScores {
  return {
    desirability: 0,
    richness: 0,
    rarity: 0,
    elegance: 0,
    clarity: 0,
    complexity: 0,
    tone: 0,
    consistency: 0,
    nocturnal: 0,
    aftertaste: 0,
    finish: 0,
    temperament: 0,
    occasion: 0,
  };
}

function normalizeProfile(raw: Partial<VeinProfile> & { id: string }): VeinProfile {
  const scores = raw.scores ?? emptyScores();
  const radar: RadarValues = raw.radar ?? radarFromScores(scores);
  const measured: FeatureScores = raw.measured ?? {
    veinVisibility: 0,
    patternDetail: 0,
    colourSignature: 0,
    frameStability: 0,
    imageConfidence: 0,
  };
  const featureVector: FeatureVector = raw.featureVector ?? {
    V: 0,
    P: 0,
    C: 0,
    S: 0,
    Q: 0,
    chromaticWarmth: 0.5,
  };

  return {
    id: raw.id,
    createdAt: raw.createdAt ?? new Date().toISOString(),
    label: raw.label ?? 'Subject',
    featureVector,
    quality: raw.quality ?? measured.imageConfidence,
    classCode: raw.classCode ?? 'V·01',
    scores,
    radar,
    toneLabel: raw.toneLabel ?? 'neutral',
    verdict: raw.verdict ?? '',
    descriptor: raw.descriptor ?? '',
    assessment: raw.assessment ?? raw.descriptor ?? '',
    tastingNotes: raw.tastingNotes ?? raw.recommendations ?? [],
    why: raw.why ?? '',
    recommendations: raw.recommendations ?? [],
    palateNotes: raw.palateNotes ?? {},
    limitedConfidence: Boolean(raw.limitedConfidence),
    schemaVersion: raw.schemaVersion ?? SCHEMA,
    measured,
    captureImage: raw.captureImage ?? null,
  };
}

function readLegacyLocalStorage(): VeinProfile[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LegacyStore;
    if (!parsed || !Array.isArray(parsed.profiles)) return [];
    return parsed.profiles
      .filter((p) => p && typeof p.id === 'string')
      .map((p) => normalizeProfile(p));
  } catch {
    return [];
  }
}

async function migrateFromLocalStorage(db: IDBDatabase): Promise<void> {
  if (migrated) return;
  migrated = true;

  const legacy = readLegacyLocalStorage();
  if (legacy.length === 0) return;

  // Only migrate if IDB is empty
  const existing = await idbGetAll(db);
  if (existing.length > 0) {
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      /* ignore */
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    for (const p of legacy) {
      os.put({ ...p, schemaVersion: SCHEMA });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Migration failed'));
  });

  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

function idbGetAll(db: IDBDatabase): Promise<VeinProfile[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const rows = (req.result as VeinProfile[]).map((p) => normalizeProfile(p));
      resolve(rows);
    };
    req.onerror = () => reject(req.error ?? new Error('getAll failed'));
  });
}

async function ensureDb(): Promise<IDBDatabase> {
  const db = await openDb();
  await migrateFromLocalStorage(db);
  return db;
}

/** Sync fallback used only when IndexedDB is unavailable. */
function lsList(): VeinProfile[] {
  return readLegacyLocalStorage().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listProfiles(): Promise<VeinProfile[]> {
  try {
    const db = await ensureDb();
    const all = await idbGetAll(db);
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return lsList();
  }
}

export async function getProfile(id: string): Promise<VeinProfile | null> {
  try {
    const db = await ensureDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => {
        const row = req.result as VeinProfile | undefined;
        resolve(row ? normalizeProfile(row) : null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return lsList().find((p) => p.id === id) ?? null;
  }
}

export async function saveProfile(profile: VeinProfile): Promise<boolean> {
  const normalized = normalizeProfile({ ...profile, schemaVersion: SCHEMA });
  try {
    const db = await ensureDb();
    const all = await idbGetAll(db);
    const without = all.filter((p) => p.id !== normalized.id);
    without.unshift(normalized);
    const capped = without.slice(0, MAX_PROFILES);

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const os = tx.objectStore(STORE);
      // Clear and rewrite to enforce cap
      os.clear();
      for (const p of capped) os.put(p);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    // localStorage fallback (may fail for large images)
    try {
      const store: LegacyStore = {
        schemaVersion: SCHEMA,
        profiles: [normalized, ...lsList().filter((p) => p.id !== normalized.id)].slice(
          0,
          MAX_PROFILES,
        ),
      };
      localStorage.setItem(LS_KEY, JSON.stringify(store));
      return true;
    } catch {
      return false;
    }
  }
}

export async function renameProfile(id: string, label: string): Promise<boolean> {
  const p = await getProfile(id);
  if (!p) return false;
  p.label = label.trim() || p.label;
  return saveProfile(p);
}

export async function deleteProfile(id: string): Promise<boolean> {
  try {
    const db = await ensureDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    try {
      const store: LegacyStore = {
        schemaVersion: SCHEMA,
        profiles: lsList().filter((p) => p.id !== id),
      };
      localStorage.setItem(LS_KEY, JSON.stringify(store));
      return true;
    } catch {
      return false;
    }
  }
}

export async function nextSubjectLabel(): Promise<string> {
  const n = (await listProfiles()).length + 1;
  return `Subject ${String(n).padStart(2, '0')}`;
}
