// An in-memory stand-in for ~/server/db, for tests only. It implements the
// MongoDB operations EisenQ's notification code and task service use, with
// MongoDB's meaning: { field: null } matches null or missing, dot paths,
// $ne / $in / $nin / $exists / $gt(e) / $lt(e) / $or / $and (ObjectIds compare
// in creation order, as MongoDB's do), sort and limit, and the updates
// $set / $unset / $setOnInsert / $inc with upsert. Projections are ignored.
//
// Use it with: vi.mock("~/server/db", () => import("~/test/fake-db"));

import { ObjectId } from "mongodb";
import type {
  ChecklistItem,
  Goal,
  MaintenanceItem,
  NotificationDeletion,
  NotificationState,
  Task,
  UserSettings,
} from "~/server/db/schema";

type Doc = Record<string, unknown> & { _id?: ObjectId };
type Filter = Record<string, unknown>;
type Update = Record<string, Record<string, unknown> | undefined>;

function isOperatorObject(v: unknown): v is Record<string, unknown> {
  if (
    typeof v !== "object" ||
    v === null ||
    Array.isArray(v) ||
    v instanceof Date ||
    v instanceof ObjectId
  )
    return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

function clone<T>(v: T): T {
  if (v instanceof Date) return new Date(v.getTime()) as T;
  if (v instanceof ObjectId || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(clone) as T;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clone(x)]),
  ) as T;
}

function getPath(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(doc: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cur = doc;
  for (const part of parts.slice(0, -1)) {
    if (typeof cur[part] !== "object" || cur[part] === null) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts.at(-1)!] = clone(value);
}

function unsetPath(doc: Record<string, unknown>, path: string) {
  const parts = path.split(".");
  let cur: unknown = doc;
  for (const part of parts.slice(0, -1)) {
    if (cur === null || typeof cur !== "object") return;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur && typeof cur === "object")
    delete (cur as Record<string, unknown>)[parts.at(-1)!];
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof ObjectId || b instanceof ObjectId)
    return a instanceof ObjectId && b instanceof ObjectId && a.equals(b);
  if (a instanceof Date || b instanceof Date)
    return (
      a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    );
  if (a === null || a === undefined || b === null || b === undefined)
    return (a ?? null) === (b ?? null);
  if (typeof a === "object" && typeof b === "object")
    return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function comparable(v: unknown): unknown {
  if (v instanceof Date) return v.getTime();
  // Same length, timestamp first: hex order is creation order.
  if (v instanceof ObjectId) return v.toHexString();
  return v;
}

function compare(a: unknown, b: unknown): number | null {
  if (a === undefined || a === null || b === undefined || b === null)
    return null;
  const x = comparable(a);
  const y = comparable(b);
  if (typeof x === "number" && typeof y === "number") return x - y;
  if (typeof x === "string" && typeof y === "string")
    return x < y ? -1 : x > y ? 1 : 0;
  return null;
}

function matchValue(value: unknown, cond: unknown): boolean {
  if (!isOperatorObject(cond)) return same(value, cond);
  return Object.entries(cond).every(([op, arg]) => {
    switch (op) {
      case "$eq":
        return same(value, arg);
      case "$ne":
        return !same(value, arg);
      case "$in":
        return (arg as unknown[]).some((x) => same(value, x));
      case "$nin":
        return !(arg as unknown[]).some((x) => same(value, x));
      case "$exists":
        return (value !== undefined) === Boolean(arg);
      case "$gt":
        return (compare(value, arg) ?? -1) > 0;
      case "$gte":
        return (compare(value, arg) ?? -1) >= 0;
      case "$lt":
        return (compare(value, arg) ?? 1) < 0;
      case "$lte":
        return (compare(value, arg) ?? 1) <= 0;
      default:
        throw new Error(`fake-db: operator ${op} isn't supported`);
    }
  });
}

export function matches(doc: Doc, filter: Filter): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return (cond as Filter[]).some((f) => matches(doc, f));
    if (key === "$and") return (cond as Filter[]).every((f) => matches(doc, f));
    return matchValue(getPath(doc, key), cond);
  });
}

function applyUpdate(doc: Doc, update: Update, inserting: boolean) {
  for (const [op, fields] of Object.entries(update)) {
    if (!fields) continue;
    for (const [path, value] of Object.entries(fields)) {
      if (op === "$set") setPath(doc, path, value);
      else if (op === "$unset") unsetPath(doc, path);
      else if (op === "$setOnInsert") {
        if (inserting) setPath(doc, path, value);
      } else if (op === "$inc")
        setPath(
          doc,
          path,
          ((getPath(doc, path) as number | undefined) ?? 0) + (value as number),
        );
      else throw new Error(`fake-db: update ${op} isn't supported`);
    }
  }
}

