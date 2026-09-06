import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Resolves a NAgex data subdirectory the same way the Google OAuth token
// store resolves its file: an explicit env override, else /var/lib/nagex/<subdir>
// if that base directory exists and is writable (see docs/DEPLOYMENT.md for
// the one-time server setup), else a per-user fallback so local dev and
// tests never require /var/lib/nagex to exist.
export function resolveNagexDataDir(subdir: string, envVar: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[envVar];
  if (override) return override;
  const base = '/var/lib/nagex';
  try {
    fs.accessSync(base, fs.constants.W_OK);
    return path.join(base, subdir);
  } catch {
    return path.join(os.homedir(), '.local', 'share', 'nagex', subdir);
  }
}

// One JSON file per record, written atomically (temp file in the same
// directory -> chmod 0600 -> rename) with 0600 final permissions. No
// encryption: callers are responsible for never putting secrets (tokens,
// client secrets) into a record stored here — this is meant for records
// like approvals and executions that are safe to keep as plain JSON.
export class FileRecordStore<T> {
  constructor(
    private readonly dir: string,
    private readonly isValid: (value: unknown) => value is T,
  ) {}

  private filePath(id: string): string {
    const safeId = id.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(this.dir, `${safeId}.json`);
  }

  public write(id: string, record: T): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmpPath = path.join(this.dir, `.${id.replace(/[^a-zA-Z0-9_.-]/g, '_')}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      const fd = fs.openSync(tmpPath, 'w', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(record));
        try {
          fs.fsyncSync(fd);
        } catch {
          /* fsync not supported on this filesystem — best effort */
        }
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(tmpPath, 0o600);
      fs.renameSync(tmpPath, this.filePath(id));
      fs.chmodSync(this.filePath(id), 0o600);
    } catch (error) {
      console.error(JSON.stringify({ event: 'nagex_record_persist_failed', dir: this.dir, code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' }));
    }
  }

  public read(id: string): T | null {
    try {
      const raw = fs.readFileSync(this.filePath(id), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return this.isValid(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  public readAll(): T[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
    } catch {
      return []; // missing directory -> nothing persisted yet
    }
    const results: T[] = [];
    for (const name of names) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, name), 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (this.isValid(parsed)) results.push(parsed);
      } catch {
        // Corrupted individual record file — skip it, don't fail the whole restore.
        console.error(JSON.stringify({ event: 'nagex_record_file_invalid', dir: this.dir, file: name }));
      }
    }
    return results;
  }

  public remove(id: string): void {
    try {
      fs.rmSync(this.filePath(id), { force: true });
    } catch {
      /* best effort */
    }
  }
}
