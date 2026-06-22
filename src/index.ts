import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
	makeLexwareOfficeRequest,
	makeLexwareOfficeFileRequest,
	makeLexwareOfficeWriteRequest,
	makeLexwareOfficeMultipartRequest,
	WriteResult,
} from './helper.js';
import { logger } from './logger.js';
import { governance, finalizeHint, draftHint } from './governance.js';
import { auditAllow, auditStartup } from './audit.js';

// ─── Shared Schemas ───────────────────────────────────────────────────────────

function writeErrorResponse(result: { status: number; error: unknown } | null): string {
	if (!result) return 'Request failed due to a network or server error.';
	if (result.status === 0) return 'Request failed due to a network or server error.';
	if (result.status === 404) return 'Record not found.';
	if (result.status === 409) return 'Version conflict — please re-fetch the record and try again.';
	if (result.status === 401 || result.status === 403) return 'Authentication or permission error.';
	if (result.status === 429) return 'Rate limit exceeded — please wait a moment and try again.';
	return `API error (${result.status}): ${JSON.stringify(result.error, null, 2)}`;
}

const DATE_FORMAT_HINT =
	'ISO 8601 datetime with timezone offset. Use midnight for the time component and the current German timezone: "+01:00" (CET, Nov–Mar) or "+02:00" (CEST, Apr–Oct). Example for 22 March 2026: "2026-03-22T00:00:00.000+01:00"';

const SHIPPING_TYPE_HINT = `What appears on the PDF and when to use each type:

• "service" → "Leistungsdatum: 22.03.2026"
  Use for: a service performed on a single day (consulting session, repair, one-time work).
  Requires: shippingDate only.

• "serviceperiod" → "Leistungszeitraum: 01.03.2026–31.03.2026"
  Use for: a service performed over multiple days or a full month (monthly retainer, project phase, subscription period).
  Requires: shippingDate (start) AND shippingEndDate (end, inclusive).

• "delivery" → "Lieferdatum: 22.03.2026"
  Use for: physical goods delivered on a single day.
  Requires: shippingDate only.

• "deliveryperiod" → "Lieferzeitraum: 01.03.2026–31.03.2026"
  Use for: physical goods delivered in batches over a period.
  Requires: shippingDate (start) AND shippingEndDate (end, inclusive).

Rule of thumb: services → "service"/"serviceperiod"; physical goods → "delivery"/"deliveryperiod"; single date → no "period"; date range → "period" variant.`;

const lineItemSchema = z.discriminatedUnion('type', [
	z.object({
		type: z
			.enum(['material', 'service', 'custom'])
			.describe(
				'"material" = physical goods (Ware/Material), "service" = services/work (Dienstleistung), "custom" = any other chargeable item. Use "text" for descriptive lines without price.',
			),
		name: z
			.string()
			.describe(
				'Line item title — displayed in bold on the PDF. Keep to 1 line. For multi-line detail use the description field.',
			),
		description: z
			.string()
			.optional()
			.describe(
				'Optional body text displayed below the bold title on the PDF. Supports multiple lines — use \\n to insert a line break (e.g. "Feature A\\nFeature B\\nFeature C").',
			),
		quantity: z.number().describe('Quantity, e.g. 1 or 2.5'),
		unitName: z
			.string()
			.describe(
				'Unit label printed next to the quantity, e.g. "Stunden" (hours), "Stück" (pieces), "Pauschal" (flat), "Monat" (month)',
			),
		unitPrice: z.object({
			currency: z.literal('EUR'),
			netAmount: z
				.string()
				.describe(
					'Net price per unit as a DECIMAL STRING — must be a string, not a number. Examples: "9.99", "100.00", "1500.00". Do not omit decimal places.',
				),
			taxRatePercentage: z
				.number()
				.describe(
					'VAT rate as a percentage integer. German values: 19 (standard/Regelsteuersatz), 7 (reduced/ermäßigt), 0 (tax-free/steuerfrei). Use the value that matches the taxConditions.taxType of the document.',
				),
		}),
		discountPercentage: z
			.number()
			.min(0)
			.max(100)
			.optional()
			.describe('Line-item discount in percent (0–100), e.g. 10 for a 10% discount. Omit if no discount.'),
	}),
	z.object({
		type: z.literal('text').describe('A descriptive text line without price or quantity — use for section headings or notes within the line items.'),
		name: z.string().describe('The text to display. Use \\n for line breaks within the text block.'),
	}),
]);

const invoiceAddressSchema = z.union([
	z.object({
		contactId: z
			.string()
			.uuid()
			.describe(
				'ID of an existing Lexware contact. PREFERRED — use this whenever the customer or recipient exists as a contact. Lexware will pull the current address and name from the contact record.',
			),
	}),
	z.object({
		name: z
			.string()
			.describe('Full name or company name of the recipient. Only use this form for one-time recipients not in the contact database.'),
		street: z.string().optional().describe('Street name and house number, e.g. "Musterstraße 12"'),
		zip: z.string().optional().describe('Postal code, e.g. "10115"'),
		city: z.string().optional().describe('City name, e.g. "Berlin"'),
		countryCode: z
			.string()
			.length(2)
			.describe('ISO 3166-1 alpha-2 country code, e.g. "DE" for Germany, "AT" for Austria, "CH" for Switzerland'),
	}),
]);

const shippingConditionsSchema = z.object({
	shippingDate: z
		.string()
		.describe(`Date of service/delivery, or start of the period if using a period type. Format: ${DATE_FORMAT_HINT}`),
	shippingEndDate: z
		.string()
		.optional()
		.describe(
			'End date of the period — REQUIRED when shippingType is "serviceperiod" or "deliveryperiod". Must be on or after shippingDate. OMIT for single-date types ("service", "delivery"). Format: same as shippingDate.',
		),
	shippingType: z
		.enum(['service', 'delivery', 'serviceperiod', 'deliveryperiod'])
		.describe(SHIPPING_TYPE_HINT),
});

const paymentConditionsSchema = z
	.object({
		paymentTermLabel: z
			.string()
			.optional()
			.describe(
				'Label printed on the document. OPTIONAL — if omitted, Lexware auto-generates it from paymentTermDuration (recommended). Only set this to override with a custom text, e.g. "Zahlbar sofort ohne Abzug".',
			),
		paymentTermLabelLanguage: z
			.enum(['de', 'en'])
			.optional()
			.describe('Language for the auto-generated label. Defaults to "de".'),
		paymentTermDuration: z
			.number()
			.int()
			.describe('Payment due in this many days after the invoice date. E.g. 14 for "within 14 days", 0 for "due immediately".'),
		paymentDiscountConditions: z
			.object({
				discountPercentage: z
					.number()
					.describe('Early-payment discount in percent, e.g. 2 for 2% Skonto'),
				discountRange: z
					.number()
					.int()
					.describe('Number of days within which the discount applies, e.g. 7'),
			})
			.optional(),
	})
	.optional();

const invoiceSchema = {
	voucherDate: z.string().describe(`Document date. Format: ${DATE_FORMAT_HINT}`),
	address: invoiceAddressSchema,
	lineItems: z.array(lineItemSchema).min(1),
	taxConditions: z.object({
		taxType: z
			.enum(['net', 'gross', 'vatfree'])
			.describe(
				'"net" = Netto (net prices on document, VAT added on top — typical for B2B), "gross" = Brutto (gross prices incl. VAT — typical for B2C), "vatfree" = steuerfrei (no VAT, e.g. Kleinunternehmer §19 UStG)',
			),
	}),
	shippingConditions: shippingConditionsSchema.describe(
		'Service or delivery date — required by the Lexoffice API on all document types',
	),
	paymentConditions: paymentConditionsSchema,
	title: z
		.string()
		.optional()
		.describe(
			'Custom document title/subject line printed on the PDF, e.g. "Rechnung für Projekt Alpha" or "Abschlussrechnung Q1 2026". If omitted, Lexware uses the default title ("Rechnung", "Angebot", etc.).',
		),
	introduction: z
		.string()
		.optional()
		.describe('Text block printed before the line items (e.g. a greeting or project reference). Use \\n for line breaks.'),
	remark: z
		.string()
		.optional()
		.describe('Text block printed after the line items (e.g. bank details note, thank-you text). Use \\n for line breaks.'),
	printLayoutId: z
		.string()
		.uuid()
		.optional()
		.describe('UUID of the print layout to use. Retrieve available layouts with list-print-layouts. If omitted, the account default layout is used.'),
};

