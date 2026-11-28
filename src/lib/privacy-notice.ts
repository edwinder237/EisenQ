// EisenQ's privacy notice, notifications section (/privacy). Legal's text,
// word for word, in English and French: edwinder237/socle,
// docs/privacy/eisenq-notifications-notice.md, as updated on 2026-11-28.
// Marc publishes it and may change it; anything that stops being true (a new
// field, task names, a new provider, tracking) changes this text first, after
// a new legal review.
//
// Two placeholders, filled from public variables so no one's name or address
// sits in the code:
// - {{PRIVACY_OFFICER}}: NEXT_PUBLIC_PRIVACY_OFFICER, the person in charge of
//   protecting personal information. Optional: unset, the title "EisenQ's
//   developer", which legal accepts (a title is enough).
// - {{PRIVACY_CONTACT}}: NEXT_PUBLIC_PRIVACY_CONTACT, their address. Required:
//   without a plain address the notice has no contact information (Law 25,
//   s. 3.1; PIPEDA 4.8.2, legal on edwinder237/socle#65), so /privacy answers
//   404 and nothing links to it (privacyNoticePublished()).

export type NoticeLanguage = "en" | "fr";

export type NoticeBlock =
  | { kind: "p"; lead?: string; text: string }
  | { kind: "list"; lead: string; items: string[] };

export interface NoticeText {
  lang: NoticeLanguage;
  heading: string;
  blocks: NoticeBlock[];
}

export const PRIVACY_OFFICER = "{{PRIVACY_OFFICER}}";
export const PRIVACY_CONTACT = "{{PRIVACY_CONTACT}}";

const SENDER = "notifications@notify.socle-services.app";

export const NOTICE: readonly NoticeText[] = [
  {
    lang: "en",
    heading: "Notifications",
    blocks: [
      { kind: "p", text: "EisenQ has a bell inside the app and an optional daily summary email." },
      {
        kind: "p",
        lead: "The bell.",
        text: "The bell is on for every account, and you can turn it off in Settings → Notifications. It shows reminders about your tasks, which come from EisenQ itself and stay in EisenQ, and notices, such as a daily copy of your summary with the same three counts and never a task name, note or date. To show notices, EisenQ uses Novu, a service provider. Novu stores your notices, whether you have read or dismissed each one, and your notification choices. While EisenQ is open with the bell on, your browser contacts Novu when the page loads, when you open the bell and every 5 minutes. So Novu receives your IP address and your browser details, and can tell when EisenQ is open. Novu keeps each notice for 30 days, dismissed or not, and your choices until your account is deleted. The bell doesn't give Novu your email address.",
      },
      {
        kind: "p",
        lead: "The daily summary email.",
        text: `It's off until you turn it on in Settings → Notifications and save. It shows how many of your tasks are overdue or due today, how many are coming up and how many routines you missed. It holds counts only, never task names, notes or dates. You get at most one a day, from ${SENDER}. You can stop it in EisenQ's settings, or with the one-click unsubscribe link in any summary email.`,
      },
      {
        kind: "p",
        lead: "Who handles your information.",
        text: "EisenQ passes your account ID and your summary's three counts to Socle, a notification service run by EisenQ's developer and hosted by Vercel and Neon. If you turned the summary email on, EisenQ also passes your account's primary email address. Socle keeps your choices for the bell and the email (on or off, and when and how each changed), without your email address, until your account is deleted. It hands the notices to Novu, which stores them, and the email to Resend, which sends it. All of them are in the United States, outside Quebec and Canada. Your information there is covered by our agreements with them, but US law applies to it, and US authorities may be able to access it.",
      },
      {
        kind: "list",
        lead: "How long it's kept.",
        items: [
          "Novu keeps your email address only while the summary is on.",
          "Novu and Resend keep each email for about 30 days.",
          "Socle keeps a record that a notice or email was sent, without your address or ID, for about 90 days.",
          "When you delete your account, your Novu profile, notices and choices, and Socle's record of your choices, are deleted within 30 days.",
        ],
      },
      {
        kind: "p",
        lead: "Tracking.",
        text: 'Open and click tracking are off. However, Novu adds a "Powered by Novu" image to each email. If you open the email with images turned on, Novu may learn that the email was opened, when it was opened, and the IP address of the device or mail service that loaded the image. If you click the unsubscribe link, Vercel, which hosts Socle, receives your IP address with that request.',
      },
      {
        kind: "p",
        text: `The person in charge of protecting personal information is ${PRIVACY_OFFICER}. You can reach them ${PRIVACY_CONTACT} to find out what we hold about you, to correct it, or to have it deleted. We answer within 30 days.`,
      },
    ],
  },
  {
    lang: "fr",
    heading: "Notifications",
    blocks: [
      { kind: "p", text: "EisenQ offre une cloche dans l'application et, si vous le souhaitez, un courriel de résumé quotidien." },
      {
        kind: "p",
        lead: "La cloche.",
        text: "La cloche est activée pour chaque compte, et vous pouvez la désactiver dans Paramètres → Notifications. Elle affiche des rappels sur vos tâches, qui viennent d'EisenQ et restent dans EisenQ, et des avis, comme une copie quotidienne de votre résumé avec les trois mêmes chiffres, jamais le nom, les notes ni les dates de vos tâches. Pour afficher les avis, EisenQ fait appel à Novu, un fournisseur de services. Novu conserve vos avis, le fait que vous ayez lu ou écarté chacun d'eux, ainsi que vos choix de notifications. Quand EisenQ est ouvert et que la cloche est activée, votre navigateur communique avec Novu à l'ouverture de la page, quand vous ouvrez la cloche et toutes les 5 minutes. Novu reçoit donc votre adresse IP et des renseignements sur votre navigateur, et peut savoir quand EisenQ est ouvert. Novu conserve chaque avis 30 jours, écarté ou non, et vos choix jusqu'à la suppression de votre compte. La cloche ne transmet pas votre adresse courriel à Novu.",
      },
      {
        kind: "p",
        lead: "Le courriel de résumé quotidien.",
        text: `Il reste désactivé tant que vous ne l'activez pas dans Paramètres → Notifications et que vous n'enregistrez pas ce choix. Il indique combien de vos tâches sont en retard ou à faire aujourd'hui, combien sont à venir et combien de routines vous avez manquées. Il ne contient que des chiffres, jamais le nom, les notes ni les dates de vos tâches. Vous en recevez au plus un par jour, envoyé par ${SENDER}. Vous pouvez l'arrêter dans les paramètres d'EisenQ, ou en un clic avec le lien de désabonnement présent dans chaque courriel de résumé.`,
      },
      {
        kind: "p",
        lead: "Qui traite vos renseignements.",
        text: "EisenQ transmet votre identifiant de compte et les trois chiffres de votre résumé à Socle, un service de notifications exploité par le développeur d'EisenQ et hébergé par Vercel et Neon. Si vous avez activé le courriel de résumé, EisenQ transmet aussi l'adresse courriel principale de votre compte. Socle conserve vos choix pour la cloche et le courriel (activé ou non, ainsi que la date et la façon dont chacun a changé), sans votre adresse courriel, jusqu'à la suppression de votre compte. Il confie les avis à Novu, qui les conserve, et le courriel à Resend, qui l'envoie. Tous se trouvent aux États-Unis, à l'extérieur du Québec et du Canada. Vos renseignements y sont protégés par nos ententes avec ces fournisseurs, mais ils restent soumis aux lois américaines, et les autorités américaines pourraient y avoir accès.",
      },
      {
        kind: "list",
        lead: "Durée de conservation.",
        items: [
          "Novu ne conserve votre adresse courriel que pendant que le résumé est activé.",
          "Novu et Resend conservent chaque courriel environ 30 jours.",
          "Socle garde environ 90 jours une trace de l'envoi d'un avis ou d'un courriel, sans votre adresse ni votre identifiant.",
          "Quand vous supprimez votre compte, votre profil, vos avis et vos choix chez Novu, ainsi que la trace de vos choix chez Socle, sont supprimés dans les 30 jours.",
        ],
      },
      {
        kind: "p",
        lead: "Suivi.",
        text: "Le suivi des ouvertures et des clics est désactivé. Toutefois, Novu ajoute en bas de chaque courriel la mention « Powered by Novu » avec une image. Si vous ouvrez le courriel avec les images activées, Novu peut apprendre que le courriel a été ouvert, à quel moment, et l'adresse IP de l'appareil ou du service de messagerie qui a chargé l'image. Si vous cliquez sur le lien de désabonnement, Vercel, qui héberge Socle, reçoit votre adresse IP avec cette demande.",
      },
      {
        kind: "p",
        text: `La personne responsable de la protection des renseignements personnels est ${PRIVACY_OFFICER}. Vous pouvez la joindre ${PRIVACY_CONTACT} pour savoir quels renseignements nous détenons à votre sujet, pour les faire corriger ou pour les faire supprimer. Nous répondons dans les 30 jours.`,
      },
    ],
  },
];

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[A-Za-z]{2,24}$/;

