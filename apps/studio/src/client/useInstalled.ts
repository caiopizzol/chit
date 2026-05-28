// Installed-surfaces state: the list of installed chits plus install /
// uninstall actions. Independent of the document editor; the install gate
// (must be saved, not previewing, etc.) is computed by the caller from editor
// state and passed to the button. Install always targets the Claude Code
// skill surface for now (see installDocument).

import { useCallback, useEffect, useState } from "react";
import type { InstalledSummary } from "../server/types.ts";
import {
	type InstallOutcome,
	installDocument,
	listInstalled,
	StudioApiError,
	uninstallDocument,
} from "./api.ts";

function errMessage(e: unknown): string {
	return e instanceof StudioApiError ? `${e.status}: ${e.message}` : (e as Error).message;
}

export interface InstalledState {
	list: InstalledSummary[];
	busy: boolean;
	error: string | null;
	install: (baseHash: string, allowUnenforcedPermissions: boolean) => Promise<InstallOutcome>;
	uninstall: (name: string) => Promise<void>;
}

export function useInstalled(docId: string): InstalledState {
	const [list, setList] = useState<InstalledSummary[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			setList(await listInstalled());
		} catch (e) {
			setError(errMessage(e));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const install = useCallback(
		async (baseHash: string, allowUnenforcedPermissions: boolean): Promise<InstallOutcome> => {
			setBusy(true);
			setError(null);
			try {
				const outcome = await installDocument(docId, baseHash, { allowUnenforcedPermissions });
				if (outcome.kind === "installed") {
					await refresh();
				} else if (outcome.kind === "error") {
					setError(outcome.error);
				}
				// conflict is returned to the caller to drive the reload path.
				return outcome;
			} catch (e) {
				const msg = errMessage(e);
				setError(msg);
				return { kind: "error", error: msg };
			} finally {
				setBusy(false);
			}
		},
		[docId, refresh],
	);

	const uninstall = useCallback(
		async (name: string) => {
			setBusy(true);
			setError(null);
			try {
				await uninstallDocument(name);
				await refresh();
			} catch (e) {
				setError(errMessage(e));
			} finally {
				setBusy(false);
			}
		},
		[refresh],
	);

	return { list, busy, error, install, uninstall };
}
