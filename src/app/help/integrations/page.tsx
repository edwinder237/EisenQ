import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { PaperTheme } from "./PaperTheme";

// The user guide for every integration. Each section's id is the anchor the
// matching Settings tab links to (#ai-connectors, #cashfold, ...), so keep
// them stable. Developer-facing docs live in docs/integrations/.

export const metadata: Metadata = {
  title: "Integrations help · EisenQ",
  description: "How to connect and use EisenQ's integrations.",
};

const SECTIONS = [
  { id: "ai-connectors", title: "AI connectors (Claude, ChatGPT)" },
  { id: "assistant", title: "Built-in AI assistant" },
  { id: "capture", title: "Browser capture extension" },
  { id: "cashfold", title: "CashFold payments" },
  { id: "myndlist", title: "Myndlist checklists" },
  { id: "calendar", title: "Calendar feeds" },
  { id: "gemini", title: "Gemini (weather & deadlines)" },
] as const;

function Section({ id, title, where, children }: { id: string; title: string; where: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 pt-10">
      <h2 className="text-[26px] leading-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }}>{title}</h2>
      <p className="text-[12.5px] mt-1" style={{ color: "var(--muted)" }}>Set up in <strong style={{ color: "var(--ink3)" }}>{where}</strong></p>
      <div className="mt-4 space-y-4 text-[14.5px] leading-relaxed" style={{ color: "var(--ink3)" }}>{children}</div>
    </section>
  );
}

function H3({ children }: { children: ReactNode }) {
  return <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] pt-2" style={{ color: "var(--ink2)" }}>{children}</h3>;
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="list-decimal pl-5 space-y-1.5">{children}</ol>;
}

