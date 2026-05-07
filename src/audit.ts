import { appendFileSync } from 'fs';
import { governance } from './governance.js';

type AuditAction = 'ALLOW' | 'DENY';

interface AuditEntry {
	action: AuditAction;
	tool: string;
	details: Record<string, string>;
}

function formatEntry(entry: AuditEntry): string {
	const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
	const detailStr = Object.entries(entry.details)
		.map(([k, v]) => `${k}=${v}`)
		.join(' | ');
	return `${timestamp} | ${entry.action} | ${entry.tool} | ${detailStr}\n`;
}

export function auditLog(action: AuditAction, tool: string, details: Record<string, string>): void {
	if (!governance.auditLogPath) return;

	const line = formatEntry({ action, tool, details });
	try {
		appendFileSync(governance.auditLogPath, line, 'utf8');
	} catch {
		// Audit log write failures are silent — don't break the tool
	}
}

export function auditAllow(tool: string, details: Record<string, string> = {}): void {
	auditLog('ALLOW', tool, { ...details, user: 'mcp-claude' });
}

export function auditDeny(tool: string, details: Record<string, string> = {}): void {
	auditLog('DENY', tool, { ...details, user: 'mcp-claude', reason: 'permission denied' });
}
