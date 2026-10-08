import winston from "winston";
import { env } from "./env.js";
import { redact } from "../shared/redact.js";

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

const devFormat = combine(
  colorize(),
  timestamp({ format: "HH:mm:ss" }),
  errors({ stack: true }),
  printf(({ timestamp, level, message, stack }) => `${timestamp} ${level}: ${stack ?? message}`),
);

const prodFormat = combine(timestamp(), errors({ stack: true }), json());
const redactFormat = winston.format(info => {
  const secrets = [env.jwtAccessSecret, env.jwtRefreshSecret, env.jwtAccessPreviousSecret, env.jwtRefreshPreviousSecret].filter((v): v is string => !!v);
  Object.assign(info, redact({ ...info }, secrets));
  return info;
});

// winston transports write off the event loop (async I/O), so this never blocks request handling
export const logger = winston.createLogger({
  level: env.logLevel,
  format: combine(redactFormat(), env.isProd ? prodFormat : devFormat),
  transports: [
    new winston.transports.Console(),
    ...(!env.isProd ? [new winston.transports.File({ filename: "logs/error.log", level: "error" }),
      new winston.transports.File({ filename: "logs/combined.log" })] : []),
  ],
  exitOnError: false,
});
