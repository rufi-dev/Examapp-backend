class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }
}

const httpError = (status, code, message, details) =>
  new AppError(status, code, message, details);

const isAppError = (err) =>
  err instanceof AppError ||
  (!!err &&
    Number.isInteger(err.statusCode || err.status) &&
    typeof err.code === "string");

module.exports = { AppError, httpError, isAppError };
