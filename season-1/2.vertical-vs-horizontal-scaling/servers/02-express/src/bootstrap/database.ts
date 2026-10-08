import "./mongo-host-dns.js";
import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { httpMetrics } from "../observability/metrics.js";
import {
  attachMongoTopologyMonitor,
  logMongoTopologyIfChanged,
  markMongoShuttingDown,
} from "./mongo-topology.js";

mongoose.set("strictQuery", true);
mongoose.set("bufferCommands", false);

let connectionListenersBound = false;

const bindConnectionListeners = (): void => {
  if (connectionListenersBound) return;
  connectionListenersBound = true;
  mongoose.connection.on("error", (err: Error) => logger.error(`MongoDB connection error: ${err.message}`));
};

export const connectDatabase = async (): Promise<void> => {
  bindConnectionListeners();

  await mongoose.connect(env.mongoUri, {
    autoIndex: env.mongoAutoIndex,
    autoCreate: env.mongoAutoIndex,
    maxPoolSize: env.mongoPoolMax,
    minPoolSize:0,
    maxConnecting:2,
    waitQueueTimeoutMS:env.mongoPoolWaitMs,
    serverSelectionTimeoutMS: env.mongoSelectTimeoutMs,
    retryWrites: true,
    bufferCommands: false,
    writeConcern: { w: "majority" },
    readPreference: "primary",
    monitorCommands: true,
  });

  attachMongoTopologyMonitor();
  const client = mongoose.connection.getClient();
  client.on("connectionCheckedOut", event => httpMetrics.mongoCheckout(event.durationMS));
  client.on("connectionCheckOutFailed", event => httpMetrics.mongoCheckout(event.durationMS, true));
  client.on("commandSucceeded", event => httpMetrics.mongoCommand(event.commandName, event.duration));
  client.on("commandFailed", event => httpMetrics.mongoCommand(event.commandName, event.duration, true));
  logMongoTopologyIfChanged();
  logger.info(`MongoDB connected: ${mongoose.connection.name}`);
};

export const disconnectDatabase = async (): Promise<void> => {
  markMongoShuttingDown();
  await mongoose.disconnect();
  logger.info("mongoose closed (shutdown)");
};
