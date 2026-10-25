export interface StoredObject {
  contentLength: number | undefined;
  contentType: string | undefined;
}

export interface ObjectStorage {
  createUploadUrl(input: {
    key: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string>;
  headObject(key: string): Promise<StoredObject | null>;
  deleteObject(key: string): Promise<void>;
  getObjectStream(key: string): Promise<Readable>;
}
import type { Readable } from "node:stream";
