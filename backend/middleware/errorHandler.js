/**
 * Centralized error handling for the backend
 * - Provides AppError for operational errors
 * - Maps common library errors (Mongoose, Multer, JWT)
 * - Different responses for development vs production
 * - Logs errors with timestamp and request context
 */

const isDev = (process.env.NODE_ENV || 'development') !== 'production';

class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.name = 'AppError';
    this.statusCode = Number(statusCode) || 500;
    this.isOperational = Boolean(isOperational);
    Error.captureStackTrace?.(this, this.constructor);
  }
}

function errorHandler(err, req, res, next) {
  try {
    if (res.headersSent) return next(err);

    let statusCode = 500;
    let message = 'Internal Server Error';
    let details = undefined;

    // AppError instances
    if (err instanceof AppError) {
      statusCode = err.statusCode || 500;
      message = err.message || message;
    } else {
      // Mongoose validation errors
      if (err?.name === 'ValidationError') {
        statusCode = 400;
        const errs = Object.values(err.errors || {}).map(e => e.message).filter(Boolean);
        message = errs.length ? `Validation failed: ${errs.join('; ')}` : 'Validation failed';
        details = { errors: errs };
      }
      // Mongoose duplicate key (MongoServerError code 11000)
      else if (err?.code === 11000) {
        statusCode = 409;
        const fields = err.keyValue ? Object.keys(err.keyValue).join(', ') : 'unknown';
        message = `Duplicate key error on field(s): ${fields}`;
        details = { keyValue: err.keyValue };
      }
      // Mongoose cast errors (invalid ObjectId / type casts)
      else if (err?.name === 'CastError') {
        statusCode = 400;
        message = `Invalid value for '${err.path}': ${err.value}`;
        details = { path: err.path, value: err.value };
      }
      // Multer errors (file upload)
      else if (err?.name === 'MulterError' || /Unsupported file type/i.test(err?.message || '')) {
        statusCode = 400;
        message = err.message || 'Invalid upload request';
      }
      // JWT errors
      else if (err?.name === 'JsonWebTokenError') {
        statusCode = 401;
        message = 'Invalid authentication token';
      } else if (err?.name === 'TokenExpiredError') {
        statusCode = 401;
        message = 'Authentication token expired';
      }
      // Default
      else {
        statusCode = Number(err.statusCode || err.status) || 500;
        message = err.message || message;
      }
    }

    // Log with timestamp and request info
    const logEntry = {
      ts: new Date().toISOString(),
      method: req.method,
      url: req.originalUrl || req.url,
      ip: req.ip,
      ua: req.headers['user-agent'],
      statusCode,
      name: err?.name,
      message: err?.message,
    };
    if (isDev && err?.stack) logEntry.stack = err.stack;
    // Use a single-line JSON for structured logs
    try { console.error(`[Error] ${JSON.stringify(logEntry)}`); } catch (_) { console.error('[Error]', logEntry); }

    // Respond based on environment
    if (isDev) {
      return res.status(statusCode).json({
        error: message,
        statusCode,
        name: err?.name,
        stack: err?.stack,
        details,
      });
    }

    return res.status(statusCode).json({ error: message });
  } catch (handlerErr) {
    // Fallback: if error handler itself fails
    try {
      console.error('[ErrorHandler] Failed to handle error:', handlerErr);
    } catch (_) {}
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

module.exports = errorHandler;
module.exports.AppError = AppError;