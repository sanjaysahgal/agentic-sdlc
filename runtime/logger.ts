import winston from "winston"
import DailyRotateFile from "winston-daily-rotate-file"
import path from "path"

const LOG_DIR = path.join(process.cwd(), "logs")

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [
    // Console — human-readable during dev
    new winston.transports.Console(),

    // Daily rotating file — 14-day retention, 20MB max per file
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: "bot-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxFiles: "14d",
      maxSize: "20m",
      zippedArchive: true,
    }),

    // Separate error-only file for fast triage
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: "bot-error-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      level: "error",
      maxFiles: "30d",
      maxSize: "20m",
      zippedArchive: true,
    }),
  ],
})

export default logger
