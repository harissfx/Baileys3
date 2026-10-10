import { proto } from '../../WAProto/index.js'
import { generateMessageIDV2 } from './generics.js'

const JS_KEYWORDS = new Set([
	'import', 'export', 'from', 'default', 'as', 'const', 'let', 'var',
	'function', 'class', 'extends', 'new', 'return', 'if', 'else', 'for',
	'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch',
	'finally', 'throw', 'async', 'await', 'yield', 'typeof', 'instanceof',
	'in', 'of', 'delete', 'void', 'true', 'false', 'null', 'undefined',
	'NaN', 'Infinity', 'this', 'super', 'static', 'get', 'set', 'debugger', 'with'
])

const PYTHON_KEYWORDS = new Set([
	'import', 'from', 'as', 'def', 'class', 'return', 'if', 'elif', 'else',
	'for', 'while', 'break', 'continue', 'try', 'except', 'finally', 'raise',
	'with', 'yield', 'lambda', 'pass', 'del', 'global', 'nonlocal', 'assert',
	'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is', 'async', 'await',
	'self', 'print'
])

const LANGUAGE_KEYWORDS: Record<string, Set<string>> = {
	javascript: JS_KEYWORDS,
	typescript: JS_KEYWORDS,
	js: JS_KEYWORDS,
	ts: JS_KEYWORDS,
	python: PYTHON_KEYWORDS,
	py: PYTHON_KEYWORDS
}

export enum CodeHighlightType {
	DEFAULT = 0,
	KEYWORD = 1,
	METHOD = 2,
	STRING = 3,
	NUMBER = 4,
	COMMENT = 5
}

export enum RichSubMessageType {
	UNKNOWN = 0,
	GRID_IMAGE = 1,
	TEXT = 2,
	INLINE_IMAGE = 3,
	TABLE = 4,
	CODE = 5,
	DYNAMIC = 6,
	MAP = 7,
	LATEX = 8,
	CONTENT_ITEMS = 9
}

export type CodeBlock = {
	highlightType: CodeHighlightType
	codeContent: string
}

/**
 * Tokenize source code into highlighted blocks for rich code messages.
 */
