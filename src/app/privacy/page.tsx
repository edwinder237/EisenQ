import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment, type ReactNode } from "react";
import { PaperTheme } from "~/app/help/integrations/PaperTheme";
import {
  NOTICE,
  PRIVACY_CONTACT,
  PRIVACY_OFFICER,
  placeholderWords,
  privacyContact,
  privacyNoticePublished,
  type NoticeLanguage,
} from "~/lib/privacy-notice";

// /privacy: EisenQ's privacy notice, notifications section, in English and
// French (legal's text, ~/lib/privacy-notice.ts). Public, so anyone can read
// it before signing up or from an email. Linked from Settings → Notifications
// and from the landing page's footer. Same look as /help/integrations.
//
// Only with a contact address (NEXT_PUBLIC_PRIVACY_CONTACT): without one it
// answers 404 and nothing links to it, because a notice with no contact
// information doesn't meet Law 25, s. 3.1 (legal, edwinder237/socle#65).

export const metadata: Metadata = {
  title: "Privacy notice · EisenQ",
  description: "How EisenQ's notifications use your information.",
};

const LANGUAGES: Record<NoticeLanguage, string> = { en: "English", fr: "Français" };

type Contact = { officer: string | null; email: string };

function Filled({ text, lang, contact }: { text: string; lang: NoticeLanguage; contact: Contact }) {
  const words = placeholderWords(lang, contact);
  return (
    <>
      {text.split(/(\{\{PRIVACY_OFFICER\}\}|\{\{PRIVACY_CONTACT\}\})/).map((part, i) => (
        <Fragment key={i}>
          {part === PRIVACY_OFFICER
            ? words.officer
            : part === PRIVACY_CONTACT
              ? <>{words.contactBefore}<a href={`mailto:${contact.email}`} className="hover:underline" style={{ color: "var(--accent)" }}>{contact.email}</a></>
              : part}
        </Fragment>
      ))}
    </>
  );
}

function Lead({ children }: { children: ReactNode }) {
  return <em className="font-semibold not-italic" style={{ color: "var(--ink2)" }}>{children}</em>;
}

export default function PrivacyPage() {
  const contact = privacyContact();
  if (!privacyNoticePublished(contact)) notFound();
  return (
    <main className="min-h-screen px-4 sm:px-6 pb-24">
      <PaperTheme />
      <div className="max-w-[760px] mx-auto">
        <div className="pt-8 flex items-center justify-between gap-3">
          <Link href="/" className="text-[13px] hover:underline" style={{ color: "var(--accent)" }}>← Back to EisenQ</Link>
        </div>

        <h1 className="text-[40px] leading-tight mt-6" style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }}>Privacy notice</h1>
        <p lang="fr" className="text-[15px] mt-1" style={{ color: "var(--ink3)" }}>Avis de confidentialité</p>

        <nav aria-label="Language / Langue" className="mt-6 rounded-[12px] text-[14px] flex gap-5" style={{ padding: "12px 16px", background: "var(--card)", border: "1px solid var(--card-bd)" }}>
          {NOTICE.map((n) => (
            <a key={n.lang} href={`#${n.lang}`} lang={n.lang} className="hover:underline" style={{ color: "var(--accent)" }}>{LANGUAGES[n.lang]}</a>
          ))}
        </nav>

        {NOTICE.map((n) => (
          <section key={n.lang} id={n.lang} lang={n.lang} className="scroll-mt-6 pt-10">
            <p className="text-[12.5px] uppercase tracking-[0.08em]" style={{ color: "var(--muted)" }}>{LANGUAGES[n.lang]}</p>
            <h2 className="text-[26px] leading-tight mt-1" style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }}>{n.heading}</h2>
            <div className="mt-4 space-y-4 text-[14.5px] leading-relaxed" style={{ color: "var(--ink3)" }}>
              {n.blocks.map((b, i) =>
                b.kind === "p" ? (
                  <p key={i}>
                    {b.lead && <><Lead>{b.lead}</Lead>{" "}</>}
                    <Filled text={b.text} lang={n.lang} contact={contact} />
                  </p>
                ) : (
                  <div key={i}>
                    <p><Lead>{b.lead}</Lead></p>
                    <ul className="list-disc pl-5 space-y-1.5 mt-2">
                      {b.items.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  </div>
                ),
              )}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
