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

// /privacy: legal's notice for notifications, in English and French, with the
// person in charge and their address from optional public variables.

const render = () => renderToStaticMarkup(createElement(PrivacyPage));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/privacy", () => {
  it("renders without the variables: no placeholder or address, and the account-settings wording", () => {
    vi.stubEnv("NEXT_PUBLIC_PRIVACY_CONTACT", "");
    vi.stubEnv("NEXT_PUBLIC_PRIVACY_OFFICER", "");
    const html = render();
    expect(html).toContain("Privacy notice");
    expect(html).toContain("Avis de confidentialité");
    expect(html).toContain('id="en"');
    expect(html).toContain('id="fr"');
    expect(html).toContain(
      "The person in charge of protecting personal information is EisenQ&#x27;s developer. You can reach them through your account settings to find out what we hold about you",
    );
    expect(html).toContain("Vous pouvez la joindre par les paramètres de votre compte pour savoir");
    expect(html).not.toContain("{{");
    expect(html).not.toContain("mailto:");
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

  it("names the person in charge and links their address when Marc sets them", () => {
    vi.stubEnv("NEXT_PUBLIC_PRIVACY_CONTACT", "privacy@example.com");
    vi.stubEnv("NEXT_PUBLIC_PRIVACY_OFFICER", "A. Person");
    const html = render();
    expect(html).toContain(
      'is A. Person. You can reach them at <a href="mailto:privacy@example.com"',
    );
    expect(html).toContain('Vous pouvez la joindre à l&#x27;adresse <a href="mailto:privacy@example.com"');
    expect(html).not.toContain("through your account settings");
  });

  it("treats anything but a plain address as unset", () => {
    expect(privacyContactFrom({ NEXT_PUBLIC_PRIVACY_CONTACT: "not an address" }).email).toBeNull();
    expect(privacyContactFrom({ NEXT_PUBLIC_PRIVACY_CONTACT: "a@b.co<script>" }).email).toBeNull();
    expect(privacyContactFrom({ NEXT_PUBLIC_PRIVACY_CONTACT: " a@b.co " }).email).toBe("a@b.co");
    expect(privacyContactFrom({ NEXT_PUBLIC_PRIVACY_OFFICER: "{{x}}" }).officer).toBeNull();
  });

  it("is public, and linked from the landing page's footer", () => {
    const middleware = readFileSync(fileURLToPath(new URL("../../middleware.ts", import.meta.url)), "utf8");
    expect(middleware).toContain('"/privacy",');
    expect(renderToStaticMarkup(createElement(Footer))).toContain('href="/privacy"');
  });

  it("is linked from Settings → Notifications, next to the email and bell switches", () => {
    const html = renderToStaticMarkup(
      createElement(NotificationsSettings, {
        api: {} as NotificationsApi,
        draft: DEFAULT_NOTIFICATION_PREFERENCES,
        onChange: () => undefined,
      }),
    );
    expect(html).toContain("The daily email and bell notices are optional");
    expect(html).toContain('href="/privacy"');
  });
});