export const tokenizeCode = (codeStr: string, language = 'javascript'): CodeBlock[] => {
	const keywords = LANGUAGE_KEYWORDS[language] || JS_KEYWORDS
	const blocks: CodeBlock[] = []
	const lines = codeStr.split('\n')

	for (let li = 0; li < lines.length; li++) {
		const line = lines[li] ?? ''
		const isLast = li === lines.length - 1
		const nl = isLast ? '' : '\n'

		if (!line.trim()) {
			blocks.push({ highlightType: CodeHighlightType.DEFAULT, codeContent: line + nl })
			continue
		}

		if (line.trim().startsWith('//') || line.trim().startsWith('#')) {
			blocks.push({ highlightType: CodeHighlightType.COMMENT, codeContent: line + nl })
			continue
		}

		const regex =
			/(\/\/.*$|#.*$)|(["'`](?:[^"'`\\]|\\.)*["'`])|(\b\d+(?:\.\d+)?\b)|(\b[a-zA-Z_$][\w$]*\b)|([^\s\w$"'`]+)|(\s+)/g
		let match: RegExpExecArray | null
		const tokens: CodeBlock[] = []

		while ((match = regex.exec(line)) !== null) {
			const val = match[0]
			if (match[1]) {
				tokens.push({ highlightType: CodeHighlightType.COMMENT, codeContent: val })
			} else if (match[2]) {
				tokens.push({ highlightType: CodeHighlightType.STRING, codeContent: val })
			} else if (match[3]) {
				tokens.push({ highlightType: CodeHighlightType.NUMBER, codeContent: val })
			} else if (match[4]) {
				if (keywords.has(val)) {
					tokens.push({ highlightType: CodeHighlightType.KEYWORD, codeContent: val })
				} else {
					const after = line.slice(regex.lastIndex).trimStart()
					if (after.startsWith('(')) {
						tokens.push({ highlightType: CodeHighlightType.METHOD, codeContent: val })
					} else {
						tokens.push({ highlightType: CodeHighlightType.DEFAULT, codeContent: val })
					}
				}
			} else {
				tokens.push({ highlightType: CodeHighlightType.DEFAULT, codeContent: val })
			}
		}

		if (tokens.length === 0) {
			blocks.push({ highlightType: CodeHighlightType.DEFAULT, codeContent: line + nl })
			continue
		}

		const merged: CodeBlock[] = []
		for (const t of tokens) {
			const prev = merged.length > 0 ? merged[merged.length - 1] : undefined
			if (prev && prev.highlightType === t.highlightType) {
				prev.codeContent += t.codeContent
			} else {
				merged.push({ ...t })
			}
		}
		if (merged.length > 0) {
			const last = merged[merged.length - 1]!
			last.codeContent += nl
		}
		blocks.push(...merged)
	}

	return blocks
}

export const buildRichContextInfo = (quoted?: any, options?: { botJid?: string; mentions?: string[] }) => {
	const ctxInfo: any = {
		forwardingScore: 1,
		isForwarded: true,
		forwardedAiBotMessageInfo: { botJid: options?.botJid ? options.botJid : '867051314767696@bot' },
		forwardOrigin: 4,
		...(options?.mentions ? { mentionedJid: options.mentions } : {})
	}
	if (quoted?.key) {
		ctxInfo.stanzaId = quoted.key.id
		ctxInfo.participant = quoted.key.participant || quoted.sender || quoted.key.remoteJid
		ctxInfo.quotedMessage = quoted.message
	}
	return ctxInfo
}

export const buildBotForwardedMessage = (
	submessages: any[],
	contextInfo: any,
	unifiedResponse?: any
): proto.IMessage => {
	const richResponse: any = { messageType: 1, submessages, contextInfo }
	if (unifiedResponse) {
		richResponse.unifiedResponse = unifiedResponse
	}
	return {
		botForwardedMessage: {
			message: { richResponseMessage: richResponse }
		}
	}
}

export const generateTableContent = (
	title: string,
	headers: string[],
	rows: string[][],
	quoted?: any,
	options: any = {}
) => {
	// Sesuai pou-code: tableMetadata.rows = [{ items, isHeading? }, ...]
	const { footer, headerText } = options
	const tableRows = [
		{ items: headers, isHeading: true },
		...rows.map(row => ({ items: row.map(String) }))
	]
	const submessages: any[] = []
	if (headerText) submessages.push({ messageType: 2, messageText: headerText })
	submessages.push({ messageType: 4, tableMetadata: { title, rows: tableRows } })
	if (footer) submessages.push({ messageType: 2, messageText: footer })
	const ctxInfo = buildRichContextInfo(quoted, options)
	return { message: buildBotForwardedMessage(submessages, ctxInfo), messageId: generateMessageIDV2() }
}

export const generateListContent = (title: string, items: string[], quoted?: any, options: any = {}) => {
	// Sesuai pou-code: list juga pakai tableMetadata (messageType 4), bukan bullet TEXT
	const { footer, headerText } = options
	const tableRows = items.map(item => ({
		items: Array.isArray(item) ? item.map(String) : [String(item)]
	}))
	const submessages: any[] = []
	if (headerText) submessages.push({ messageType: 2, messageText: headerText })
	submessages.push({ messageType: 4, tableMetadata: { title, rows: tableRows } })
	if (footer) submessages.push({ messageType: 2, messageText: footer })
	const ctxInfo = buildRichContextInfo(quoted, options)
	return { message: buildBotForwardedMessage(submessages, ctxInfo), messageId: generateMessageIDV2() }
}

export const generateCodeBlockContent = (
	code: string,
	quoted?: any,
	options: { language?: string; title?: string; footer?: string; botJid?: string; mentions?: string[] } = {}
) => {
	// Sesuai pou-code: codeMetadata.codeLanguage + codeBlocks
	const { language = 'javascript', title, footer } = options
	const submessages: any[] = []
	if (title) submessages.push({ messageType: 2, messageText: title })
	submessages.push({
		messageType: 5,
		codeMetadata: { codeLanguage: language, codeBlocks: tokenizeCode(code, language) }
	})
	if (footer) submessages.push({ messageType: 2, messageText: footer })
	const ctxInfo = buildRichContextInfo(quoted, options)
	return { message: buildBotForwardedMessage(submessages, ctxInfo), messageId: generateMessageIDV2() }
}

export const generateLatexContent = (quoted?: any, options: any = {}) => {
	const { text, expressions = [], headerText, footer } = options
	const submessages: any[] = []
	if (headerText) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: headerText })
	const latexExpressions = expressions.map((expr: any) => ({
		latexExpression: expr.latexExpression || expr,
		url: expr.url,
		width: expr.width,
		height: expr.height
	}))
	submessages.push({
		messageType: RichSubMessageType.LATEX,
		latexMetadata: { text: text || '', expressions: latexExpressions }
	})
	if (footer) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: footer })
	const ctxInfo = buildRichContextInfo(quoted, options)
	return { message: buildBotForwardedMessage(submessages, ctxInfo), messageId: generateMessageIDV2() }
}

