import { logger } from './logger.js';

const LEXWARE_OFFICE_API_KEY = process.env.LEXWARE_OFFICE_API_KEY!;
if (!LEXWARE_OFFICE_API_KEY) {
	logger.error('Error: LEXWARE_OFFICE_API_KEY environment variable is required');
	process.exit(1);
}

const LEXOFFICE_API_BASE = 'https://api.lexoffice.io';
const USER_AGENT = 'mcp-lexware-office/2.0.0';

export type WriteResult<T> =
	| { ok: true; data: T }
	| { ok: false; status: number; error: unknown };

// Fix #4: return WriteResult instead of T|null so callers get actionable status codes
export async function makeLexwareOfficeRequest<T>(path: string): Promise<WriteResult<T>> {
	const url = `${LEXOFFICE_API_BASE}${path}`;
	const headers = {
		'User-Agent': USER_AGENT,
		Accept: 'application/json',
		Authorization: `Bearer ${LEXWARE_OFFICE_API_KEY}`,
	};

	logger.log('Making Lexware Office request', { url });

	try {
		const response = await fetch(url, { headers });
		let responseBody: unknown;
		try { responseBody = await response.json(); } catch { responseBody = null; }

		if (!response.ok) {
			logger.error('Lexware Office request failed', { status: response.status, url });
			return { ok: false, status: response.status, error: responseBody };
		}

		logger.log('Lexware Office response', { status: response.status });
		return { ok: true, data: responseBody as T };
	} catch (error) {
		logger.error('Error making Lexware Office request', { error });
		return { ok: false, status: 0, error: 'Network or server error' };
	}
}

export async function makeLexwareOfficeFileRequest(
	path: string,
	accept: 'application/pdf' | 'application/xml',
): Promise<{ data: Buffer; mimeType: string } | null> {
	const url = `${LEXOFFICE_API_BASE}${path}`;
	const headers = {
		'User-Agent': USER_AGENT,
		Accept: accept,
		Authorization: `Bearer ${LEXWARE_OFFICE_API_KEY}`,
	};

	logger.log('Making Lexware Office file request', { url });

	try {
		const response = await fetch(url, { headers });
		if (!response.ok) {
			logger.error('Lexware Office file request failed', { status: response.status, url });
			return null;
		}
		const contentType = response.headers.get('Content-Type') ?? accept;
		const mimeType = contentType.split(';')[0].trim();
		const arrayBuffer = await response.arrayBuffer();
		const data = Buffer.from(arrayBuffer);
		logger.log('Lexware Office file response received', { mimeType, bytes: data.length });
		return { data, mimeType };
	} catch (error) {
		logger.error('Error making Lexware Office file request', { error });
		return null;
	}
}

export async function makeLexwareOfficeWriteRequest<T>(
	path: string,
	method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
	body?: unknown,
): Promise<WriteResult<T> | null> {
	const url = `${LEXOFFICE_API_BASE}${path}`;
	// Fix #8: only set Content-Type when a body is actually sent
	const headers: Record<string, string> = {
		'User-Agent': USER_AGENT,
		Accept: 'application/json',
		Authorization: `Bearer ${LEXWARE_OFFICE_API_KEY}`,
		...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
	};

	logger.log('Making Lexware Office write request', { url, method });

	try {
		const response = await fetch(url, {
			method,
			headers,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});

		let responseBody: unknown;
		try { responseBody = await response.json(); } catch { responseBody = null; }

		if (!response.ok) {
			logger.error('Lexware Office write request failed', { status: response.status, error: responseBody });
			return { ok: false, status: response.status, error: responseBody };
		}

		logger.log('Lexware Office write response', { status: response.status });
		return { ok: true, data: responseBody as T };
	} catch (error) {
		logger.error('Error making Lexware Office write request', { error });
		return null;
	}
}

export async function makeLexwareOfficeMultipartRequest<T>(
	path: string,
	formData: FormData,
): Promise<WriteResult<T> | null> {
	const url = `${LEXOFFICE_API_BASE}${path}`;
	const headers = {
		'User-Agent': USER_AGENT,
		Accept: 'application/json',
		Authorization: `Bearer ${LEXWARE_OFFICE_API_KEY}`,
	};

	logger.log('Making Lexware Office multipart request', { url });

	try {
		const response = await fetch(url, { method: 'POST', headers, body: formData });

		let responseBody: unknown;
		try { responseBody = await response.json(); } catch { responseBody = null; }

		if (!response.ok) {
			logger.error('Lexware Office multipart request failed', { status: response.status, error: responseBody });
			return { ok: false, status: response.status, error: responseBody };
		}

		logger.log('Lexware Office multipart response', { status: response.status });
		return { ok: true, data: responseBody as T };
	} catch (error) {
		logger.error('Error making Lexware Office multipart request', { error });
		return null;
	}
}
