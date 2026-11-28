import { MongoClient, type Db } from "mongodb";
import { env } from "~/env";
import type { Task, Goal, ChecklistItem, MaintenanceItem, UserSettings, NotificationState, NotificationDeletion } from "./schema";
import { collections } from "./schema";

// Global reference to persist connection across serverless function invocations
const globalForDb = globalThis as unknown as {
  client: MongoClient | undefined;
  db: Db | undefined;
  connectionPromise: Promise<MongoClient> | undefined;
};

// Use the same pattern for both production and development
// This ensures connection pooling works in serverless environments
globalForDb.client ??= new MongoClient(env.DATABASE_URL, {
  // Connection pool settings for serverless
  maxPoolSize: 10,
  minPoolSize: 0,
  maxIdleTimeMS: 10000,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});

const client = globalForDb.client;
globalForDb.db ??= client.db();
const db = globalForDb.db;

export { db, client };

export const tasksCollection = db.collection<Task>(collections.tasks);
export const goalsCollection = db.collection<Goal>(collections.goals);
export const checklistItemsCollection = db.collection<ChecklistItem>(collections.checklistItems);
export const maintenanceItemsCollection = db.collection<MaintenanceItem>(collections.maintenanceItems);
export const userSettingsCollection = db.collection<UserSettings>(collections.userSettings);
export const notificationStatesCollection = db.collection<NotificationState>(collections.notificationStates);
export const notificationDeletionsCollection = db.collection<NotificationDeletion>(collections.notificationDeletions);
