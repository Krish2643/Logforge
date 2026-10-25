import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppConfig } from "../config/env.js";
import type { ObjectStorage } from "./object-storage.js";

export function createR2Storage(config: AppConfig): ObjectStorage | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = config;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return null;
  }

  const client = new S3Client({
    region: config.R2_REGION,
    endpoint: config.R2_ENDPOINT ?? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY
    }
  });

  return {
    async createUploadUrl({ key, contentType, expiresInSeconds }) {
      return getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key, ContentType: contentType }),
        { expiresIn: expiresInSeconds }
      );
    },
    async headObject(key) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key })
        );
        return { contentLength: result.ContentLength, contentType: result.ContentType };
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "$metadata" in error &&
          typeof error.$metadata === "object" &&
          error.$metadata !== null &&
          "httpStatusCode" in error.$metadata &&
          error.$metadata.httpStatusCode === 404
        ) {
          return null;
        }
        throw error;
      }
    },
    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    },
    async getObjectStream(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
      if (result.Body instanceof Readable) return result.Body;
      const body = result.Body;
      if (body && "transformToWebStream" in body) {
        return Readable.fromWeb(body.transformToWebStream() as NodeReadableStream);
      }
      throw new Error("R2 returned a response body that cannot be streamed");
    }
  };
}