class Cursor<T extends Doc> {
  private sortSpec: [string, number][] = [];
  private max = Infinity;
  constructor(private readonly docs: T[]) {}
  sort(spec: Record<string, number>) {
    this.sortSpec = Object.entries(spec);
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  async toArray(): Promise<T[]> {
    const out = [...this.docs];
    if (this.sortSpec.length) {
      out.sort((a, b) => {
        for (const [path, dir] of this.sortSpec) {
          const c = compare(getPath(a, path), getPath(b, path)) ?? 0;
          if (c !== 0) return c * dir;
        }
        return 0;
      });
    }
    return out.slice(0, this.max).map(clone);
  }
}

export class FakeCollection<T extends Doc = Doc> {
  docs: T[] = [];

  async insertOne(doc: T) {
    const stored = clone(doc);
    stored._id ??= new ObjectId();
    this.docs.push(stored);
    return { acknowledged: true, insertedId: stored._id };
  }

  async findOne(filter: Filter = {}, _options?: unknown): Promise<T | null> {
    const found = this.docs.find((d) => matches(d, filter));
    return found ? clone(found) : null;
  }

  find(filter: Filter = {}, _options?: unknown) {
    return new Cursor(this.docs.filter((d) => matches(d, filter)));
  }

  async countDocuments(filter: Filter = {}) {
    return this.docs.filter((d) => matches(d, filter)).length;
  }

  async updateOne(
    filter: Filter,
    update: Update,
    options: { upsert?: boolean } = {},
  ) {
    const doc = this.docs.find((d) => matches(d, filter));
    if (doc) {
      const before = JSON.stringify(doc);
      applyUpdate(doc, update, false);
      return {
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: JSON.stringify(doc) === before ? 0 : 1,
        upsertedCount: 0,
      };
    }
    if (!options.upsert)
      return {
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 0,
      };
    const inserted = {} as T;
    for (const [key, cond] of Object.entries(filter)) {
      if (!key.startsWith("$") && !isOperatorObject(cond))
        setPath(inserted, key, cond);
    }
    applyUpdate(inserted, update, true);
    inserted._id ??= new ObjectId();
    this.docs.push(inserted);
    return {
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
      upsertedCount: 1,
      upsertedId: inserted._id,
    };
  }

  async updateMany(filter: Filter, update: Update) {
    const hits = this.docs.filter((d) => matches(d, filter));
    for (const d of hits) applyUpdate(d, update, false);
    return {
      acknowledged: true,
      matchedCount: hits.length,
      modifiedCount: hits.length,
    };
  }

  async bulkWrite(
    ops: { updateOne: { filter: Filter; update: Update; upsert?: boolean } }[],
  ) {
    for (const op of ops)
      await this.updateOne(op.updateOne.filter, op.updateOne.update, {
        upsert: op.updateOne.upsert,
      });
    return { acknowledged: true };
  }

  async deleteOne(filter: Filter) {
    const i = this.docs.findIndex((d) => matches(d, filter));
    if (i >= 0) this.docs.splice(i, 1);
    return { acknowledged: true, deletedCount: i >= 0 ? 1 : 0 };
  }

  async deleteMany(filter: Filter) {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !matches(d, filter));
    return { acknowledged: true, deletedCount: before - this.docs.length };
  }

  async createIndex() {
    return "fake-index";
  }

  aggregate() {
    throw new Error("fake-db: aggregate isn't supported");
  }
}

// Partial: tests seed only the fields a rule reads.
type Loose<T> = Doc & Partial<T>;
export const tasksCollection = new FakeCollection<Loose<Task>>();
export const goalsCollection = new FakeCollection<Loose<Goal>>();
export const checklistItemsCollection = new FakeCollection<
  Loose<ChecklistItem>
>();
export const maintenanceItemsCollection = new FakeCollection<
  Loose<MaintenanceItem>
>();
export const userSettingsCollection = new FakeCollection<Loose<UserSettings>>();
export const notificationStatesCollection = new FakeCollection<
  Loose<NotificationState>
>();
export const notificationDeletionsCollection = new FakeCollection<
  Loose<NotificationDeletion>
>();
export const db = {};
export const client = {};

export function resetFakeDb() {
  for (const c of [
    tasksCollection,
    goalsCollection,
    checklistItemsCollection,
    maintenanceItemsCollection,
    userSettingsCollection,
    notificationStatesCollection,
    notificationDeletionsCollection,
  ]) {
    c.docs = [];
  }
}