export const generateLatexImageContent = async (
	quoted: any,
	options: any,
	uploadFn: (buffer: Buffer, type: string) => Promise<any>,
	renderLatexToPng: (expr: string) => Promise<{ buffer: Buffer; width: number; height: number }>
) => {
	const { text, expressions = [], headerText, footer } = options
	const submessages: any[] = []
	if (headerText) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: headerText })
	const latexExpressions: any[] = []
	for (const expr of expressions) {
		const latex = expr.latexExpression || expr
		const { buffer, width, height } = await renderLatexToPng(latex)
		const uploadResult = await uploadFn(buffer, 'image')
		const imageUrl = uploadResult.url || uploadResult.directPath
		latexExpressions.push({ latexExpression: latex, url: imageUrl, width, height })
	}
	submessages.push({
		messageType: RichSubMessageType.LATEX,
		latexMetadata: { text: text || '', expressions: latexExpressions }
	})
	if (footer) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: footer })
	const ctxInfo = buildRichContextInfo(quoted, options)
	return { message: buildBotForwardedMessage(submessages, ctxInfo), messageId: generateMessageIDV2() }
}

export const generateLatexInlineImageContent = async (
	quoted: any,
	options: any,
	uploadFn: (buffer: Buffer, type: string) => Promise<any>,
	renderLatexToPng: (expr: string) => Promise<{ buffer: Buffer; width: number; height: number }>
) => {
	const { text, expressions = [], headerText, footer } = options
	const submessages: any[] = []
	if (headerText) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: headerText })
	if (text) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: text })
	for (const expr of expressions) {
		const latex = expr.latexExpression || expr
		const { buffer, width, height } = await renderLatexToPng(latex)
		const uploadResult = await uploadFn(buffer, 'image')
		const imageUrl = uploadResult.url || uploadResult.directPath
		submessages.push({
			messageType: RichSubMessageType.INLINE_IMAGE,
			imageMetadata: {
				imageUrl: { imagePreviewUrl: imageUrl, imageHighResUrl: imageUrl },
				imageText: latex,
				alignment: 2
			}
		})
	}
	if (footer) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: footer })
	const ctxInfo = buildRichContextInfo(quoted, options)
	return { message: buildBotForwardedMessage(submessages, ctxInfo), messageId: generateMessageIDV2() }
}

export const captureUnifiedResponse = (msg: any) => {
	const botFwd = msg?.botForwardedMessage?.message
	if (!botFwd) return null
	const rich = botFwd.richResponseMessage
	if (!rich?.unifiedResponse?.data) return null
	return {
		unifiedResponse: { data: rich.unifiedResponse.data },
		submessages: rich.submessages || [],
		contextInfo: rich.contextInfo || {}
	}
}

export const generateUnifiedResponseContent = (quoted: any, captured: any) => {
	const ctxInfo = buildRichContextInfo(quoted)
	return {
		message: buildBotForwardedMessage(captured.submessages, ctxInfo, captured.unifiedResponse),
		messageId: generateMessageIDV2()
	}
}

export const generateRichMessageContent = (submessages: any[], quoted?: any, options?: any) => {
	const ctxInfo = buildRichContextInfo(quoted, options)
	return { message: buildBotForwardedMessage(submessages, ctxInfo), messageId: generateMessageIDV2() }
}

export { JS_KEYWORDS, PYTHON_KEYWORDS, LANGUAGE_KEYWORDS }
