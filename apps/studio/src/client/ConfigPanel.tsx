// Read-only effective-config drawer, opened from the Live Tower's top bar. It
// answers one question concisely: in this repo, which agents, roles, and recipes
// will Chit use, and where did each definition come from? It fetches GET /api/config
// on every open (the server re-reads disk per request, so an open always shows
// current state) and renders entries grouped by origin -- builtin / global /
// repo, labeled once per group. Strictly a viewer: no editing, no writes; env
// values and full role instructions never reach this component (the server
// redacts to key names and a bounded preview).

import { useEffect, useState } from "react";
import type { EffectiveConfigView } from "../server/types.ts";
import { type EffectiveConfigOutcome, fetchEffectiveConfig } from "./api.ts";
import { agentMeta, groupByOrigin, instructionsNote, recipeMeta, roleMeta } from "./configView.ts";

type PanelState = { kind: "loading" } | EffectiveConfigOutcome;

// The two config files, shown once at the top so the per-group origin labels
// can stay terse. An absent file is stated, not hidden: "no repo config" is
// exactly what an operator checking a repo wants to confirm.
function Sources({ config }: { config: EffectiveConfigView }) {
	return (
		<dl className="config-sources">
			<dt>global</dt>
			<dd>{config.configPath ? <code>{config.configPath}</code> : "none (defaults)"}</dd>
			<dt>repo</dt>
			<dd>{config.repoConfigPath ? <code>{config.repoConfigPath}</code> : "none"}</dd>
		</dl>
	);
}

function Agents({ config }: { config: EffectiveConfigView }) {
	return (
		<section className="config-section">
			<h3 className="live-col-head">
				Agents
				<span className="live-count">{config.agents.length}</span>
			</h3>
			{groupByOrigin(config.agents).map((group) => (
				<div key={group.origin}>
					<h4 className={`config-origin config-origin--${group.origin}`}>{group.origin}</h4>
					<ul className="config-list">
						{group.items.map((agent) => (
							<li key={agent.id} className="config-item">
								<div className="config-item-head">
									<code className="config-id">{agent.id}</code>
									<span className="config-adapter">{agent.adapter}</span>
								</div>
								<p className="config-meta">{agentMeta(agent)}</p>
								{agent.description && <p className="config-desc">{agent.description}</p>}
							</li>
						))}
					</ul>
				</div>
			))}
		</section>
	);
}

function Roles({ config }: { config: EffectiveConfigView }) {
	return (
		<section className="config-section">
			<h3 className="live-col-head">
				Roles
				<span className="live-count">{config.roles.length}</span>
			</h3>
			{config.roles.length === 0 ? (
				<p className="live-muted">No roles defined.</p>
			) : (
				groupByOrigin(config.roles).map((group) => (
					<div key={group.origin}>
						<h4 className={`config-origin config-origin--${group.origin}`}>{group.origin}</h4>
						<ul className="config-list">
							{group.items.map((role) => (
								<li key={role.id} className="config-item">
									<div className="config-item-head">
										<code className="config-id">{role.id}</code>
									</div>
									<p className="config-meta">{roleMeta(role)}</p>
									<p className="config-desc">{instructionsNote(role)}</p>
								</li>
							))}
						</ul>
					</div>
				))
			)}
		</section>
	);
}

function Recipes({ config }: { config: EffectiveConfigView }) {
	return (
		<section className="config-section">
			<h3 className="live-col-head">
				Recipes
				<span className="live-count">{config.recipes.length}</span>
			</h3>
			{config.recipes.length === 0 ? (
				<p className="live-muted">No recipes defined.</p>
			) : (
				groupByOrigin(config.recipes).map((group) => (
					<div key={group.origin}>
						<h4 className={`config-origin config-origin--${group.origin}`}>{group.origin}</h4>
						<ul className="config-list">
							{group.items.map((recipe) => (
								<li key={recipe.id} className="config-item">
									<div className="config-item-head">
										<code className="config-id">{recipe.id}</code>
									</div>
									<p className="config-meta">{recipeMeta(recipe)}</p>
									{recipe.description && <p className="config-desc">{recipe.description}</p>}
								</li>
							))}
						</ul>
					</div>
				))
			)}
		</section>
	);
}

function Body({ state }: { state: PanelState }) {
	switch (state.kind) {
		case "loading":
			return <p className="live-muted">Loading effective config...</p>;
		case "unavailable":
			return <p className="live-muted">Config view is not available (no host attached).</p>;
		case "error":
			// A load failure is signal: the operator likely has a malformed config
			// file, and the loader's message names it.
			return <p className="config-error">{state.error}</p>;
		case "ok":
			return (
				<>
					<Sources config={state.config} />
					<Agents config={state.config} />
					<Roles config={state.config} />
					<Recipes config={state.config} />
				</>
			);
	}
}

export function ConfigPanel({ onClose }: { onClose: () => void }) {
	const [state, setState] = useState<PanelState>({ kind: "loading" });

	useEffect(() => {
		let alive = true;
		fetchEffectiveConfig()
			.then((outcome) => {
				if (alive) setState(outcome);
			})
			.catch((e) => {
				if (alive) setState({ kind: "error", status: 0, error: (e as Error).message });
			});
		return () => {
			alive = false;
		};
	}, []);

	return (
		<div className="drawer-overlay">
			<button type="button" className="drawer-backdrop" aria-label="Close" onClick={onClose} />
			<aside className="drawer" role="dialog" aria-modal="true" aria-label="Effective config">
				<header className="drawer-head">
					<h2>Config</h2>
					<button type="button" className="drawer-close" aria-label="Close" onClick={onClose}>
						Close
					</button>
				</header>
				<Body state={state} />
			</aside>
		</div>
	);
}
