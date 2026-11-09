import { type MetadataRoute } from "next";

// Web app manifest, served at /manifest.webmanifest.
//
// The icons below were removed once, on the theory that iOS was reading them
// and rejecting them. It wasn't: Vercel's bot protection was answering every
// icon request with an HTTP 429 challenge page, so iOS never saw an icon from
// any source. Dropping them only cost Android its WebAPK, which needs an icon
// of at least 192px.
//
// All three "any" icons are opaque and full-bleed: an alpha channel gets
// composited to black on iOS, and launchers apply their own shape mask.
export default function manifest(): MetadataRoute.Manifest {
  return {
    // ASCII only. The route is served as application/manifest+json with no
    // charset, so a non-ASCII byte sequence here decodes as Windows-1252 in
    // Safari ("EisenQ a€" Decide & Do").
    name: "EisenQ - Decide & Do",
    short_name: "EisenQ",
    description: "The Prioritization Engine. Decide what truly matters.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // --bg from the light palette, so the splash matches the paper ground.
    background_color: "#f1ecdc",
    theme_color: "#f1ecdc",
    icons: [
      { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Android adaptive icons: the launcher crops this to its own shape.
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
