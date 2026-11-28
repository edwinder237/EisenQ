import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationsSettings } from "~/components/NotificationsSettings";
import { Footer } from "~/components/landing/Footer";
import type { NotificationsApi } from "~/lib/notifications/client";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "~/lib/notifications/types";
import { privacyContactFrom } from "~/lib/privacy-notice";
import PrivacyPage from "./page";

// /privacy: legal's notice for notifications, in English and French. It's
// published only with a contact address (NEXT_PUBLIC_PRIVACY_CONTACT):
// without one it answers 404 and nothing links to it (legal, Law 25 s. 3.1,
// on edwinder237/socle#65). The person in charge's name is optional.

const render = () => renderToStaticMarkup(createElement(PrivacyPage));
const footer = () => renderToStaticMarkup(createElement(Footer));
const settings = () =>
  renderToStaticMarkup(
    createElement(NotificationsSettings, {
      api: {} as NotificationsApi,
      draft: DEFAULT_NOTIFICATION_PREFERENCES,
      onChange: () => undefined,
    }),
  );

/** What Next's notFound() throws: its 404. */
function answers404(): boolean {
  try {
    render();
    return false;
  } catch (err) {
    return String((err as { digest?: unknown }).digest).startsWith("NEXT_HTTP_ERROR_FALLBACK;404");
  }
}

function setEnv(contact: string, officer = "") {
  vi.stubEnv("NEXT_PUBLIC_PRIVACY_CONTACT", contact);
  vi.stubEnv("NEXT_PUBLIC_PRIVACY_OFFICER", officer);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/privacy without a contact address", () => {
  it("answers 404, unset or not a plain address", () => {
    setEnv("");
    expect(answers404()).toBe(true);
    setEnv("not an address", "A. Person");
    expect(answers404()).toBe(true);
  });

  it("isn't linked from the landing footer or Settings, and the line under the switches is gone", () => {
    setEnv("");
    expect(footer()).not.toContain("/privacy");
    expect(footer()).toContain("Lumeve");
    const html = settings();
    expect(html).not.toContain("/privacy");
    expect(html).not.toContain("are optional");
    expect(html).toContain("Bell notices");
  });
});

describe("/privacy with a contact address", () => {
  it("renders legal's text in both languages, with the address as a link and the title when no name is set", () => {
    setEnv("privacy@example.com");
    const html = render();
    expect(html).toContain("Privacy notice");
    expect(html).toContain("Avis de confidentialité");
    expect(html).toContain('id="en"');
    expect(html).toContain('id="fr"');
    expect(html).toContain(
      'The person in charge of protecting personal information is EisenQ&#x27;s developer. You can reach them at <a href="mailto:privacy@example.com"',
    );
    expect(html).toContain(
      'est le développeur d&#x27;EisenQ. Vous pouvez la joindre à l&#x27;adresse <a href="mailto:privacy@example.com"',
    );
    expect(html).not.toContain("{{");
    expect(html).not.toContain("account settings");
    // Legal's text, both languages: the providers, the sender, the footer image.
    for (const words of [
      "To show notices, EisenQ uses Novu, a service provider.",
      "and the email to Resend, which sends it.",
      "notifications@notify.socle-services.app",
      "Powered by Novu",
      "When you delete your account, your Novu profile, notices and choices, and Socle&#x27;s record of your choices, are deleted within 30 days.",
      "La cloche ne transmet pas votre adresse courriel à Novu.",
    ])
      expect(html).toContain(words);
  });

  it("names the person in charge when that's set too", () => {
    setEnv("privacy@example.com", "A. Person");
    expect(render()).toContain("is A. Person. You can reach them at");
  });

  it("is linked from the landing footer, and from Settings by the line under the switches", () => {
    setEnv("privacy@example.com");
    expect(footer()).toContain('href="/privacy"');
    const html = settings();
    expect(html).toContain("The daily email and bell notices are optional");
    expect(html).toContain('href="/privacy"');
  });

  it("is public", () => {
    const middleware = readFileSync(fileURLToPath(new URL("../../middleware.ts", import.meta.url)), "utf8");
    expect(middleware).toContain('"/privacy",');
  });
});

describe("the variables", () => {
  it("count anything but a plain address as unset, and refuse a name with markup", () => {
    expect(privacyContactFrom({ NEXT_PUBLIC_PRIVACY_CONTACT: "not an address" }).email).toBeNull();
    expect(privacyContactFrom({ NEXT_PUBLIC_PRIVACY_CONTACT: "a@b.co<script>" }).email).toBeNull();
    expect(privacyContactFrom({ NEXT_PUBLIC_PRIVACY_CONTACT: " a@b.co " }).email).toBe("a@b.co");
    expect(privacyContactFrom({ NEXT_PUBLIC_PRIVACY_OFFICER: "{{x}}" }).officer).toBeNull();
  });
});
