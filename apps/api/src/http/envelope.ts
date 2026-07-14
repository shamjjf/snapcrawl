import type { Response } from "express";
import type { ErrorDetail } from "@snapcrawl/shared";

// Uniform API error envelope `{ code, message, details[] }` (FR-BE-070).
export class ApiError extends Error {
  status: number;
  code: string;
  details?: ErrorDetail[];

  constructor(status: number, code: string, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: ErrorDetail[],
): void {
  const body: { code: string; message: string; details?: ErrorDetail[] } = { code, message };
  if (details && details.length > 0) body.details = details;
  res.status(status).json(body);
}