export interface PrivacyContact {
  officer: string | null;
  /** A plain email address, or null when unset or not one. */
  email: string | null;
}

/** From the optional public variables. Anything that isn't a plain address counts as unset. */
export function privacyContactFrom(source: {
  NEXT_PUBLIC_PRIVACY_OFFICER?: string;
  NEXT_PUBLIC_PRIVACY_CONTACT?: string;
}): PrivacyContact {
  const officer = source.NEXT_PUBLIC_PRIVACY_OFFICER?.trim();
  const email = source.NEXT_PUBLIC_PRIVACY_CONTACT?.trim();
  return {
    officer: officer && officer.length <= 120 && !/[<>{}]/.test(officer) ? officer : null,
    email: email && EMAIL.test(email) ? email : null,
  };
}

/** Whether /privacy is published: only with a contact address. Nothing links to it otherwise. */
export function privacyNoticePublished(contact: PrivacyContact = privacyContact()): contact is PrivacyContact & { email: string } {
  return contact.email !== null;
}

export function privacyContact(): PrivacyContact {
  // Read directly: Next inlines NEXT_PUBLIC_ values at build time.
  return privacyContactFrom({
    NEXT_PUBLIC_PRIVACY_OFFICER: process.env.NEXT_PUBLIC_PRIVACY_OFFICER,
    NEXT_PUBLIC_PRIVACY_CONTACT: process.env.NEXT_PUBLIC_PRIVACY_CONTACT,
  });
}

/** The words that fill each placeholder, in a language. The address itself is rendered as a link by the page. */
export function placeholderWords(lang: NoticeLanguage, contact: PrivacyContact) {
  return {
    officer: contact.officer ?? (lang === "fr" ? "le développeur d'EisenQ" : "EisenQ's developer"),
    contactBefore: lang === "fr" ? "à l'adresse " : "at ",
  };
}
