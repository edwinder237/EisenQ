import { Suspense } from "react";
import CaptureForm from "./CaptureForm";

// Phase 0 of the browser capture extension (docs/chrome-extension-capture-design.md).
// The extension opens this page in a small popup window with the captured context in the
// query string; the user's normal Clerk cookie session authenticates the task creation,
// so no token or CORS is involved at this stage.
export default function CapturePage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <CaptureForm />
    </Suspense>
  );
}
