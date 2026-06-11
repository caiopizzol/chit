// React client entry. Studio opens as the Live Tower: a visual control tower for
// Chit activity across sessions. The boot payload is consumed only for its
// launch token, stored in sessionStorage for authenticated /api/* calls.

import "./styles.css";

import { createRoot } from "react-dom/client";
import { consumeBoot } from "./boot.ts";
import { LiveTower } from "./LiveTower.tsx";

// Stores the launch token in sessionStorage and clears it from the SSR payload.
consumeBoot();

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(<LiveTower />);