function Bullets({ children }: { children: ReactNode }) {
  return <ul className="list-disc pl-5 space-y-1.5">{children}</ul>;
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="text-[13px] rounded-[6px] break-all" style={{ padding: "1px 6px", background: "var(--chip)", color: "var(--ink)" }}>
      {children}
    </code>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-[10px]" style={{ border: "1px solid var(--field-bd)" }}>
      <table className="w-full text-[13.5px] text-left border-collapse">
        <thead>
          <tr style={{ background: "var(--field)" }}>
            {head.map((h) => (
              <th key={h} className="font-semibold" style={{ padding: "8px 12px", color: "var(--ink2)", borderBottom: "1px solid var(--field-bd)" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="align-top" style={{ padding: "8px 12px", borderBottom: i === rows.length - 1 ? undefined : "1px solid var(--line2)" }}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function IntegrationsHelpPage() {
  return (
    <main className="min-h-screen px-4 sm:px-6 pb-24">
      <PaperTheme />
      <div className="max-w-[760px] mx-auto">
        <div className="pt-8 flex items-center justify-between gap-3">
          <Link href="/dashboard" className="text-[13px] hover:underline" style={{ color: "var(--accent)" }}>← Back to EisenQ</Link>
        </div>

        <h1 className="text-[40px] leading-tight mt-6" style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }}>Integrations</h1>
        <p className="text-[15px] mt-2" style={{ color: "var(--ink3)" }}>
          What each integration does, how to set it up, what it can see, and how to switch it off. Everything is configured in{" "}
          <strong>Settings</strong> (the gear at the top of the dashboard). Keys and URLs you enter are encrypted before they are stored.
        </p>

        <nav aria-label="Integrations" className="mt-6 rounded-[12px]" style={{ padding: "12px 16px", background: "var(--card)", border: "1px solid var(--card-bd)" }}>
          <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 text-[14px]">
            {SECTIONS.map((s) => (
              <li key={s.id}><a href={`#${s.id}`} className="hover:underline" style={{ color: "var(--accent)" }}>{s.title}</a></li>
            ))}
          </ul>
        </nav>

        {/* ---------------------------------------------------------------- */}
        <Section id="ai-connectors" title="AI connectors (Claude, ChatGPT)" where="Settings → AI connectors">
          <p>
            Add EisenQ to Claude or ChatGPT as a connector and manage your matrix by talking to it. The AI app signs in to your EisenQ
            account, and can only do what you allow on the AI connectors tab.
          </p>

          <H3>Before you start</H3>
          <Steps>
            <li>Open <strong>Settings → AI connectors</strong> and turn on <strong>Allow AI connectors</strong>.</li>
            <li>Check the permissions and preferences, then choose <strong>Save changes</strong>. Saving also records this device&apos;s time zone (see below).</li>
          </Steps>

          <H3>Add to Claude</H3>
          <Steps>
            <li>In Claude, open <strong>Settings → Connectors</strong> and choose <strong>Add custom connector</strong>.</li>
            <li>Name it <strong>EisenQ</strong> and paste the address <Code>https://www.eisenq.app/api/mcp</Code>.</li>
            <li>Choose <strong>Connect</strong>. Claude opens the EisenQ sign-in; sign in and approve.</li>
            <li>In a chat, turn EisenQ on from the tools menu.</li>
          </Steps>

          <H3>Add to ChatGPT</H3>
          <Steps>
            <li>In ChatGPT, open <strong>Settings → Apps &amp; Connectors</strong>. Custom connectors may need <strong>Developer mode</strong>, under Advanced settings.</li>
            <li>Choose <strong>Create</strong>, name it <strong>EisenQ</strong>, paste <Code>https://www.eisenq.app/api/mcp</Code>, and pick <strong>OAuth</strong> as the authentication.</li>
            <li>Sign in to EisenQ and approve.</li>
            <li>In a chat, add EisenQ from the <strong>+</strong> menu.</li>
          </Steps>
          <p className="text-[13px]" style={{ color: "var(--muted)" }}>Menu names in Claude and ChatGPT change from time to time; look for “connectors” or “apps”.</p>

          <H3>Things to ask</H3>
          <Bullets>
            <li>“Add <em>call the accountant</em> to Schedule for Friday.”</li>
            <li>“What&apos;s my next action in Do First?”</li>
            <li>“Move the dentist booking to Delegate and make it low priority.”</li>
            <li>“Mark the invoice task done.”</li>
            <li>“Which tasks are overdue?” · “How am I doing on this month&apos;s goals?”</li>
            <li>Use the <strong>Prioritize my matrix</strong> prompt (in the connector&apos;s prompt menu) for a review: the AI proposes changes and applies only the ones you approve.</li>
          </Bullets>

          <H3>Permissions</H3>
          <Table
            head={["Permission", "Lets the AI", "Default"]}
            rows={[
              ["Read tasks", "List tasks, see each quadrant's next action, get an overview of the matrix", "On"],
              ["Add tasks", "Add new tasks", "On"],
              ["Edit tasks", "Rename, reschedule, change quadrant or priority, edit notes, link a goal, reopen a task", "On"],
              ["Complete tasks", "Tick tasks off", "On"],
              ["Remove tasks", "Archive or delete tasks (see “Removing a task”)", "Off"],
              ["Read goals", "List goals and their progress", "On"],
              ["Create & edit goals", "Add goals, rename them, pin them, mark them achieved, move them to another period", "Off"],
            ]}
          />
          <p>
            The two marked <strong>careful</strong> can change things that are harder to undo, so they start off. When a permission is off,
            the AI doesn&apos;t see that tool at all; if you ask for it anyway, it can tell you to switch it on here. Goals can&apos;t be deleted through a connector.
          </p>

          <H3>Preferences</H3>
          <Bullets>
            <li><strong>New tasks go to</strong>: the quadrant used when the AI doesn&apos;t name one (default Schedule). Do First tasks are always high priority, as in the app.</li>
            <li><strong>Removing a task</strong>: <em>Archives it</em> (default; restore it from Settings → Tasks) or <em>Deletes it</em> for good, with its subtasks. With delete, Claude and ChatGPT are told the action is destructive, so they usually ask you first.</li>
            <li><strong>Label tasks added by AI</strong>: shows “via Claude” (or the app&apos;s name) at the top of the task editor.</li>
            <li><strong>Share completed tasks</strong>: off means the AI only ever sees what is still open.</li>
            <li><strong>Daily limit</strong>: the most changes AI apps can make in a day (default 50). Adds, edits, completions, removals and goal changes count; reading doesn&apos;t. It resets at midnight in your time zone.</li>
          </Bullets>

          <H3>Dates and time zones</H3>
          <p>
            “Friday” means <em>your</em> Friday. Dates from AI apps are read in the time zone of the device you last saved this tab from. A date without a time means 9:00 AM, the same as the quick-schedule menu.
            If you move to another time zone, open the tab and save again.
          </p>

          <H3>Seeing and stopping what AI apps do</H3>
          <Bullets>
            <li><strong>Connected apps</strong> lists every app that has called EisenQ, with when it was last used. <strong>Revoke</strong> takes effect immediately: its next request is refused. <strong>Allow again</strong> undoes it.</li>
            <li><strong>Recent activity</strong> shows the latest changes from AI apps and from the built-in assistant.</li>
            <li>Turning off <strong>Allow AI connectors</strong> refuses every request from every app, once you save.</li>
            <li>To disconnect completely, also remove the connector in Claude or ChatGPT.</li>
          </Bullets>

          <H3>What the AI can&apos;t do</H3>
          <p>
            It works only with your own tasks and goals. It can&apos;t see your keys, calendar feeds, CashFold data or routine. It can&apos;t complete a task while a checklist you marked as
            required still has steps left, the same rule as in the app.
          </p>

          <H3>Troubleshooting</H3>
          <Bullets>
            <li><strong>“AI connectors are switched off”</strong>: turn on the switch and save.</li>
            <li><strong>“This app&apos;s access was revoked”</strong>: choose <em>Allow again</em> under Connected apps.</li>
            <li><strong>“Daily limit reached”</strong>: wait until midnight or raise the limit.</li>
            <li><strong>The AI says a tool doesn&apos;t exist</strong>: that permission is off. Apps sometimes remember the old tool list; start a new chat after changing permissions.</li>
            <li><strong>Connecting fails before you see a sign-in page</strong>: this is a server setting, not yours. See <em>docs/integrations/mcp.md</em> in the EisenQ repository (firewall bypass and Clerk OAuth setup).</li>
          </Bullets>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section id="assistant" title="Built-in AI assistant" where="Settings → Greeting → Claude API key">
          <p>
            The assistant panel looks at your open tasks and goals and suggests what to move, reschedule, link or drop. Nothing changes until you choose <strong>Apply</strong> on a suggestion.
          </p>
          <H3>Set up</H3>
          <Steps>
            <li>Create an API key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: "var(--accent)" }}>console.anthropic.com</a>.</li>
            <li>Paste it into <strong>Settings → Greeting → Claude API key</strong> and save.</li>
            <li>Open the assistant from the dashboard and ask, for example, “what should I drop this week?”</li>
          </Steps>
          <H3>What it sees and costs</H3>
          <p>
            Each message sends a snapshot of up to 300 open tasks (titles, notes, quadrant, priority, due date, age, goal) and your active goals to Anthropic, using your key, so it is billed to your Anthropic account.
            Applied suggestions follow the same rules as the matrix and appear under <strong>Recent activity</strong> on the AI connectors tab.
          </p>
          <H3>Assistant or AI connector?</H3>
          <p>
            The assistant is quick prioritization advice inside EisenQ, on your key. An AI connector lets Claude or ChatGPT read and change your matrix from their own apps, on their subscription, and can add tasks.
            They don&apos;t talk to each other; they follow the same rules, and both show up in one activity log.
          </p>
          <H3>Turn it off</H3>
          <p>Remove the key in Settings → Greeting and save.</p>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section id="capture" title="Browser capture extension" where="the EisenQ extension, then the Connect extension page">
          <p>
            Turn the page you&apos;re on, a text selection or a Gmail thread into a task without leaving it. Captured tasks keep a link back to where they came from.
          </p>
          <H3>Set up</H3>
          <Steps>
            <li>Install the EisenQ capture extension in Chrome.</li>
            <li>Open it and choose connect. That opens the <strong>Connect extension</strong> page on EisenQ; sign in if asked.</li>
            <li>The browser is connected. EisenQ stores only a fingerprint of the connection key, never the key itself.</li>
          </Steps>
          <H3>Deadlines</H3>
          <p>
            If you&apos;ve saved a Gemini key (see below), the capture panel can suggest the date that matters in what you captured, such as a deadline or an event.
          </p>
          <H3>Turn it off</H3>
          <p>
            Remove the extension from the browser. There is no button in EisenQ yet to disconnect a single browser remotely; ask your developer if a browser was lost.
          </p>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section id="cashfold" title="CashFold payments" where="Settings → Integrations → CashFold API integration">
          <p>Shows what&apos;s due today and where the day ends, above the Priority Matrix.</p>
          <H3>Set up</H3>
          <Steps>
            <li><strong>API endpoint</strong>: your CashFold day endpoint. Put <Code>{"{date}"}</Code> where the date goes; without it, <Code>?date=YYYY-MM-DD</Code> is added.</li>
            <li><strong>CashFold user ID</strong>: sent as <Code>?userId=</Code>.</li>
            <li><strong>API key</strong>: sent as the <Code>X-API-Key</Code> header.</li>
            <li>Choose <strong>Test connection</strong> to check what you typed before saving, then <strong>Save changes</strong>.</li>
          </Steps>
          <H3>Privacy</H3>
          <p>EisenQ&apos;s server makes the calls to CashFold with your stored credentials, which are only ever shown back to you, in Settings.</p>
          <H3>Turn it off</H3>
          <p>Choose <strong>Disconnect</strong> and save.</p>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section id="myndlist" title="Myndlist checklists" where="Settings → Integrations → Myndlist checklists">
          <p>
            Reuse Myndlist checklists on tasks. Attaching one copies its steps onto the task, so ticking them never changes the original.
            A checklist can be set to <strong>block the task</strong> until every required step is ticked.
          </p>
          <H3>Set up</H3>
          <Steps>
            <li><strong>Myndlist URL</strong>: your Myndlist address, for example <Code>https://your-myndlist.vercel.app</Code>.</li>
            <li><strong>API key</strong>: your Myndlist key.</li>
            <li><strong>Test connection</strong>, then <strong>Save changes</strong>.</li>
          </Steps>
          <H3>Turn it off</H3>
          <p>Choose <strong>Disconnect</strong> and save. Checklists already attached to tasks stay on them.</p>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section id="calendar" title="Calendar feeds" where="Settings → Calendar">
          <p>Today&apos;s events from your calendars appear next to your routine.</p>
          <H3>Set up</H3>
          <Steps>
            <li>Copy your calendar&apos;s iCal (<Code>.ics</Code>) address. For Google Calendar, use the <strong>Secret address in iCal format</strong>, not the public URL.</li>
            <li>Paste it into <strong>Settings → Calendar</strong>, add it, and save. Up to 10 feeds.</li>
          </Steps>
          <H3>Privacy</H3>
          <p>
            A secret iCal address works like a password, so it is stored encrypted. It is also kept in this browser for a fast start. EisenQ&apos;s server reads the feed; your calendar is never changed.
          </p>
          <H3>Turn it off</H3>
          <p>Remove the feed and save.</p>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section id="gemini" title="Gemini (weather & deadlines)" where="Settings → Greeting → Google Gemini API key">
          <p>
            Powers the what-to-wear line in your greeting (with the weather for your <strong>Weather location</strong>), and deadline suggestions in the capture extension.
          </p>
          <H3>Set up</H3>
          <Steps>
            <li>Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: "var(--accent)" }}>aistudio.google.com</a>.</li>
            <li>Paste it into <strong>Settings → Greeting</strong> and save.</li>
          </Steps>
          <H3>Privacy</H3>
          <p>
            Stored encrypted, and kept in this browser too so the greeting loads quickly. Weather itself comes from Open-Meteo and needs no key.
          </p>
          <H3>Turn it off</H3>
          <p>Choose <strong>Remove key</strong> and save.</p>
        </Section>

        <p className="text-[12.5px] pt-12" style={{ color: "var(--muted)" }}>
          Developer documentation for these integrations lives in <Code>docs/integrations/</Code> in the EisenQ repository.
        </p>
      </div>
    </main>
  );
}
