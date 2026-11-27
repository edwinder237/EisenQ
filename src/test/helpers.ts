import { NextRequest } from "next/server";
import { vi } from "vitest";
import type { UserSettings } from "~/server/db/schema";
import { userSettingsCollection } from "~/test/fake-db";

// Made-up Clerk-shaped IDs and addresses. Nobody real.
export const OWNER = "user_2ownerOwnerOwner00001";
export const OTHER = "user_2otherOtherOther00002";
export const OWNER_EMAIL = "owner@example.com";
export const TZ = "America/Toronto";

/** EisenQ's Clerk, stubbed: the owner is the oldest account. */
export function fakeClerk(
  opts: {
    owner?: string | null;
    email?: string | null;
    locale?: string | null;
  } = {},
) {
  const owner = opts.owner === undefined ? OWNER : opts.owner;
  return {
    users: {
      getUserList: vi.fn(async () => ({
        data: owner ? [{ id: owner }] : [],
        totalCount: owner ? 1 : 0,
      })),
      getUser: vi.fn(async (id: string) => ({
        id,
        primaryEmailAddress:
          opts.email === null
            ? null
            : {
                emailAddress:
                  opts.email ??
                  (id === OWNER ? OWNER_EMAIL : "other@example.com"),
              },
        locale: opts.locale === undefined ? "fr-CA" : opts.locale,
      })),
    },
  };
}

/** A person's settings with their zone, as the AI connectors tab saves it. */
export async function seedSettings(
  userId: string,
  extra: Record<string, unknown> = {},
) {
  await userSettingsCollection.insertOne({
    userId,
    // Only the zone is set; readers fill the rest in with normalizeMcpSettings().
    mcp: { preferences: { timeZone: TZ } } as unknown as UserSettings["mcp"],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...extra,
  });
}

export function jsonRequest(
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new NextRequest(`https://www.eisenq.app${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export const params = (id: string) => ({ params: Promise.resolve({ id }) });

export async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
