import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { SecretsPort } from "../core/service";

/** API key stored encrypted with the OS keychain (safeStorage), base64 in userData/secret.bin (mode 0600). */
export class SafeStorageSecrets implements SecretsPort {
  private cache: string | null | undefined;
  private readonly file: string;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, "secret.bin");
  }

  available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  get(): string | null {
    if (this.cache !== undefined) return this.cache;
    let value: string | null = null;
    try {
      if (fs.existsSync(this.file) && this.available()) {
        const buf = Buffer.from(fs.readFileSync(this.file, "utf8").trim(), "base64");
        value = safeStorage.decryptString(buf) || null;
      }
    } catch {
      value = null;
    }
    this.cache = value;
    return value;
  }

  set(key: string): void {
    if (!this.available()) throw new Error("Secure storage is not available on this system");
    const enc = safeStorage.encryptString(key).toString("base64");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, enc, { mode: 0o600 });
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* best effort */
    }
    this.cache = key;
  }

  clear(): void {
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* ignore */
    }
    this.cache = null;
  }
}
