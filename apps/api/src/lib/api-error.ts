export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Array<{ path: string; message: string }>
  ) {
    super(message);
    this.name = "ApiError";
  }
}
