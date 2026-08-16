/**
 * 出站文本清洗(akashic outbound_text.py port)。
 *
 * LLM 生成的推送文本经常混入字面转义(如 "\\n" 而不是真换行)和不统一的
 * 换行符(\r\n / \r)。先统一换行;当文本明显是"转义后的换行"时再解码
 * C 风格转义(与 akashic 相同的判定逻辑,避免把字面量路径里的 \n 误解码)。
 */

/** 转义换行检测:反斜杠后跟 n/r,且反斜杠前不是反斜杠。 */
const ESCAPED_LINE_BREAK_RE = /(?<!\\)\\[nr]/g;

/** C 风格转义序列(ftfy decode_escapes 子集,不含 \N{...} 命名转义)。 */
const ESCAPE_SEQUENCE_RE = /\\(?:[abfnrtv'"\\]|[0-7]{1,3}|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/g;

/** 统一换行:CRLF 与裸 CR → LF。 */
export function fixLineBreaks(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 解码 C 风格转义序列(\\n \\t \\x41 \\uXXXX \\UXXXXXXXX 八进制等)。 */
export function decodeEscapes(text: string): string {
	return text.replace(ESCAPE_SEQUENCE_RE, (match) => {
		const esc = match[1];
		switch (esc) {
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "a":
				return "\x07";
			case "b":
				return "\b";
			case "f":
				return "\f";
			case "v":
				return "\x0b";
			case "\\":
				return "\\";
			case "'":
				return "'";
			case '"':
				return '"';
			case "x":
			case "u":
				return String.fromCharCode(parseInt(match.slice(2), 16));
			case "U": {
				const code = parseInt(match.slice(2), 16);
				return code <= 0x10ffff ? String.fromCodePoint(code) : match;
			}
			default:
				// 八进制 \0-\377。
				return String.fromCharCode(parseInt(match.slice(1), 8));
		}
	});
}

function shouldDecodeEscapedLineBreaks(text: string): boolean {
	const escapedCount = text.match(ESCAPED_LINE_BREAK_RE)?.length ?? 0;
	if (escapedCount === 0) return false;
	if (text.includes("\\n\\n") || text.includes("\\r\\n")) return true;
	return escapedCount >= 2 && escapedCount > text.split("\n").length - 1;
}

/** 出站文本规范化(akashic normalize_outbound_text)。 */
export function normalizeOutboundText(text: string): string {
	const normalized = fixLineBreaks(text);
	if (shouldDecodeEscapedLineBreaks(normalized)) {
		return fixLineBreaks(decodeEscapes(normalized));
	}
	return normalized;
}
