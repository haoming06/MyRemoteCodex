export const pairingCodeHistoryStorageKey = "remote-codex-pairing-codes";
export const maximumPairingCodeHistory = 5;

export interface PairingCodeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function normalizePairingCode(code: string): string | undefined {
  const normalized = code.trim().toUpperCase();
  return /^[A-Z2-9]{8}$/.test(normalized) ? normalized : undefined;
}

export function loadPairingCodeHistory(storage: PairingCodeStorage): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(pairingCodeHistoryStorageKey) || "[]");
    if (!Array.isArray(value)) return [];

    const uniqueCodes = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const code = normalizePairingCode(entry);
      if (code) uniqueCodes.add(code);
      if (uniqueCodes.size === maximumPairingCodeHistory) break;
    }
    return [...uniqueCodes];
  } catch {
    return [];
  }
}

function persistPairingCodeHistory(storage: PairingCodeStorage, codes: string[]): void {
  try {
    storage.setItem(pairingCodeHistoryStorageKey, JSON.stringify(codes));
  } catch {
    // Pairing still works when browser storage is unavailable or full.
  }
}

export function rememberPairingCode(storage: PairingCodeStorage, code: string): string[] {
  const normalized = normalizePairingCode(code);
  const current = loadPairingCodeHistory(storage);
  if (!normalized) return current;

  const updated = [normalized, ...current.filter((entry) => entry !== normalized)]
    .slice(0, maximumPairingCodeHistory);
  persistPairingCodeHistory(storage, updated);
  return updated;
}

export function forgetPairingCode(storage: PairingCodeStorage, code: string): string[] {
  const normalized = normalizePairingCode(code);
  const updated = normalized
    ? loadPairingCodeHistory(storage).filter((entry) => entry !== normalized)
    : loadPairingCodeHistory(storage);
  persistPairingCodeHistory(storage, updated);
  return updated;
}
