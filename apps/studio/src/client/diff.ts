// Minimal line-based diff via longest-common-subsequence. Pure; used by the
// save diff modal to show what changes on disk. Returns a sequence of rows
// tagged same / add / del, in document order.

export type DiffRow =
	| { type: "same"; text: string }
	| { type: "add"; text: string }
	| { type: "del"; text: string };

export function lineDiff(before: string, after: string): DiffRow[] {
	const a = before.split("\n");
	const b = after.split("\n");
	const n = a.length;
	const m = b.length;

	// lcs[i][j] = length of the LCS of a[i..] and b[j..].
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			const row = lcs[i] as number[];
			const below = lcs[i + 1] as number[];
			row[j] =
				a[i] === b[j]
					? (below[j + 1] as number) + 1
					: Math.max(below[j] as number, row[j + 1] as number);
		}
	}

	const rows: DiffRow[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		const row = lcs[i] as number[];
		const below = lcs[i + 1] as number[];
		if (a[i] === b[j]) {
			rows.push({ type: "same", text: a[i] as string });
			i++;
			j++;
		} else if ((below[j] as number) >= (row[j + 1] as number)) {
			rows.push({ type: "del", text: a[i] as string });
			i++;
		} else {
			rows.push({ type: "add", text: b[j] as string });
			j++;
		}
	}
	while (i < n) {
		rows.push({ type: "del", text: a[i] as string });
		i++;
	}
	while (j < m) {
		rows.push({ type: "add", text: b[j] as string });
		j++;
	}
	return rows;
}

// True when the diff contains at least one add or del row.
export function hasChanges(rows: DiffRow[]): boolean {
	return rows.some((r) => r.type !== "same");
}
