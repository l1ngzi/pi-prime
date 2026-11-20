import assert from "node:assert/strict";
import test from "node:test";
import { availableParallelism } from "node:os";
import { executionResourceSummary } from "../src/execution-resources.ts";

test("the prompt reports estimated parallelism and distinguishes a memory constraint from system RAM", t => {
	let bytes = 512 * 1024 ** 2;
	t.mock.method(process, "constrainedMemory", () => bytes);
	const limited = executionResourceSummary();
	const estimate = Number(limited.match(/CPU parallelism is (\d+)/)?.[1]);
	assert.ok(estimate >= 1 && estimate <= availableParallelism());
	assert.match(limited, /memory constraint of 512 MiB/);
	bytes = 0;
	assert.match(executionResourceSummary(), /Total system memory is [\d.]+ \S+/);
});