const updateDocSchema = {
	id: z.string().uuid().describe('ID of the draft to update'),
	version: z
		.number()
		.int()
		.describe('Current version for optimistic locking — get it from the details endpoint'),
	...invoiceSchema,
};

const articlePriceSchema = z.object({
	leadingPrice: z
		.enum(['NET', 'GROSS'])
		.describe('"NET" to specify net price, "GROSS" to specify gross price'),
	netPrice: z.number().optional().describe('Net price — required when leadingPrice is "NET"'),
	grossPrice: z
		.number()
		.optional()
		.describe('Gross price incl. tax — required when leadingPrice is "GROSS"'),
	taxRate: z.number().describe('Tax rate percentage, e.g. 19 for 19%, 7 for 7%, 0 for tax-free'),
});

const gtinSchema = z
	.string()
	.regex(/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/)
	.describe('GTIN/EAN/UPC barcode. Lexware accepts GTIN-8, GTIN-12 (UPC), GTIN-13 (EAN), or GTIN-14.');

// Fix #2: strip server-managed read-only fields before PUT
function stripReadOnlyFields(obj: Record<string, unknown>): Record<string, unknown> {
	const { id, resourceUri, createdDate, updatedDate, ...rest } = obj;
	void id; void resourceUri; void createdDate; void updatedDate;
	return rest;
}

