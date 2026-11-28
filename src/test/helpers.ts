import { NextRequest } from "next/server";
import { vi } from "vitest";
import type { UserSettings } from "~/server/db/schema";
import { userSettingsCollection } from "~/test/fake-db";

// Made-up Clerk-shaped IDs and addresses. Nobody real.
export const OWNER = "user_2ownerOwnerOwner00001";
export const OTHER = "user_2otherOtherOther00002";
export const OWNER_EMAIL = "owner@example.com";
export const OTHER_EMAIL = "other@example.com";
export const TZ = "America/Toronto";

/** The made-up address of any test account: owner@, other@, else <id>@example.com. */
export function emailOf(id: string): string {
  if (id === OWNER) return OWNER_EMAIL;
  if (id === OTHER) return OTHER_EMAIL;
  return `${id.toLowerCase()}@example.com`;
}

/**
 * EisenQ's Clerk, stubbed. Every account has its own primary email, verified
 * unless listed in `unverified`; `email: null` gives none at all. Accounts in
 * `gone` were deleted: Clerk answers 404, as its SDK throws it.
 */
export function fakeClerk(
  opts: {
    email?: string | null;
    locale?: string | null;
    unverified?: string[];
    gone?: string[];
  } = {},
) {
  return {
    users: {
      getUser: vi.fn(async (id: string) => {
        if (opts.gone?.includes(id))
          throw Object.assign(new Error("Not Found"), { clerkError: true, status: 404 });
        return {
        id,
        primaryEmailAddress:
          opts.email === null
            ? null
            : {
                emailAddress: opts.email ?? emailOf(id),
                verification: {
                  status: opts.unverified?.includes(id)
                    ? "unverified"
                    : "verified",
                },
              },
        locale: opts.locale === undefined ? "fr-CA" : opts.locale,
        };
      }),
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
