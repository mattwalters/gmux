// The only module that touches `refresh:<account>` keys in GMUX_KV. Refresh
// tokens are encrypted with AES-GCM under the TOKEN_ENCRYPTION_KEY secret;
// nothing here ever writes or reads plaintext. Reading never returns an empty
// result: it throws a ReauthRequiredError naming the specific reason. Copied
// in shape from ops-mail's token-store.ts, deliberately not shared.
//
// On the stop-list (AGENTS.md): a change here waits for a human to merge it.

import { ReauthRequiredError } from "./errors.js";

export interface RefreshRecord {
	refreshToken: string;
	/** The Google account's own address, as Google reported it at connect time. */
	email: string;
	scopes: string[];
	connectedAt: string;
}

/** The on-the-wire shape of a `refresh:<account>` KV value. `v` leaves room for a versioned key later. */
interface StoredCiphertext {
	v: 1;
	iv: string;
	ct: string;
}

function refreshKey(account: string): string {
	return `refresh:${account}`;
}

/**
 * The additional authenticated data. Binds a ciphertext to the account it was
 * written under, so a ciphertext copied to another account's key fails to
 * decrypt instead of silently serving the wrong account.
 */
function additionalData(account: string): Uint8Array {
	return new TextEncoder().encode(`gmux:refresh:${account}`);
}

function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
	const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	for (const byte of array) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Imports the key (already validated by readEncryptionKey) as a non-extractable AES-GCM key. */
async function importKey(encryptionKey: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", base64ToBytes(encryptionKey), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts `record` with a fresh random IV and writes it to `refresh:<account>`, overwriting any previous token. */
export async function writeRefreshToken(
	kv: KVNamespace,
	encryptionKey: string,
	account: string,
	record: RefreshRecord,
): Promise<void> {
	const key = await importKey(encryptionKey);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = new TextEncoder().encode(JSON.stringify(record));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: additionalData(account) },
		key,
		plaintext,
	);

	const stored: StoredCiphertext = { v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(ciphertext) };
	await kv.put(refreshKey(account), JSON.stringify(stored));
}

/**
 * Reads and decrypts `refresh:<account>`. A missing record throws
 * ReauthRequiredError "not_connected"; a decrypt or parse failure (wrong key,
 * tampering, or another account's ciphertext) throws "unreadable".
 */
export async function readRefreshToken(
	kv: KVNamespace,
	encryptionKey: string,
	account: string,
): Promise<RefreshRecord> {
	const raw = await kv.get(refreshKey(account));
	if (!raw) throw new ReauthRequiredError(account, "not_connected");

	const key = await importKey(encryptionKey);

	try {
		const stored = JSON.parse(raw) as StoredCiphertext;
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: base64ToBytes(stored.iv), additionalData: additionalData(account) },
			key,
			base64ToBytes(stored.ct),
		);
		return JSON.parse(new TextDecoder().decode(plaintext)) as RefreshRecord;
	} catch (error) {
		// The error itself is from WebCrypto or JSON.parse and carries no
		// plaintext; the record is never logged.
		console.error(`gmux: refresh:${account} is unreadable`, error);
		throw new ReauthRequiredError(account, "unreadable");
	}
}

/** Removes `refresh:<account>`. Doesn't revoke the token at Google; it's simply never read again. */
export async function deleteRefreshToken(kv: KVNamespace, account: string): Promise<void> {
	await kv.delete(refreshKey(account));
}
