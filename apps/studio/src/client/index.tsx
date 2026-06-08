// React client entry. Studio opens as the Live Tower: a visual control tower for
// Chit activity across sessions. The boot payload is consumed for its launch
// token (stored in sessionStorage for authenticated /api/* calls); the bootstrap
// document/mode is not used to shape this screen, because the tower reads GET
// /api/live and never depends on a chit manifest in the cwd.

import "./styles.css";

import { createRoot } from "react-dom/client";
import { consumeBoot } from "./boot.ts";
import { LiveTower } from "./LiveTower.tsx";

// Stores the launch token in sessionStorage and clears it from the SSR payload.
// The returned bootstrap is intentionally unused: the Live Tower is the page for
// every boot mode, including an empty directory with no chit manifest.
consumeBoot();

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(<LiveTower />);
