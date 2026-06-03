export type SafetyMode = 'safe' | 'standard' | 'unrestricted' | 'custom';

export interface FinalizePermissions {
	invoices: boolean;
	quotations: boolean;
	creditNotes: boolean;
	orderConfirmations: boolean;
	deliveryNotes: boolean;
	dunnings: boolean;
}

export interface DeletePermissions {
	// Draft-numbered document deletion — NEVER enabled by a preset, requires explicit opt-in
	invoiceDrafts: boolean;
	quotationDrafts: boolean;
	creditNoteDrafts: boolean;
	orderConfirmationDrafts: boolean;
	deliveryNoteDrafts: boolean;
	// Master-data deletion
	articles: boolean;
	contacts: boolean;
	vouchers: boolean;
	// Technical (always safe to delete)
	eventSubscriptions: boolean;
}

export interface ArchivePermissions {
	contacts: boolean;
	articles: boolean;
}

export interface Permissions {
	finalize: FinalizePermissions;
	delete: DeletePermissions;
	archive: ArchivePermissions;
}

export interface GovernanceConfig {
	safetyMode: SafetyMode;
	permissions: Permissions;
	auditLogPath?: string;
}

const SAFE_PRESET: Permissions = {
	finalize: {
		invoices: false,
		quotations: false,
		creditNotes: false,
		orderConfirmations: false,
		deliveryNotes: false,
		dunnings: false,
	},
	delete: {
		invoiceDrafts: false,
		quotationDrafts: false,
		creditNoteDrafts: false,
		orderConfirmationDrafts: false,
		deliveryNoteDrafts: false,
		articles: false,
		contacts: false,
		vouchers: false,
		eventSubscriptions: true,
	},
	archive: {
		contacts: true,
		articles: true,
	},
};

const STANDARD_PRESET: Permissions = {
	finalize: {
		invoices: true,
		quotations: true,
		creditNotes: true,
		orderConfirmations: true,
		deliveryNotes: true,
		dunnings: true,
	},
	delete: {
		invoiceDrafts: false,
		quotationDrafts: false,
		creditNoteDrafts: false,
		orderConfirmationDrafts: false,
		deliveryNoteDrafts: false,
		articles: false,
		contacts: false,
		vouchers: false,
		eventSubscriptions: true,
	},
	archive: {
		contacts: true,
		articles: true,
	},
};

const UNRESTRICTED_PRESET: Permissions = {
	finalize: {
		invoices: true,
		quotations: true,
		creditNotes: true,
		orderConfirmations: true,
		deliveryNotes: true,
		dunnings: true,
	},
	delete: {
		// Draft-numbered documents always require explicit opt-in, even in unrestricted
		invoiceDrafts: false,
		quotationDrafts: false,
		creditNoteDrafts: false,
		orderConfirmationDrafts: false,
		deliveryNoteDrafts: false,
		articles: true,
		contacts: true,
		vouchers: true,
		eventSubscriptions: true,
	},
	archive: {
		contacts: true,
		articles: true,
	},
};

function parseBool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	return value.toLowerCase() === 'true' || value === '1';
}

