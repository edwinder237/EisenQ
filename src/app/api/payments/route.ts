import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { loadFinanceCredentials, callFinanceApi } from "~/server/finance";
import { buildPaymentsPayload } from "~/lib/payments";

// GET /api/payments?date=YYYY-MM-DD — proxies the caller's own CashFold API and
// returns the day's payments grouped by account, plus unassigned items.
//
// Diagnosing a misconfigured endpoint is the job of Settings → Integrations →
// Test connection, so this route keeps its errors plain.
export async function GET(request: NextRequest) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const creds = await loadFinanceCredentials(userId);
    if (!creds.apiUrl) {
      return NextResponse.json({ configured: false });
    }

    const date = request.nextUrl.searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
    }

    const result = await callFinanceApi(creds, date);

    if (result.outcome !== "ok") {
      if (result.outcome === "http-error") {
        console.error("Payments: finance API responded with status", result.status, result.body);
      } else {
        console.error("Payments: finance API call failed:", result.outcome);
      }
      return NextResponse.json(
        { error: "Finance API request failed. Check Settings → Integrations → CashFold → Test connection." },
        { status: 502 }
      );
    }

    return NextResponse.json(buildPaymentsPayload(result.data, date));
  } catch (err) {
    console.error("Payments: request failed", err);
    return NextResponse.json({ error: "Failed to fetch payments" }, { status: 500 });
  }
}
