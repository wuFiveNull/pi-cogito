import { describe, expect, it } from "vitest";
import {
	allowsAllDomains,
	canonicalizePath,
	decideWritePolicy,
	domainIsAllowed,
	extractDomainsFromCommand,
	matchesPattern,
} from "../src/core/sandbox/policy.ts";

describe("sandbox policy", () => {
	it("extracts and deduplicates literal HTTP domains", () => {
		expect(extractDomainsFromCommand("curl https://api.example.com/a http://api.example.com/b")).toEqual([
			"api.example.com",
		]);
	});

	it("matches exact, wildcard, and all-domain policies", () => {
		expect(domainIsAllowed("github.com", ["github.com"])).toBe(true);
		expect(domainIsAllowed("api.github.com", ["*.github.com"])).toBe(true);
		expect(domainIsAllowed("notgithub.com", ["*.github.com"])).toBe(false);
		expect(allowsAllDomains(["*"])).toBe(true);
		expect(allowsAllDomains([])).toBe(false);
		expect(allowsAllDomains(undefined)).toBe(false);
	});

	it("decides write policy from deny and allow lists", () => {
		expect(decideWritePolicy("/tmp/file", ["/tmp"], ["/tmp/file"])).toBe("deny");
		expect(decideWritePolicy("/tmp/file", ["/tmp"], [])).toBe("allow");
		expect(decideWritePolicy("/tmp/file", ["/var"], [])).toBe("prompt");
		expect(decideWritePolicy("/tmp/file", [], [])).toBe("prompt");
	});

	it("canonicalizes paths through symlinks and missing tails", () => {
		expect(canonicalizePath("/tmp/../tmp")).toBe("/tmp");
		// Nonexistent paths resolve as far as the existing prefix allows.
		expect(canonicalizePath("/definitely/not/a/real/path")).toBe("/definitely/not/a/real/path");
	});

	it("matches directory prefixes and glob patterns", () => {
		expect(matchesPattern("/tmp/file.txt", ["/tmp"])).toBe(true);
		expect(matchesPattern("/tmp/sub/file.txt", ["/tmp"])).toBe(true);
		expect(matchesPattern("/tmpfile", ["/tmp"])).toBe(false);
		expect(matchesPattern("/tmp/file.txt", ["/tmp/*.txt"])).toBe(true);
		expect(matchesPattern("/tmp/file.log", ["/tmp/*.txt"])).toBe(false);
		expect(matchesPattern("/tmp/a/b/c.log", ["/tmp/**/*.log"])).toBe(true);
	});
});