function applyEnvOverrides(base: Permissions): Permissions {
	const p = structuredClone(base);

	// Finalize overrides
	if (process.env.LEXWARE_PERMISSIONS_FINALIZE_INVOICES !== undefined)
		p.finalize.invoices = parseBool(process.env.LEXWARE_PERMISSIONS_FINALIZE_INVOICES, p.finalize.invoices);
	if (process.env.LEXWARE_PERMISSIONS_FINALIZE_QUOTATIONS !== undefined)
		p.finalize.quotations = parseBool(process.env.LEXWARE_PERMISSIONS_FINALIZE_QUOTATIONS, p.finalize.quotations);
	if (process.env.LEXWARE_PERMISSIONS_FINALIZE_CREDIT_NOTES !== undefined)
		p.finalize.creditNotes = parseBool(process.env.LEXWARE_PERMISSIONS_FINALIZE_CREDIT_NOTES, p.finalize.creditNotes);
	if (process.env.LEXWARE_PERMISSIONS_FINALIZE_ORDER_CONFIRMATIONS !== undefined)
		p.finalize.orderConfirmations = parseBool(process.env.LEXWARE_PERMISSIONS_FINALIZE_ORDER_CONFIRMATIONS, p.finalize.orderConfirmations);
	if (process.env.LEXWARE_PERMISSIONS_FINALIZE_DELIVERY_NOTES !== undefined)
		p.finalize.deliveryNotes = parseBool(process.env.LEXWARE_PERMISSIONS_FINALIZE_DELIVERY_NOTES, p.finalize.deliveryNotes);
	if (process.env.LEXWARE_PERMISSIONS_FINALIZE_DUNNINGS !== undefined)
		p.finalize.dunnings = parseBool(process.env.LEXWARE_PERMISSIONS_FINALIZE_DUNNINGS, p.finalize.dunnings);

	// Delete overrides
	if (process.env.LEXWARE_PERMISSIONS_DELETE_INVOICE_DRAFTS !== undefined)
		p.delete.invoiceDrafts = parseBool(process.env.LEXWARE_PERMISSIONS_DELETE_INVOICE_DRAFTS, p.delete.invoiceDrafts);
	if (process.env.LEXWARE_PERMISSIONS_DELETE_QUOTATION_DRAFTS !== undefined)
		p.delete.quotationDrafts = parseBool(process.env.LEXWARE_PERMISSIONS_DELETE_QUOTATION_DRAFTS, p.delete.quotationDrafts);
	if (process.env.LEXWARE_PERMISSIONS_DELETE_CREDIT_NOTE_DRAFTS !== undefined)
		p.delete.creditNoteDrafts = parseBool(process.env.LEXWARE_PERMISSIONS_DELETE_CREDIT_NOTE_DRAFTS, p.delete.creditNoteDrafts);
	if (process.env.LEXWARE_PERMISSIONS_DELETE_ORDER_CONFIRMATION_DRAFTS !== undefined)
		p.delete.orderConfirmationDrafts = parseBool(process.env.LEXWARE_PERMISSIONS_DELETE_ORDER_CONFIRMATION_DRAFTS, p.delete.orderConfirmationDrafts);
	if (process.env.LEXWARE_PERMISSIONS_DELETE_DELIVERY_NOTE_DRAFTS !== undefined)
		p.delete.deliveryNoteDrafts = parseBool(process.env.LEXWARE_PERMISSIONS_DELETE_DELIVERY_NOTE_DRAFTS, p.delete.deliveryNoteDrafts);
	if (process.env.LEXWARE_PERMISSIONS_DELETE_ARTICLES !== undefined)
		p.delete.articles = parseBool(process.env.LEXWARE_PERMISSIONS_DELETE_ARTICLES, p.delete.articles);
	if (process.env.LEXWARE_PERMISSIONS_DELETE_CONTACTS !== undefined)
		p.delete.contacts = parseBool(process.env.LEXWARE_PERMISSIONS_DELETE_CONTACTS, p.delete.contacts);
	if (process.env.LEXWARE_PERMISSIONS_DELETE_VOUCHERS !== undefined)
		p.delete.vouchers = parseBool(process.env.LEXWARE_PERMISSIONS_DELETE_VOUCHERS, p.delete.vouchers);
	if (process.env.LEXWARE_PERMISSIONS_DELETE_EVENT_SUBSCRIPTIONS !== undefined)
		p.delete.eventSubscriptions = parseBool(process.env.LEXWARE_PERMISSIONS_DELETE_EVENT_SUBSCRIPTIONS, p.delete.eventSubscriptions);

	// Archive overrides
	if (process.env.LEXWARE_PERMISSIONS_ARCHIVE_CONTACTS !== undefined)
		p.archive.contacts = parseBool(process.env.LEXWARE_PERMISSIONS_ARCHIVE_CONTACTS, p.archive.contacts);
	if (process.env.LEXWARE_PERMISSIONS_ARCHIVE_ARTICLES !== undefined)
		p.archive.articles = parseBool(process.env.LEXWARE_PERMISSIONS_ARCHIVE_ARTICLES, p.archive.articles);

	return p;
}

function loadConfig(): GovernanceConfig {
	const rawMode = (process.env.LEXWARE_SAFETY_MODE ?? 'safe').toLowerCase() as SafetyMode;
	const safetyMode: SafetyMode = ['safe', 'standard', 'unrestricted', 'custom'].includes(rawMode)
		? rawMode
		: 'safe';

	let basePermissions: Permissions;
	switch (safetyMode) {
		case 'standard':
			basePermissions = structuredClone(STANDARD_PRESET);
			break;
		case 'unrestricted':
			basePermissions = structuredClone(UNRESTRICTED_PRESET);
			break;
		case 'safe':
		case 'custom':
		default:
			basePermissions = structuredClone(SAFE_PRESET);
	}

	const permissions = applyEnvOverrides(basePermissions);
	const auditLogPath = process.env.LEXWARE_AUDIT_LOG_PATH;

	return { safetyMode, permissions, auditLogPath };
}

export const governance = loadConfig();

export function finalizeHint(enabled: boolean): string {
	return enabled
		? 'Finalization is enabled in this environment.'
		: 'Finalization is DISABLED in this environment — documents must be finalized manually in the Lexware web interface.';
}

export function draftHint(): string {
	return 'Drafts cannot be deleted via this MCP to prevent gaps in sequential numbering. Use update-* tools to modify existing drafts.';
}
