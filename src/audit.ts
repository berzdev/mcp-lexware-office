import { appendFileSync } from 'fs';
import { governance } from './governance.js';

type AuditAction = 'ALLOW' | 'STARTUP';

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

function write(entry: AuditEntry): void {
	if (!governance.auditLogPath) return;
	try {
		appendFileSync(governance.auditLogPath, formatEntry(entry), 'utf8');
	} catch {
		// Audit log write failures are silent — don't break the tool
	}
}

export function auditAllow(tool: string, details: Record<string, string> = {}): void {
	write({ action: 'ALLOW', tool, details: { ...details, user: 'mcp-claude' } });
}

// Fix #6: Governance denials are structural (tools never registered), so we log
// which tools were suppressed at startup rather than at call time.
export function auditStartup(suppressedTools: string[], safetyMode: string): void {
	write({
		action: 'STARTUP',
		tool: 'server',
		details: {
			safetyMode,
			suppressed: suppressedTools.length > 0 ? suppressedTools.join(',') : 'none',
		},
	});
}
