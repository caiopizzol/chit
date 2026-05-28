/** @jsxImportSource react */

// React client entry. Mounts <App> under <ReactFlowProvider> so React Flow
// hooks (useReactFlow, useNodesInitialized) work in nested components.

import "@xyflow/react/dist/style.css";
import "./styles.css";

import { ReactFlowProvider } from "@xyflow/react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
	<ReactFlowProvider>
		<App />
	</ReactFlowProvider>,
);
