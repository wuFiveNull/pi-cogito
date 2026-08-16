import { describe, expect, it } from "vitest";
import { normalizeOutboundText } from "../src/stages/outbound-text.ts";

describe("normalizeOutboundText (akashic outbound_text.py port)", () => {
	it("passes plain text through unchanged", () => {
		expect(normalizeOutboundText("你好，这是普通文本。")).toBe("你好，这是普通文本。");
	});

	it("unifies CRLF and lone CR to LF", () => {
		expect(normalizeOutboundText("a\r\nb")).toBe("a\nb");
		expect(normalizeOutboundText("a\rb")).toBe("a\nb");
		expect(normalizeOutboundText("a\r\nb\rc")).toBe("a\nb\nc");
	});

	it("decodes escaped line breaks when the text is clearly escaped (\\n\\n present)", () => {
		expect(normalizeOutboundText("第一行\\n\\n第二行")).toBe("第一行\n\n第二行");
	});

	it("decodes when escaped count >= 2 and exceeds real newlines", () => {
		expect(normalizeOutboundText("第一行\\n第二行\\n第三行")).toBe("第一行\n第二行\n第三行");
	});

	it("keeps a single escaped backslash-n as literal text", () => {
		// akashic:单处转义且无 "\\n\\n" 时不解码(可能是字面量路径)。
		expect(normalizeOutboundText("路径写为 data\\n (字面量)")).toBe("路径写为 data\\n (字面量)");
	});

	it("does not decode double-backslash escapes", () => {
		expect(normalizeOutboundText("路径 C:\\\\n 保持")).toBe("路径 C:\\\\n 保持");
	});

	it("decodes other C-style escapes only when triggered", () => {
		expect(normalizeOutboundText('引号\\"和\\t制表\\n\\n结尾')).toBe('引号"和\t制表\n\n结尾');
		expect(normalizeOutboundText("\\x41\\n\\n")).toBe("A\n\n");
	});

	it("decodes then re-unifies line breaks", () => {
		expect(normalizeOutboundText("a\\r\\n\\n\\r\\nb")).toBe("a\n\n\nb");
	});
});
