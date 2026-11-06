import ConnectExtension from "./ConnectExtension";

// The browser capture extension opens this page to link itself to the signed-in
// account. It is private by default under the deny-by-default middleware, which
// is what turns "Connect" into a sign-in for a signed-out user: Clerk sends them
// to /sign-in and back here. See docs/chrome-extension-capture-design.md §4.4.
export default function ConnectExtensionPage() {
  return <ConnectExtension />;
}
