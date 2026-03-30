import { Response } from "express";

export interface ErrorResponse {
  error: string;
  code: string;
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const handleError = (res: Response, error: unknown) => {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
    });
  }

  // Structured logging instead of console.log
  const logData = {
    message: error instanceof Error ? error.message : "Internal Server Error",
    stack: error instanceof Error ? error.stack : undefined,
    timestamp: new Date().toISOString(),
  };

  process.stderr.write(JSON.stringify(logData) + "\n");

  return res.status(500).json({
    error: "Internal Server Error",
    code: "INTERNAL_ERROR",
  });
};
