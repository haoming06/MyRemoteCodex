import { describe, expect, it } from "vitest";
import {
  forgetPairingCode,
  loadPairingCodeHistory,
  maximumPairingCodeHistory,
  pairingCodeHistoryStorageKey,
  rememberPairingCode,
  type PairingCodeStorage,
} from "../client/pairing-code-history";

class MemoryStorage implements PairingCodeStorage {
  value: string | null = null;

  getItem(): string | null {
    return this.value;
  }

  setItem(_key: string, value: string): void {
    this.value = value;
  }
}

describe("pairing code history", () => {
  it("keeps the five most recently used unique codes", () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < maximumPairingCodeHistory + 1; index += 1) {
      rememberPairingCode(storage, `PAIRCD2${index + 2}`);
    }

    expect(loadPairingCodeHistory(storage)).toEqual([
      "PAIRCD27",
      "PAIRCD26",
      "PAIRCD25",
      "PAIRCD24",
      "PAIRCD23",
    ]);
    expect(rememberPairingCode(storage, "paircd24")).toEqual([
      "PAIRCD24",
      "PAIRCD27",
      "PAIRCD26",
      "PAIRCD25",
      "PAIRCD23",
    ]);
  });

  it("deletes one saved code", () => {
    const storage = new MemoryStorage();
    rememberPairingCode(storage, "PAIRCD22");
    rememberPairingCode(storage, "PAIRCD23");

    expect(forgetPairingCode(storage, "paircd23")).toEqual(["PAIRCD22"]);
    expect(storage.value).toBe('["PAIRCD22"]');
  });

  it("ignores malformed persisted data and invalid codes", () => {
    const storage = new MemoryStorage();
    storage.value = JSON.stringify(["PAIRCD22", "PAIRCODE2", "bad!", 12, "paircd22", "PAIRCD23"]);
    expect(loadPairingCodeHistory(storage)).toEqual(["PAIRCD22", "PAIRCD23"]);

    storage.value = "not-json";
    expect(loadPairingCodeHistory(storage)).toEqual([]);
    expect(rememberPairingCode(storage, "short")).toEqual([]);
  });

  it("continues without history when browser storage is unavailable", () => {
    const storage: PairingCodeStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("full"); },
    };

    expect(loadPairingCodeHistory(storage)).toEqual([]);
    expect(rememberPairingCode(storage, "PAIRCD22")).toEqual(["PAIRCD22"]);
    expect(pairingCodeHistoryStorageKey).toBe("remote-codex-pairing-codes");
  });
});
