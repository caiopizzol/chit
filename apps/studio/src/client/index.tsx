// React client entry. Reads the SSR boot payload, derives the initial
// ClientState, and mounts <App> under <ReactFlowProvider> so React Flow
// hooks work in nested components.

import "@xyflow/react/dist/style.css";
import "./styles.css";

import { ReactFlowProvider } from "@xyflow/react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { consumeBoot } from "./boot.ts";
import { initClientState } from "./state.ts";

const bootstrap = consumeBoot();
const initialState = initClientState(bootstrap);

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
	<ReactFlowProvider>
		<App state={initialState} />
	</ReactFlowProvider>,
);
