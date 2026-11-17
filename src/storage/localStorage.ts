import fs from "fs";
import path from "path";

/**
 * Storage layer for user files. Everything else (Drive now, Video/Mail
 * attachments later) goes through this interface, so swapping local disk for
 * GridFS or S3 only means writing another implementation.
 *
 * A "key" is an opaque path like "<ownerId>/<uuid>" — never a user-supplied name.
 */
export interface FileStorage {
  /** Directory multer should write an owner's upload into (created if missing). */
  uploadDir(ownerId: string): string;
  /** Turns a file multer wrote (inside uploadDir) into a storage key. */
  keyFor(ownerId: string, fileName: string): string;
  absolutePath(key: string): string;
  exists(key: string): boolean;
  createReadStream(key: string, range?: { start: number; end: number }): fs.ReadStream;
  remove(key: string): Promise<void>;
}

// On Vercel the project folder is read-only and only /tmp is writable (and it is
// wiped between invocations), so uploads there are temporary. Use a host with a
// persistent disk, or cloud storage, for real file storage.
const DEFAULT_ROOT = process.env.VERCEL ? "/tmp/nexa-storage" : path.join(process.cwd(), "storage");
const ROOT = path.resolve(process.env.STORAGE_DIR ?? DEFAULT_ROOT);

class LocalDiskStorage implements FileStorage {
  uploadDir(ownerId: string): string {
    const dir = path.join(ROOT, ownerId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  keyFor(ownerId: string, fileName: string): string {
    return `${ownerId}/${fileName}`;
  }

  absolutePath(key: string): string {
    const full = path.resolve(ROOT, key);
    // Defence in depth: a key must never resolve outside the storage root.
    if (!full.startsWith(ROOT + path.sep)) throw new Error("Invalid storage key");
    return full;
  }

  exists(key: string): boolean {
    return fs.existsSync(this.absolutePath(key));
  }

  createReadStream(key: string, range?: { start: number; end: number }): fs.ReadStream {
    return fs.createReadStream(this.absolutePath(key), range);
  }

  async remove(key: string): Promise<void> {
    await fs.promises.rm(this.absolutePath(key), { force: true });
  }
}

export const fileStorage: FileStorage = new LocalDiskStorage();