// Fix #3: round monetary sums to avoid IEEE 754 drift
function roundMoney(n: number): number {
	return Math.round(n * 100) / 100;
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({
	name: 'lexware-office',
	version: '2.0.0',
});

// ─── Read Tools ───────────────────────────────────────────────────────────────

server.tool(
	'get-invoices',
	'Get a list of invoices from Lexware Office',
	{
		status: z
			.array(z.enum(['open', 'draft', 'paid', 'paidoff', 'voided']))
			.optional()
			.default(['open', 'draft', 'paid', 'paidoff', 'voided']),
		page: z.number().min(0).optional().default(0).describe('page number; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('results per page'),
	},
	async ({ status, page, size }) => {
		const result = await makeLexwareOfficeRequest<any>(
			`/v1/voucherlist?voucherType=invoice&voucherStatus=${status.join(',')}&page=${page}&size=${size}`,
		);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		const vouchers = result.data?.content;
		if (!vouchers || vouchers.length === 0) return { content: [{ type: 'text', text: 'No invoices found' }] };
		return {
			content: [{
				type: 'text',
				text: `There are ${result.data.totalElements} invoices in total (showing ${vouchers.length} on page ${page}):\n\n${JSON.stringify(vouchers, null, 2)}`,
			}],
		};
	},
);

server.tool(
	'get-invoice-details',
	'Get details of an invoice from Lexware Office. The response includes a "version" field needed for update-invoice.',
	{ id: z.string().uuid().describe('The id of the invoice') },
	async ({ id }) => {
		const result = await makeLexwareOfficeRequest<any>(`/v1/invoices/${id}`);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Invoice details:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'get-contacts',
	'Get contacts from Lexware Office with optional filters (combined with logical AND)',
	{
		email: z.string().min(3).optional().describe('Filter by email address (substring, % and _ wildcards allowed)'),
		name: z.string().min(3).optional().describe('Filter by name (substring, % and _ wildcards allowed)'),
		number: z.number().int().optional().describe('Filter by contact number (customer or vendor number)'),
		customer: z.boolean().optional().describe('true = only customers, false = exclude customers'),
		vendor: z.boolean().optional().describe('true = only vendors, false = exclude vendors'),
		archived: z
			.enum(['active', 'archived', 'all'])
			.optional()
			.default('active')
			.describe('"active" = non-archived (default), "archived" = archived only, "all" = both'),
		page: z.number().min(0).optional().default(0).describe('page number; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('results per page'),
	},
	async ({ email, name, number, customer, vendor, archived, page, size }) => {
		const params = new URLSearchParams({ page: String(page), size: String(size) });
		if (email) params.append('email', email);
		if (name) params.append('name', name);
		if (number !== undefined) params.append('number', number.toString());
		if (customer !== undefined) params.append('customer', customer.toString());
		if (vendor !== undefined) params.append('vendor', vendor.toString());
		if (archived === 'active') params.append('archived', 'false');
		else if (archived === 'archived') params.append('archived', 'true');
		const result = await makeLexwareOfficeRequest<any>(`/v1/contacts?${params.toString()}`);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Contacts:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'get-contact-details',
	'Get details of a single contact from Lexware Office by its ID. The response includes a "version" field needed for update-contact.',
	{ id: z.string().uuid().describe('The ID of the contact') },
	async ({ id }) => {
		const result = await makeLexwareOfficeRequest<any>(`/v1/contacts/${id}`);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Contact details:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'list-posting-categories',
	'Retrieve list of posting categories for bookkeeping vouchers',
	{ type: z.enum(['income', 'outgo']).optional().describe('Filter posting categories by type') },
	async ({ type }) => {
		const result = await makeLexwareOfficeRequest<any>('/v1/posting-categories');
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		const filtered = type ? result.data.filter((c: any) => c.type === type) : result.data;
		return { content: [{ type: 'text', text: `Posting Categories:\n\n${JSON.stringify(filtered, null, 2)}` }] };
	},
);

server.tool(
	'list-countries',
	'Retrieve list of countries with their tax classifications: "de" (Germany), "intraCommunity" (EU, Innergemeinschaftliche Lieferung), "thirdPartyCountry" (non-EU)',
	{
		taxClassification: z
			.enum(['de', 'intraCommunity', 'thirdPartyCountry'])
			.optional()
			.describe('Filter by tax classification'),
	},
	async ({ taxClassification }) => {
		const result = await makeLexwareOfficeRequest<any>('/v1/countries');
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		const filtered = taxClassification
			? result.data.filter((c: any) => c.taxClassification === taxClassification)
			: result.data;
		return { content: [{ type: 'text', text: `Countries:\n\n${JSON.stringify(filtered, null, 2)}` }] };
	},
);

server.tool(
	'get-vouchers',
	'Get a list of bookkeeping vouchers (Eingangsbelege/Ausgangsbelege). Types: purchaseinvoice (Ausgaben), purchasecreditnote, salesinvoice (Einnahmen), salescreditnote.',
	{
		voucherType: z
			.array(z.enum(['purchaseinvoice', 'purchasecreditnote', 'salesinvoice', 'salescreditnote']))
			.optional()
			.default(['purchaseinvoice', 'purchasecreditnote', 'salesinvoice', 'salescreditnote']),
		voucherStatus: z
			.array(z.enum(['unchecked', 'open', 'paid', 'paidoff', 'voided', 'transferred', 'sepadebit']))
			.optional()
			.default(['unchecked', 'open', 'paid', 'paidoff', 'voided', 'transferred', 'sepadebit']),
		page: z.number().min(0).optional().default(0).describe('page number; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('results per page'),
	},
	async ({ voucherType, voucherStatus, page, size }) => {
		const result = await makeLexwareOfficeRequest<any>(
			`/v1/voucherlist?voucherType=${voucherType.join(',')}&voucherStatus=${voucherStatus.join(',')}&page=${page}&size=${size}`,
		);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		const vouchers = result.data?.content;
		if (!vouchers || vouchers.length === 0) return { content: [{ type: 'text', text: 'No vouchers found' }] };
		return {
			content: [{
				type: 'text',
				text: `There are ${result.data.totalElements} vouchers in total (showing ${vouchers.length} on page ${page}):\n\n${JSON.stringify(vouchers, null, 2)}`,
			}],
		};
	},
);

server.tool(
	'get-voucher-details',
	'Get details of a bookkeeping voucher by its ID. The response includes a "version" field needed for update-voucher.',
	{ id: z.string().uuid().describe('The id of the voucher') },
	async ({ id }) => {
		const result = await makeLexwareOfficeRequest<any>(`/v1/vouchers/${id}`);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Voucher details:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'get-file',
	'Download a file (PDF or XML) from Lexware Office by its file ID. File IDs are in the "files.documentFileId" field of voucher or invoice details.',
	{
		id: z.string().uuid().describe('The file ID from files.documentFileId'),
		format: z.enum(['pdf', 'xml']).optional().default('pdf').describe('"pdf" (default) or "xml" (XRechnung)'),
	},
	async ({ id, format }) => {
		const accept = format === 'xml' ? 'application/xml' : 'application/pdf';
		const fileData = await makeLexwareOfficeFileRequest(`/v1/files/${id}`, accept);
		if (!fileData) return { content: [{ type: 'text', text: 'Failed to retrieve file' }] };
		return {
			content: [{
				type: 'resource',
				resource: { uri: `lexware://files/${id}`, mimeType: fileData.mimeType, blob: fileData.data.toString('base64') },
			}],
		};
	},
);

server.tool(
	'get-document-file',
	'Download the PDF of a document (invoice, quotation, credit note, order confirmation, delivery note, dunning, down-payment invoice) by its document ID.',
	{
		docType: z
			.enum(['invoices', 'credit-notes', 'quotations', 'order-confirmations', 'delivery-notes', 'dunnings', 'down-payment-invoices'])
			.describe('The type of document'),
		id: z.string().uuid().describe('The ID of the document'),
	},
	async ({ docType, id }) => {
		const fileData = await makeLexwareOfficeFileRequest(`/v1/${docType}/${id}/file`, 'application/pdf');
		if (!fileData) {
			return { content: [{ type: 'text', text: 'Failed to retrieve document file. Ensure the document is finalized.' }] };
		}
		return {
			content: [{
				type: 'resource',
				resource: { uri: `lexware://${docType}/${id}/file`, mimeType: fileData.mimeType, blob: fileData.data.toString('base64') },
			}],
		};
	},
);

// Fix #5: use makeLexwareOfficeRequest instead of inline fetch
server.tool(
	'get-payments',
	'Get payment information for an invoice or voucher from Lexware Office.',
	{ id: z.string().uuid().describe('The ID of the invoice or voucher') },
	async ({ id }) => {
		const result = await makeLexwareOfficeRequest<any>(`/v1/payments/${id}`);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Payment information:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'get-payment-conditions',
	'Retrieve available payment conditions (Zahlungsbedingungen) from Lexware Office.',
	{},
	async () => {
		const result = await makeLexwareOfficeRequest<any>('/v1/payment-conditions');
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Payment conditions:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'get-profile',
	'Get the company profile (Unternehmensprofil) from Lexware Office.',
	{},
	async () => {
		const result = await makeLexwareOfficeRequest<any>('/v1/profile');
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Company profile:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'list-print-layouts',
	'Retrieve available print layouts (Drucklayouts) from Lexware Office.',
	{},
	async () => {
		const result = await makeLexwareOfficeRequest<any>('/v1/print-layouts');
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Print layouts:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'get-recurring-templates',
	'Get a list of recurring invoice templates (Wiederkehrende Vorlagen) from Lexware Office.',
	{
		page: z.number().min(0).optional().default(0).describe('page number; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('results per page'),
	},
	async ({ page, size }) => {
		const result = await makeLexwareOfficeRequest<any>(`/v1/recurring-templates?page=${page}&size=${size}`);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Recurring templates:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'get-articles',
	'Get a list of articles (Artikel/Produkte) from Lexware Office with optional filters.',
	{
		articleNumber: z.string().optional().describe('Filter by article number'),
		name: z.string().optional().describe('Filter by article name (substring)'),
		gtin: gtinSchema.optional().describe('Filter by GTIN/EAN/UPC barcode'),
		type: z.enum(['PRODUCT', 'SERVICE']).optional().describe('Filter by article type'),
		archived: z
			.enum(['active', 'archived', 'all'])
			.optional()
			.default('active')
			.describe('"active" = non-archived (default), "archived" = archived only, "all" = both'),
		page: z.number().min(0).optional().default(0).describe('page number; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('results per page'),
	},
	async ({ articleNumber, name, gtin, type, archived, page, size }) => {
		const params = new URLSearchParams({ page: String(page), size: String(size) });
		if (articleNumber) params.append('articleNumber', articleNumber);
		if (name) params.append('name', name);
		if (gtin) params.append('gtin', gtin);
		if (type) params.append('type', type);
		if (archived === 'active') params.append('archived', 'false');
		else if (archived === 'archived') params.append('archived', 'true');
		const result = await makeLexwareOfficeRequest<any>(`/v1/articles?${params.toString()}`);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Articles:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'get-article-details',
	'Get details of an article (Artikel/Produkt) by its ID. The response includes a "version" field needed for update-article.',
	{ id: z.string().uuid().describe('The ID of the article') },
	async ({ id }) => {
		const result = await makeLexwareOfficeRequest<any>(`/v1/articles/${id}`);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Article details:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'get-quotations',
	'Get a list of quotations (Angebote) from Lexware Office.',
	{
		status: z
			.array(z.enum(['draft', 'open', 'accepted', 'rejected', 'voided']))
			.optional()
			.default(['draft', 'open', 'accepted', 'rejected', 'voided']),
		page: z.number().min(0).optional().default(0).describe('page number; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('results per page'),
	},
	async ({ status, page, size }) => {
		const result = await makeLexwareOfficeRequest<any>(
			`/v1/voucherlist?voucherType=quotation&voucherStatus=${status.join(',')}&page=${page}&size=${size}`,
		);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		const vouchers = result.data?.content;
		if (!vouchers || vouchers.length === 0) return { content: [{ type: 'text', text: 'No quotations found' }] };
		return {
			content: [{
				type: 'text',
				text: `There are ${result.data.totalElements} quotations in total (showing ${vouchers.length} on page ${page}):\n\n${JSON.stringify(vouchers, null, 2)}`,
			}],
		};
	},
);

server.tool(
	'get-quotation-details',
	'Get details of a quotation (Angebot) by its ID. The response includes a "version" field needed for update-quotation.',
	{ id: z.string().uuid().describe('The ID of the quotation') },
	async ({ id }) => {
		const result = await makeLexwareOfficeRequest<any>(`/v1/quotations/${id}`);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Quotation details:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'get-credit-notes',
	'Get a list of credit notes (Gutschriften) from Lexware Office.',
	{
		status: z
			.array(z.enum(['draft', 'open', 'paid', 'voided']))
			.optional()
			.default(['draft', 'open', 'paid', 'voided']),
		page: z.number().min(0).optional().default(0).describe('page number; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('results per page'),
	},
	async ({ status, page, size }) => {
		const result = await makeLexwareOfficeRequest<any>(
			`/v1/voucherlist?voucherType=creditnote&voucherStatus=${status.join(',')}&page=${page}&size=${size}`,
		);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		const vouchers = result.data?.content;
		if (!vouchers || vouchers.length === 0) return { content: [{ type: 'text', text: 'No credit notes found' }] };
		return {
			content: [{
				type: 'text',
				text: `There are ${result.data.totalElements} credit notes in total (showing ${vouchers.length} on page ${page}):\n\n${JSON.stringify(vouchers, null, 2)}`,
			}],
		};
	},
);

server.tool(
	'get-credit-note-details',
	'Get details of a credit note (Gutschrift) by its ID. The response includes a "version" field needed for update-credit-note.',
	{ id: z.string().uuid().describe('The ID of the credit note') },
	async ({ id }) => {
		const result = await makeLexwareOfficeRequest<any>(`/v1/credit-notes/${id}`);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Credit note details:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'get-order-confirmations',
	'Get a list of order confirmations (Auftragsbestätigungen) from Lexware Office.',
	{
		status: z
			.array(z.enum(['draft', 'open', 'fulfilled', 'voided']))
			.optional()
			.default(['draft', 'open', 'fulfilled', 'voided']),
		page: z.number().min(0).optional().default(0).describe('page number; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('results per page'),
	},
	async ({ status, page, size }) => {
		const result = await makeLexwareOfficeRequest<any>(
			`/v1/voucherlist?voucherType=orderconfirmation&voucherStatus=${status.join(',')}&page=${page}&size=${size}`,
		);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		const vouchers = result.data?.content;
		if (!vouchers || vouchers.length === 0) return { content: [{ type: 'text', text: 'No order confirmations found' }] };
		return {
			content: [{
				type: 'text',
				text: `There are ${result.data.totalElements} order confirmations in total (showing ${vouchers.length} on page ${page}):\n\n${JSON.stringify(vouchers, null, 2)}`,
			}],
		};
	},
);

server.tool(
	'get-order-confirmation-details',
	'Get details of an order confirmation (Auftragsbestätigung) by its ID. The response includes a "version" field needed for update-order-confirmation.',
	{ id: z.string().uuid().describe('The ID of the order confirmation') },
	async ({ id }) => {
		const result = await makeLexwareOfficeRequest<any>(`/v1/order-confirmations/${id}`);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Order confirmation details:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'get-delivery-notes',
	'Get a list of delivery notes (Lieferscheine) from Lexware Office.',
	{
		status: z
			.array(z.enum(['draft', 'open', 'fulfilled', 'voided']))
			.optional()
			.default(['draft', 'open', 'fulfilled', 'voided']),
		page: z.number().min(0).optional().default(0).describe('page number; starts at 0'),
		size: z.number().min(1).max(250).optional().default(250).describe('results per page'),
	},
	async ({ status, page, size }) => {
		const result = await makeLexwareOfficeRequest<any>(
			`/v1/voucherlist?voucherType=deliverynote&voucherStatus=${status.join(',')}&page=${page}&size=${size}`,
		);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		const vouchers = result.data?.content;
		if (!vouchers || vouchers.length === 0) return { content: [{ type: 'text', text: 'No delivery notes found' }] };
		return {
			content: [{
				type: 'text',
				text: `There are ${result.data.totalElements} delivery notes in total (showing ${vouchers.length} on page ${page}):\n\n${JSON.stringify(vouchers, null, 2)}`,
			}],
		};
	},
);

server.tool(
	'get-delivery-note-details',
	'Get details of a delivery note (Lieferschein) by its ID. The response includes a "version" field needed for update-delivery-note.',
	{ id: z.string().uuid().describe('The ID of the delivery note') },
	async ({ id }) => {
		const result = await makeLexwareOfficeRequest<any>(`/v1/delivery-notes/${id}`);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Delivery note details:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'get-down-payment-invoice-details',
	'Get details of a down payment invoice (Anzahlungsrechnung) by its ID.',
	{ id: z.string().uuid().describe('The ID of the down payment invoice') },
	async ({ id }) => {
		const result = await makeLexwareOfficeRequest<any>(`/v1/down-payment-invoices/${id}`);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Down payment invoice details:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'get-dunnings',
	'Helper: Lexware Office does not support listing dunnings. Use get-dunning-details with a known ID instead. Dunning IDs are in the relatedVouchers field of the associated invoice.',
	{},
	async () => ({
		content: [{
			type: 'text',
			text: 'The Lexware Office API does not support listing dunnings. Use get-dunning-details with a known dunning ID. Find dunning IDs in the relatedVouchers field of the associated invoice (use get-invoice-details).',
		}],
	}),
);

server.tool(
	'get-dunning-details',
	'Get details of a dunning notice (Mahnung) by its ID.',
	{ id: z.string().uuid().describe('The ID of the dunning') },
	async ({ id }) => {
		const result = await makeLexwareOfficeRequest<any>(`/v1/dunnings/${id}`);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Dunning details:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'list-event-subscriptions',
	'Retrieve all webhook event subscriptions from Lexware Office.',
	{},
	async () => {
		const result = await makeLexwareOfficeRequest<any>('/v1/event-subscriptions');
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Event subscriptions:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'get-event-subscription',
	'Retrieve a specific webhook event subscription by its ID.',
	{ id: z.string().uuid().describe('The ID of the event subscription') },
	async ({ id }) => {
		const result = await makeLexwareOfficeRequest<any>(`/v1/event-subscriptions/${id}`);
		if (!result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result) }] };
		return { content: [{ type: 'text', text: `Event subscription:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

// ─── Write / Create / Update Tools ───────────────────────────────────────────

// Fix #1: preserve undefined through transform so the roles guard works correctly
const boolFlag = z
	.string()
	.optional()
	.transform((v) => (v === undefined ? undefined : v === 'true'));

server.tool(
	'create-contact',
	'Create a new contact in Lexware Office. Provide companyName for a company, or firstName/lastName for a person.',
	{
		customer: boolFlag.describe('Set to "true" to assign the customer role'),
		vendor: boolFlag.describe('Set to "true" to assign the vendor role'),
		companyName: z.string().optional().describe('Company name — provide either companyName or lastName, not both'),
		taxNumber: z.string().optional().describe('Tax number of the company'),
		vatRegistrationId: z.string().optional().describe('VAT registration ID of the company'),
		firstName: z.string().optional(),
		lastName: z.string().optional().describe('Required if companyName is not provided'),
		salutation: z.string().optional(),
		note: z.string().optional(),
	},
	async ({ customer, vendor, companyName, taxNumber, vatRegistrationId, firstName, lastName, salutation, note }) => {
		if (!customer && !vendor) {
			return { content: [{ type: 'text', text: 'Error: at least one role is required. Set customer: "true" and/or vendor: "true".' }] };
		}
		const result = await makeLexwareOfficeWriteRequest<any>('/v1/contacts', 'POST', {
			version: 0,
			roles: {
				...(customer === true ? { customer: {} } : {}),
				...(vendor === true ? { vendor: {} } : {}),
			},
			...(companyName ? { company: { name: companyName, ...(taxNumber ? { taxNumber } : {}), ...(vatRegistrationId ? { vatRegistrationId } : {}) } } : {}),
			...(lastName || firstName ? { person: { ...(salutation ? { salutation } : {}), ...(firstName ? { firstName } : {}), ...(lastName ? { lastName } : {}) } } : {}),
			...(note ? { note } : {}),
		});
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('create-contact', { id: (result.data as any)?.id ?? 'unknown' });
		return { content: [{ type: 'text', text: `Contact created successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'update-contact',
	'Update an existing contact in Lexware Office. Requires the current version number for optimistic locking (get it from get-contact-details).',
	{
		id: z.string().uuid().describe('The ID of the contact to update'),
		version: z.number().int().describe('Current version (for optimistic locking)'),
		customer: boolFlag.describe('Set to "true" to assign the customer role'),
		vendor: boolFlag.describe('Set to "true" to assign the vendor role'),
		companyName: z.string().optional(),
		taxNumber: z.string().optional(),
		vatRegistrationId: z.string().optional(),
		firstName: z.string().optional(),
		lastName: z.string().optional(),
		salutation: z.string().optional(),
		note: z.string().optional(),
	},
	async ({ id, version, customer, vendor, companyName, taxNumber, vatRegistrationId, firstName, lastName, salutation, note }) => {
		if (!customer && !vendor) {
			return { content: [{ type: 'text', text: 'Error: Lexoffice requires at least one role. Set customer or vendor to "true".' }] };
		}
		const result = await makeLexwareOfficeWriteRequest<any>(`/v1/contacts/${id}`, 'PUT', {
			version,
			roles: {
				...(customer === true ? { customer: {} } : {}),
				...(vendor === true ? { vendor: {} } : {}),
			},
			...(companyName ? { company: { name: companyName, ...(taxNumber ? { taxNumber } : {}), ...(vatRegistrationId ? { vatRegistrationId } : {}) } } : {}),
			...(lastName || firstName ? { person: { ...(salutation ? { salutation } : {}), ...(firstName ? { firstName } : {}), ...(lastName ? { lastName } : {}) } } : {}),
			...(note ? { note } : {}),
		});
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('update-contact', { id });
		return { content: [{ type: 'text', text: `Contact updated successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'create-article',
	'Create a new article (Artikel/Produkt) in Lexware Office.',
	{
		type: z.enum(['PRODUCT', 'SERVICE']).describe('PRODUCT (Ware) or SERVICE (Dienstleistung)'),
		title: z.string().describe('Article name/title'),
		description: z.string().optional().describe('Article description'),
		articleNumber: z.string().optional().describe('Article number (Artikelnummer)'),
		gtin: gtinSchema.optional(),
		unitName: z.string().optional().describe('Unit name, e.g. "Stunden", "Stück"'),
		price: articlePriceSchema.optional().describe('Selling price'),
	},
	async ({ type, title, description, articleNumber, gtin, unitName, price }) => {
		const body: Record<string, unknown> = { type, title };
		if (description) body.description = description;
		if (articleNumber) body.articleNumber = articleNumber;
		if (gtin) body.gtin = gtin;
		if (unitName) body.unitName = unitName;
		if (price) body.price = price;
		const result = await makeLexwareOfficeWriteRequest<any>('/v1/articles', 'POST', body);
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('create-article', { id: (result.data as any)?.id ?? 'unknown' });
		return { content: [{ type: 'text', text: `Article created successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'update-article',
	'Update an existing article in Lexware Office. Requires the current version number for optimistic locking (get it from get-article-details).',
	{
		id: z.string().uuid().describe('The ID of the article to update'),
		version: z.number().int().describe('Current version (for optimistic locking)'),
		type: z.enum(['PRODUCT', 'SERVICE']),
		title: z.string().describe('Article name/title'),
		description: z.string().optional(),
		articleNumber: z.string().optional(),
		gtin: gtinSchema.optional(),
		unitName: z.string().optional(),
		price: articlePriceSchema.optional(),
	},
	async ({ id, version, type, title, description, articleNumber, gtin, unitName, price }) => {
		const body: Record<string, unknown> = { version, type, title };
		if (description) body.description = description;
		if (articleNumber) body.articleNumber = articleNumber;
		if (gtin) body.gtin = gtin;
		if (unitName) body.unitName = unitName;
		if (price) body.price = price;
		const result = await makeLexwareOfficeWriteRequest<any>(`/v1/articles/${id}`, 'PUT', body);
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('update-article', { id });
		return { content: [{ type: 'text', text: `Article updated successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'create-voucher',
	'Create a new bookkeeping voucher (Buchungsbeleg) in Lexware Office. Use list-posting-categories to find valid categoryId values.',
	{
		type: z.enum(['purchaseinvoice', 'purchasecreditnote', 'salesinvoice', 'salescreditnote'])
			.describe('purchaseinvoice (Eingangsrechnung), purchasecreditnote, salesinvoice, salescreditnote'),
		voucherDate: z.string().describe(`Invoice date. Format: ${DATE_FORMAT_HINT}`),
		voucherNumber: z.string().optional().describe("Supplier's invoice number as printed on the document"),
		dueDate: z.string().optional().describe(`Payment due date. Format: ${DATE_FORMAT_HINT}`),
		contactId: z.string().uuid().optional(),
		remark: z.string().optional().describe('Internal note'),
		taxType: z.enum(['net', 'gross', 'vatfree']),
		voucherItems: z.array(z.object({
			amount: z.number().describe('Gross amount, e.g. 119.00'),
			taxAmount: z.number().describe('Tax amount, e.g. 19.00'),
			taxRatePercent: z.number().describe('Tax rate: 0, 7, or 19'),
			categoryId: z.string().uuid().describe('Posting category ID from list-posting-categories'),
		})).min(1),
	},
	async (params) => {
		// Fix #3: round to avoid IEEE 754 drift in monetary sums
		const totalGrossAmount = roundMoney(params.voucherItems.reduce((s, i) => s + i.amount, 0));
		const totalTaxAmount = roundMoney(params.voucherItems.reduce((s, i) => s + i.taxAmount, 0));
		const result = await makeLexwareOfficeWriteRequest<any>('/v1/vouchers', 'POST', { ...params, totalGrossAmount, totalTaxAmount });
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('create-voucher', { id: (result.data as any)?.id ?? 'unknown' });
		return { content: [{ type: 'text', text: `Voucher created successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'update-voucher',
	'Update an existing bookkeeping voucher. Requires the current version number for optimistic locking (from get-voucher-details).',
	{
		id: z.string().uuid().describe('The ID of the voucher to update'),
		version: z.number().int().describe('Current version (for optimistic locking)'),
		type: z.enum(['purchaseinvoice', 'purchasecreditnote', 'salesinvoice', 'salescreditnote']),
		voucherDate: z.string().describe(`Voucher date. Format: ${DATE_FORMAT_HINT}`),
		voucherNumber: z.string().optional().describe("Supplier's invoice number"),
		dueDate: z.string().optional().describe(`Due date. Format: ${DATE_FORMAT_HINT}`),
		contactId: z.string().uuid().optional(),
		remark: z.string().optional(),
		taxType: z.enum(['net', 'gross', 'vatfree']),
		voucherItems: z.array(z.object({
			amount: z.number(),
			taxAmount: z.number(),
			taxRatePercent: z.number(),
			categoryId: z.string().uuid(),
		})).min(1),
	},
	async ({ id, ...body }) => {
		const totalGrossAmount = roundMoney(body.voucherItems.reduce((s, i) => s + i.amount, 0));
		const totalTaxAmount = roundMoney(body.voucherItems.reduce((s, i) => s + i.taxAmount, 0));
		const result = await makeLexwareOfficeWriteRequest<any>(`/v1/vouchers/${id}`, 'PUT', { ...body, totalGrossAmount, totalTaxAmount });
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('update-voucher', { id });
		return { content: [{ type: 'text', text: `Voucher updated successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'create-event-subscription',
	'Create a webhook event subscription in Lexware Office.',
	{
		eventType: z.enum([
			'article.created', 'article.changed', 'article.deleted',
			'contact.created', 'contact.changed', 'contact.deleted',
			'credit-note.created', 'credit-note.changed', 'credit-note.deleted', 'credit-note.status.changed',
			'delivery-note.created', 'delivery-note.changed', 'delivery-note.deleted', 'delivery-note.status.changed',
			'down-payment-invoice.created', 'down-payment-invoice.changed', 'down-payment-invoice.deleted', 'down-payment-invoice.status.changed',
			'dunning.created', 'dunning.changed', 'dunning.deleted',
			'invoice.created', 'invoice.changed', 'invoice.deleted', 'invoice.status.changed',
			'order-confirmation.created', 'order-confirmation.changed', 'order-confirmation.deleted', 'order-confirmation.status.changed',
			'payment.changed',
			'quotation.created', 'quotation.changed', 'quotation.deleted', 'quotation.status.changed',
			'recurring-template.created', 'recurring-template.changed', 'recurring-template.deleted',
			'voucher.created', 'voucher.changed', 'voucher.deleted', 'voucher.status.changed',
		]).describe('The event type to subscribe to'),
		callbackUrl: z.string().url().describe('Webhook URL that will receive event notifications'),
	},
	async ({ eventType, callbackUrl }) => {
		const result = await makeLexwareOfficeWriteRequest<any>('/v1/event-subscriptions', 'POST', { eventType, callbackUrl });
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		return { content: [{ type: 'text', text: `Event subscription created successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'upload-file',
	'Upload a file (PDF, JPG, PNG, or XML) to Lexware Office for bookkeeping. Returns a file ID. Max 5 MB.',
	{
		fileContentBase64: z.string().describe('Base64-encoded file content'),
		fileName: z.string().describe('File name including extension, e.g. "rechnung.pdf"'),
		mimeType: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'application/xml']).describe('MIME type of the file'),
	},
	async ({ fileContentBase64, fileName, mimeType }) => {
		const blob = new Blob([Buffer.from(fileContentBase64, 'base64')], { type: mimeType });
		const formData = new FormData();
		formData.append('file', blob, fileName);
		formData.append('type', 'voucher');
		const result = await makeLexwareOfficeMultipartRequest<any>('/v1/files', formData);
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		return { content: [{ type: 'text', text: `File uploaded successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'upload-file-to-voucher',
	'Upload and assign a file directly to an existing voucher (Beleg) in Lexware Office.',
	{
		voucherId: z.string().uuid().describe('The ID of the voucher to attach the file to'),
		fileContentBase64: z.string().describe('Base64-encoded file content'),
		fileName: z.string().describe('File name including extension'),
		mimeType: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'application/xml']).describe('MIME type of the file'),
	},
	async ({ voucherId, fileContentBase64, fileName, mimeType }) => {
		const blob = new Blob([Buffer.from(fileContentBase64, 'base64')], { type: mimeType });
		const formData = new FormData();
		formData.append('file', blob, fileName);
		const result = await makeLexwareOfficeMultipartRequest<any>(`/v1/vouchers/${voucherId}/files`, formData);
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		return { content: [{ type: 'text', text: `File uploaded to voucher ${voucherId} successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

// ─── Invoice: Create + Update ─────────────────────────────────────────────────

server.tool(
	'create-invoice',
	`Creates a draft invoice in Lexware Office. ${finalizeHint(governance.permissions.finalize.invoices)} ${draftHint()}`,
	invoiceSchema,
	async (params) => {
		const result = await makeLexwareOfficeWriteRequest<any>('/v1/invoices', 'POST', { ...params, totalPrice: { currency: 'EUR' } });
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('create-invoice', { id: (result.data as any)?.id ?? 'unknown' });
		return { content: [{ type: 'text', text: `Invoice created as draft successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'update-invoice',
	`Update a draft invoice in Lexware Office. Use this instead of creating a new draft — creating a new draft would leave gaps in sequential numbering. Only works on drafts (voucherStatus: "draft"). Requires the current version from get-invoice-details.`,
	updateDocSchema,
	async ({ id, version, ...rest }) => {
		const result = await makeLexwareOfficeWriteRequest<any>(`/v1/invoices/${id}`, 'PUT', { version, ...rest, totalPrice: { currency: 'EUR' } });
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('update-invoice', { id });
		return { content: [{ type: 'text', text: `Invoice draft updated successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

// ─── Quotation: Create + Update ───────────────────────────────────────────────

const quotationCreateSchema = {
	...invoiceSchema,
	expirationDate: z.string().optional().describe(`Date until which the quotation is valid. Format: ${DATE_FORMAT_HINT}`),
};

server.tool(
	'create-quotation',
	`Create a new quotation (Angebot) as a draft in Lexware Office. ${finalizeHint(governance.permissions.finalize.quotations)} ${draftHint()}`,
	quotationCreateSchema,
	async (params) => {
		const result = await makeLexwareOfficeWriteRequest<any>('/v1/quotations', 'POST', { ...params, totalPrice: { currency: 'EUR' } });
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('create-quotation', { id: (result.data as any)?.id ?? 'unknown' });
		return { content: [{ type: 'text', text: `Quotation created as draft successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'update-quotation',
	`Update a draft quotation (Angebot) in Lexware Office. Use this instead of creating a new draft to avoid gaps in sequential numbering. Only works on drafts. Requires current version from get-quotation-details.`,
	{ id: z.string().uuid().describe('ID of the draft to update'), version: z.number().int().describe('Current version for optimistic locking'), ...quotationCreateSchema },
	async ({ id, version, ...rest }) => {
		const result = await makeLexwareOfficeWriteRequest<any>(`/v1/quotations/${id}`, 'PUT', { version, ...rest, totalPrice: { currency: 'EUR' } });
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('update-quotation', { id });
		return { content: [{ type: 'text', text: `Quotation draft updated successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

// ─── Credit Note: Create + Update ─────────────────────────────────────────────

const creditNoteCreateSchema = {
	...invoiceSchema,
	precedingSalesVoucherId: z.string().uuid().optional().describe('ID of the original invoice this credit note refers to (optional)'),
};

server.tool(
	'create-credit-note',
	`Create a new credit note (Gutschrift) as a draft in Lexware Office. ${finalizeHint(governance.permissions.finalize.creditNotes)} ${draftHint()}`,
	creditNoteCreateSchema,
	async (params) => {
		const result = await makeLexwareOfficeWriteRequest<any>('/v1/credit-notes', 'POST', { ...params, totalPrice: { currency: 'EUR' } });
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('create-credit-note', { id: (result.data as any)?.id ?? 'unknown' });
		return { content: [{ type: 'text', text: `Credit note created as draft successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'update-credit-note',
	`Update a draft credit note (Gutschrift) in Lexware Office. Use this instead of creating a new draft to avoid gaps in sequential numbering. Only works on drafts. Requires current version from get-credit-note-details.`,
	{ id: z.string().uuid().describe('ID of the draft to update'), version: z.number().int().describe('Current version for optimistic locking'), ...creditNoteCreateSchema },
	async ({ id, version, ...rest }) => {
		const result = await makeLexwareOfficeWriteRequest<any>(`/v1/credit-notes/${id}`, 'PUT', { version, ...rest, totalPrice: { currency: 'EUR' } });
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('update-credit-note', { id });
		return { content: [{ type: 'text', text: `Credit note draft updated successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

// ─── Order Confirmation: Create + Update ──────────────────────────────────────

server.tool(
	'create-order-confirmation',
	`Create a new order confirmation (Auftragsbestätigung) as a draft in Lexware Office. ${finalizeHint(governance.permissions.finalize.orderConfirmations)} ${draftHint()}`,
	invoiceSchema,
	async (params) => {
		const result = await makeLexwareOfficeWriteRequest<any>('/v1/order-confirmations', 'POST', { ...params, totalPrice: { currency: 'EUR' } });
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('create-order-confirmation', { id: (result.data as any)?.id ?? 'unknown' });
		return { content: [{ type: 'text', text: `Order confirmation created as draft successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'update-order-confirmation',
	`Update a draft order confirmation (Auftragsbestätigung) in Lexware Office. Use this instead of creating a new draft to avoid gaps in sequential numbering. Only works on drafts. Requires current version from get-order-confirmation-details.`,
	updateDocSchema,
	async ({ id, version, ...rest }) => {
		const result = await makeLexwareOfficeWriteRequest<any>(`/v1/order-confirmations/${id}`, 'PUT', { version, ...rest, totalPrice: { currency: 'EUR' } });
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('update-order-confirmation', { id });
		return { content: [{ type: 'text', text: `Order confirmation draft updated successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

// ─── Delivery Note: Create + Update ──────────────────────────────────────────

const deliveryNoteLineItemSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.enum(['material', 'service', 'custom']).describe('"material" = physical goods, "service" = services, "custom" = other items. Use "text" for header/note lines.'),
		name: z.string().describe('Line item title — displayed in bold. Keep to 1 line.'),
		description: z.string().optional().describe('Optional body text displayed below the bold title. Use \\n for line breaks.'),
		quantity: z.number().describe('Quantity, e.g. 1 or 2.5'),
		unitName: z.string().describe('Unit label, e.g. "Stück", "kg", "Karton"'),
	}),
	z.object({
		type: z.literal('text'),
		name: z.string().describe('Descriptive text line without quantity or price. Use \\n for line breaks.'),
	}),
]);

const deliveryNoteBaseSchema = {
	voucherDate: z.string().describe(`Delivery note date. Format: ${DATE_FORMAT_HINT}`),
	address: invoiceAddressSchema,
	lineItems: z.array(deliveryNoteLineItemSchema).min(1),
	taxConditions: z.object({
		taxType: z.enum(['net', 'gross', 'vatfree']).describe('"net" = Netto (B2B), "gross" = Brutto (B2C), "vatfree" = steuerfrei'),
	}).describe('Required by Lexoffice API even for delivery notes'),
	shippingConditions: z.object({
		shippingDate: z.string().describe(`Delivery date or period start. Format: ${DATE_FORMAT_HINT}`),
		shippingEndDate: z.string().optional().describe('REQUIRED for "deliveryperiod". OMIT for "delivery". Format: same as shippingDate.'),
		shippingType: z.enum(['service', 'delivery', 'serviceperiod', 'deliveryperiod']).describe(SHIPPING_TYPE_HINT),
	}).describe('Required by Lexoffice API'),
	title: z.string().optional().describe('Custom document title printed on the PDF, e.g. "Lieferschein Auftrag #42". Overrides the default title.'),
	introduction: z.string().optional().describe('Text printed before line items. Use \\n for line breaks.'),
	remark: z.string().optional().describe('Text printed after line items. Use \\n for line breaks.'),
	printLayoutId: z.string().uuid().optional().describe('UUID of the print layout. Retrieve available layouts with list-print-layouts.'),
};

server.tool(
	'create-delivery-note',
	`Create a new delivery note (Lieferschein) as a draft in Lexware Office. ${finalizeHint(governance.permissions.finalize.deliveryNotes)} ${draftHint()}`,
	deliveryNoteBaseSchema,
	async (params) => {
		const result = await makeLexwareOfficeWriteRequest<any>('/v1/delivery-notes', 'POST', params);
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('create-delivery-note', { id: (result.data as any)?.id ?? 'unknown' });
		return { content: [{ type: 'text', text: `Delivery note created as draft successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

server.tool(
	'update-delivery-note',
	`Update a draft delivery note (Lieferschein) in Lexware Office. Use this instead of creating a new draft to avoid gaps in sequential numbering. Only works on drafts. Requires current version from get-delivery-note-details.`,
	{ id: z.string().uuid().describe('ID of the draft to update'), version: z.number().int().describe('Current version for optimistic locking'), ...deliveryNoteBaseSchema },
	async ({ id, version, ...rest }) => {
		const result = await makeLexwareOfficeWriteRequest<any>(`/v1/delivery-notes/${id}`, 'PUT', { version, ...rest });
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('update-delivery-note', { id });
		return { content: [{ type: 'text', text: `Delivery note draft updated successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

// ─── Dunning: Create ──────────────────────────────────────────────────────────

const dunningSchema = {
	precedingSalesVoucherId: z.string().uuid().describe('ID of the invoice this dunning is for (from get-invoices or get-invoice-details)'),
	voucherDate: z.string().describe(`Dunning date. Format: ${DATE_FORMAT_HINT}`),
	address: invoiceAddressSchema,
	lineItems: z.array(lineItemSchema).min(1),
	taxConditions: z.object({
		taxType: z.enum(['net', 'gross', 'vatfree']).describe('"net" = Netto, "gross" = Brutto, "vatfree" = steuerfrei'),
	}),
	shippingConditions: z.object({
		shippingDate: z.string().describe(`Service date for the dunning, usually the original invoice's service date. Format: ${DATE_FORMAT_HINT}`),
		shippingEndDate: z.string().optional().describe('REQUIRED for period types (serviceperiod/deliveryperiod). OMIT for "service"/"delivery".'),
		shippingType: z.enum(['service', 'delivery', 'serviceperiod', 'deliveryperiod']).describe(SHIPPING_TYPE_HINT),
	}).describe('Required by Lexoffice API'),
	title: z.string().optional().describe('Custom document title printed on the PDF. Overrides the default title ("Mahnung").'),
	introduction: z.string().optional().describe('Text printed before line items. Use \\n for line breaks.'),
	remark: z.string().optional().describe('Text printed after line items. Use \\n for line breaks.'),
	printLayoutId: z.string().uuid().optional().describe('UUID of the print layout. Retrieve available layouts with list-print-layouts.'),
};

server.tool(
	'create-dunning',
	`Create a dunning notice (Mahnung) as a draft in Lexware Office for an existing invoice. ${finalizeHint(governance.permissions.finalize.dunnings)} Note: the API always returns voucherStatus "draft" for dunnings — this is expected API behaviour.`,
	dunningSchema,
	async (params) => {
		const { precedingSalesVoucherId, ...rest } = params;
		const path = `/v1/dunnings?precedingSalesVoucherId=${encodeURIComponent(precedingSalesVoucherId)}`;
		const result = await makeLexwareOfficeWriteRequest<any>(path, 'POST', { ...rest, totalPrice: { currency: 'EUR' } });
		if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
		auditAllow('create-dunning', { id: (result.data as any)?.id ?? 'unknown' });
		return { content: [{ type: 'text', text: `Dunning created as draft successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
	},
);

// ─── Archive Tools ────────────────────────────────────────────────────────────

if (governance.permissions.archive.contacts) {
	server.tool(
		'archive-contact',
		'Archive a contact (soft-delete). The contact remains in Lexware but is hidden from standard lists and cannot be used in new documents. Existing references in old invoices remain intact. Use this instead of deletion — hard deletion is disabled in this environment.',
		{ id: z.string().uuid().describe('The ID of the contact to archive') },
		async ({ id }) => {
			const current = await makeLexwareOfficeRequest<any>(`/v1/contacts/${id}`);
			if (!current.ok) return { content: [{ type: 'text', text: writeErrorResponse(current) }] };
			// Fix #2: strip server-managed read-only fields before PUT
			const result = await makeLexwareOfficeWriteRequest<any>(`/v1/contacts/${id}`, 'PUT', {
				...stripReadOnlyFields(current.data),
				archived: true,
			});
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('archive-contact', { id });
			return { content: [{ type: 'text', text: `Contact ${id} archived successfully.` }] };
		},
	);

	server.tool(
		'unarchive-contact',
		'Restore an archived contact in Lexware Office. After unarchiving, the contact will appear in standard lists and can be used in new documents again.',
		{ id: z.string().uuid().describe('The ID of the contact to unarchive') },
		async ({ id }) => {
			const current = await makeLexwareOfficeRequest<any>(`/v1/contacts/${id}`);
			if (!current.ok) return { content: [{ type: 'text', text: writeErrorResponse(current) }] };
			const result = await makeLexwareOfficeWriteRequest<any>(`/v1/contacts/${id}`, 'PUT', {
				...stripReadOnlyFields(current.data),
				archived: false,
			});
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('unarchive-contact', { id });
			return { content: [{ type: 'text', text: `Contact ${id} unarchived successfully.` }] };
		},
	);
}

if (governance.permissions.archive.articles) {
	server.tool(
		'archive-article',
		'Archive an article (soft-delete). The article remains in Lexware but is hidden from standard lists and cannot be used in new documents. Existing references in old invoices remain intact. Use this instead of deletion — it is reversible.',
		{ id: z.string().uuid().describe('The ID of the article to archive') },
		async ({ id }) => {
			const current = await makeLexwareOfficeRequest<any>(`/v1/articles/${id}`);
			if (!current.ok) return { content: [{ type: 'text', text: writeErrorResponse(current) }] };
			const result = await makeLexwareOfficeWriteRequest<any>(`/v1/articles/${id}`, 'PUT', {
				...stripReadOnlyFields(current.data),
				archived: true,
			});
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('archive-article', { id });
			return { content: [{ type: 'text', text: `Article ${id} archived successfully.` }] };
		},
	);

	server.tool(
		'unarchive-article',
		'Restore an archived article in Lexware Office. After unarchiving, the article will appear in standard lists and can be used in new documents again.',
		{ id: z.string().uuid().describe('The ID of the article to unarchive') },
		async ({ id }) => {
			const current = await makeLexwareOfficeRequest<any>(`/v1/articles/${id}`);
			if (!current.ok) return { content: [{ type: 'text', text: writeErrorResponse(current) }] };
			const result = await makeLexwareOfficeWriteRequest<any>(`/v1/articles/${id}`, 'PUT', {
				...stripReadOnlyFields(current.data),
				archived: false,
			});
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('unarchive-article', { id });
			return { content: [{ type: 'text', text: `Article ${id} unarchived successfully.` }] };
		},
	);
}

// ─── Governance-Gated: Finalize Tools ─────────────────────────────────────────

const suppressedTools: string[] = [];

if (governance.permissions.finalize.invoices) {
	server.tool(
		'finalize-invoice',
		'Create and immediately finalize (publish) an invoice in Lexware Office. The invoice will be locked and cannot be edited. Use create-invoice to create a draft first.',
		invoiceSchema,
		async (params) => {
			const result = await makeLexwareOfficeWriteRequest<any>('/v1/invoices?finalize=true', 'POST', { ...params, totalPrice: { currency: 'EUR' } });
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('finalize-invoice', { id: (result.data as any)?.id ?? 'unknown' });
			return { content: [{ type: 'text', text: `Invoice created and finalized successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
		},
	);
} else { suppressedTools.push('finalize-invoice'); }

if (governance.permissions.finalize.quotations) {
	server.tool(
		'finalize-quotation',
		'Create and immediately finalize (publish) a quotation (Angebot) in Lexware Office. The quotation will be locked and cannot be edited.',
		quotationCreateSchema,
		async (params) => {
			const result = await makeLexwareOfficeWriteRequest<any>('/v1/quotations?finalize=true', 'POST', { ...params, totalPrice: { currency: 'EUR' } });
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('finalize-quotation', { id: (result.data as any)?.id ?? 'unknown' });
			return { content: [{ type: 'text', text: `Quotation created and finalized successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
		},
	);
} else { suppressedTools.push('finalize-quotation'); }

if (governance.permissions.finalize.creditNotes) {
	server.tool(
		'finalize-credit-note',
		'Create and immediately finalize a credit note (Gutschrift) in Lexware Office. The credit note will be locked and cannot be edited.',
		creditNoteCreateSchema,
		async (params) => {
			const result = await makeLexwareOfficeWriteRequest<any>('/v1/credit-notes?finalize=true', 'POST', { ...params, totalPrice: { currency: 'EUR' } });
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('finalize-credit-note', { id: (result.data as any)?.id ?? 'unknown' });
			return { content: [{ type: 'text', text: `Credit note created and finalized successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
		},
	);
} else { suppressedTools.push('finalize-credit-note'); }

if (governance.permissions.finalize.orderConfirmations) {
	server.tool(
		'finalize-order-confirmation',
		'Create and immediately finalize an order confirmation (Auftragsbestätigung) in Lexware Office. The document will be locked and cannot be edited.',
		invoiceSchema,
		async (params) => {
			const result = await makeLexwareOfficeWriteRequest<any>('/v1/order-confirmations?finalize=true', 'POST', { ...params, totalPrice: { currency: 'EUR' } });
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('finalize-order-confirmation', { id: (result.data as any)?.id ?? 'unknown' });
			return { content: [{ type: 'text', text: `Order confirmation created and finalized successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
		},
	);
} else { suppressedTools.push('finalize-order-confirmation'); }

if (governance.permissions.finalize.deliveryNotes) {
	server.tool(
		'finalize-delivery-note',
		'Create and immediately finalize a delivery note (Lieferschein) in Lexware Office. The document will be locked and cannot be edited.',
		deliveryNoteBaseSchema,
		async (params) => {
			const result = await makeLexwareOfficeWriteRequest<any>('/v1/delivery-notes?finalize=true', 'POST', params);
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('finalize-delivery-note', { id: (result.data as any)?.id ?? 'unknown' });
			return { content: [{ type: 'text', text: `Delivery note created and finalized successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
		},
	);
} else { suppressedTools.push('finalize-delivery-note'); }

if (governance.permissions.finalize.dunnings) {
	server.tool(
		'finalize-dunning',
		'Create and immediately finalize a dunning notice (Mahnung) in Lexware Office. Note: the API always returns voucherStatus "draft" for dunnings — this is expected API behaviour.',
		dunningSchema,
		async (params) => {
			const { precedingSalesVoucherId, ...rest } = params;
			const path = `/v1/dunnings?precedingSalesVoucherId=${encodeURIComponent(precedingSalesVoucherId)}&finalize=true`;
			const result = await makeLexwareOfficeWriteRequest<any>(path, 'POST', { ...rest, totalPrice: { currency: 'EUR' } });
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('finalize-dunning', { id: (result.data as any)?.id ?? 'unknown' });
			return { content: [{ type: 'text', text: `Dunning created and finalized successfully:\n\n${JSON.stringify(result.data, null, 2)}` }] };
		},
	);
} else { suppressedTools.push('finalize-dunning'); }

// ─── Governance-Gated: Delete Tools ──────────────────────────────────────────

if (governance.permissions.delete.articles) {
	server.tool(
		'delete-article',
		'Permanently delete an article from Lexware Office. IRREVERSIBLE. Consider using archive-article instead — it is reversible.',
		{ id: z.string().uuid().describe('The ID of the article to delete') },
		async ({ id }) => {
			const result = await makeLexwareOfficeWriteRequest<any>(`/v1/articles/${id}`, 'DELETE');
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('delete-article', { id });
			return { content: [{ type: 'text', text: `Article ${id} deleted successfully.` }] };
		},
	);
} else { suppressedTools.push('delete-article'); }

if (governance.permissions.delete.contacts) {
	server.tool(
		'delete-contact',
		'Permanently delete a contact from Lexware Office. IRREVERSIBLE. Consider using archive-contact instead — it is reversible.',
		{ id: z.string().uuid().describe('The ID of the contact to delete') },
		async ({ id }) => {
			const result = await makeLexwareOfficeWriteRequest<any>(`/v1/contacts/${id}`, 'DELETE');
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('delete-contact', { id });
			return { content: [{ type: 'text', text: `Contact ${id} deleted successfully.` }] };
		},
	);
} else { suppressedTools.push('delete-contact'); }

if (governance.permissions.delete.vouchers) {
	server.tool(
		'delete-voucher',
		'Permanently delete a bookkeeping voucher from Lexware Office. IRREVERSIBLE.',
		{ id: z.string().uuid().describe('The ID of the voucher to delete') },
		async ({ id }) => {
			const result = await makeLexwareOfficeWriteRequest<any>(`/v1/vouchers/${id}`, 'DELETE');
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('delete-voucher', { id });
			return { content: [{ type: 'text', text: `Voucher ${id} deleted successfully.` }] };
		},
	);
} else { suppressedTools.push('delete-voucher'); }

if (governance.permissions.delete.invoiceDrafts) {
	server.tool(
		'delete-invoice-draft',
		'⚠️ Delete a draft invoice. WARNING: The sequential number has already been reserved — deletion creates a permanent gap in invoice numbering, which may violate bookkeeping regulations.',
		{ id: z.string().uuid().describe('The ID of the invoice draft to delete') },
		async ({ id }) => {
			const result = await makeLexwareOfficeWriteRequest<any>(`/v1/invoices/${id}`, 'DELETE');
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('delete-invoice-draft', { id });
			return { content: [{ type: 'text', text: `Invoice draft ${id} deleted. Sequential number gap created.` }] };
		},
	);
}

if (governance.permissions.delete.quotationDrafts) {
	server.tool(
		'delete-quotation-draft',
		'⚠️ Delete a draft quotation. WARNING: Deletion creates a permanent gap in quotation numbering.',
		{ id: z.string().uuid().describe('The ID of the quotation draft to delete') },
		async ({ id }) => {
			const result = await makeLexwareOfficeWriteRequest<any>(`/v1/quotations/${id}`, 'DELETE');
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('delete-quotation-draft', { id });
			return { content: [{ type: 'text', text: `Quotation draft ${id} deleted. Sequential number gap created.` }] };
		},
	);
}

if (governance.permissions.delete.creditNoteDrafts) {
	server.tool(
		'delete-credit-note-draft',
		'⚠️ Delete a draft credit note. WARNING: Deletion creates a permanent gap in credit note numbering.',
		{ id: z.string().uuid().describe('The ID of the credit note draft to delete') },
		async ({ id }) => {
			const result = await makeLexwareOfficeWriteRequest<any>(`/v1/credit-notes/${id}`, 'DELETE');
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('delete-credit-note-draft', { id });
			return { content: [{ type: 'text', text: `Credit note draft ${id} deleted. Sequential number gap created.` }] };
		},
	);
}

if (governance.permissions.delete.orderConfirmationDrafts) {
	server.tool(
		'delete-order-confirmation-draft',
		'⚠️ Delete a draft order confirmation. WARNING: Deletion creates a permanent gap in order confirmation numbering.',
		{ id: z.string().uuid().describe('The ID of the order confirmation draft to delete') },
		async ({ id }) => {
			const result = await makeLexwareOfficeWriteRequest<any>(`/v1/order-confirmations/${id}`, 'DELETE');
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('delete-order-confirmation-draft', { id });
			return { content: [{ type: 'text', text: `Order confirmation draft ${id} deleted. Sequential number gap created.` }] };
		},
	);
}

if (governance.permissions.delete.deliveryNoteDrafts) {
	server.tool(
		'delete-delivery-note-draft',
		'⚠️ Delete a draft delivery note. WARNING: Deletion creates a permanent gap in delivery note numbering.',
		{ id: z.string().uuid().describe('The ID of the delivery note draft to delete') },
		async ({ id }) => {
			const result = await makeLexwareOfficeWriteRequest<any>(`/v1/delivery-notes/${id}`, 'DELETE');
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('delete-delivery-note-draft', { id });
			return { content: [{ type: 'text', text: `Delivery note draft ${id} deleted. Sequential number gap created.` }] };
		},
	);
}

if (governance.permissions.delete.eventSubscriptions) {
	server.tool(
		'delete-event-subscription',
		'Delete a webhook event subscription from Lexware Office by its ID.',
		{ id: z.string().uuid().describe('The ID of the event subscription to delete') },
		async ({ id }) => {
			const result = await makeLexwareOfficeWriteRequest<void>(`/v1/event-subscriptions/${id}`, 'DELETE');
			if (!result || !result.ok) return { content: [{ type: 'text', text: writeErrorResponse(result && !result.ok ? result : null) }] };
			auditAllow('delete-event-subscription', { id });
			return { content: [{ type: 'text', text: `Event subscription ${id} deleted successfully.` }] };
		},
	);
} else { suppressedTools.push('delete-event-subscription'); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	logger.log('Lexware Office MCP Server running', {
		safetyMode: governance.safetyMode,
		permissions: governance.permissions,
	});
	// Fix #6: log suppressed tools at startup so the audit trail shows governance decisions
	auditStartup(suppressedTools, governance.safetyMode);
}

main().catch((error) => {
	logger.error('Fatal error in main():', { error });
	process.exit(1);
});
