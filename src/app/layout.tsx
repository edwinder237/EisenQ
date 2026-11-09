import "~/styles/globals.css";

import { type Metadata, type Viewport } from "next";
import { Inter, Newsreader } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Analytics } from "@vercel/analytics/react";

export const metadata: Metadata = {
  // Needed for absolute og:image URLs — link unfurlers cannot resolve a
  // relative one, so without this the preview card has no image.
  metadataBase: new URL("https://www.eisenq.app"),
  title: "EisenQ - Decide & Do",
  description: "The Prioritization Engine. Decide what truly matters.",
  openGraph: {
    type: "website",
    siteName: "EisenQ",
    title: "EisenQ - Decide & Do",
    description: "The Prioritization Engine. Decide what truly matters.",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "EisenQ - Decide & Do",
    description: "The Prioritization Engine. Decide what truly matters.",
  },
  // Declared explicitly rather than left to the file conventions, so each href
  // is a bare path. Next appends a cache-busting query to convention-generated
  // icon URLs, and a plain path is one less thing for a fetcher to mishandle.
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  // Lets iOS launch the home-screen shortcut without browser chrome and label
  // it "EisenQ".
  appleWebApp: {
    capable: true,
    title: "EisenQ",
    statusBarStyle: "default",
  },
};

// Tints the mobile browser and status bar to the paper ground, tracking the
// --bg token in each theme so the chrome doesn't cut against the page.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f1ecdc" },
    { media: "(prefers-color-scheme: dark)", color: "#15130d" },
  ],
};

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-newsreader",
});

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${inter.variable} ${newsreader.variable}`}>
        <body className="bg-gray-950 text-white font-sans">
          {children}
          <Analytics />
        </body>
      </html>
    </ClerkProvider>
  );
}
