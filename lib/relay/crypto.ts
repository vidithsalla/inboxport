const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type SealedEnvelope = Readonly<{
  version: 1;
  algorithm: "A256GCM+A256GCMKW";
  ciphertext: string;
  nonce: string;
  wrappedKey: string;
  wrapNonce: string;
  keyVersion: number;
}>;

export interface EnvelopeVault {
  readonly keyVersion: number;
  seal(plaintext: string, associatedData: string): Promise<SealedEnvelope>;
  open(envelope: SealedEnvelope, associatedData: string): Promise<string>;
  fingerprint(value: string, context: string): Promise<string>;
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

const importAesGcmKey = (raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, usages);

async function encryptAesGcm(
  key: CryptoKey,
  plaintext: Uint8Array,
  associatedData: string,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  const nonce = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce as BufferSource,
      additionalData: encoder.encode(associatedData),
      tagLength: 128,
    },
    key,
    plaintext as BufferSource,
  );
  return { ciphertext: new Uint8Array(ciphertext), nonce };
}

async function decryptAesGcm(
  key: CryptoKey,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  associatedData: string,
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: nonce as BufferSource,
      additionalData: encoder.encode(associatedData),
      tagLength: 128,
    },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(plaintext);
}

export class LocalEnvelopeVault implements EnvelopeVault {
  private readonly wrappingKey: CryptoKey;
  private readonly fingerprintKey: CryptoKey;
  readonly keyVersion: number;

  private constructor(
    wrappingKey: CryptoKey,
    fingerprintKey: CryptoKey,
    keyVersion: number,
  ) {
    this.wrappingKey = wrappingKey;
    this.fingerprintKey = fingerprintKey;
    this.keyVersion = keyVersion;
  }

  static async fromEncodedKey(encodedKey: string, keyVersion = 1): Promise<LocalEnvelopeVault> {
    const raw = fromBase64Url(encodedKey);
    if (raw.byteLength !== 32) {
      throw new Error("RELAY_VAULT_KEY_MUST_BE_32_BYTES");
    }
    const derivationInput = new Uint8Array(encoder.encode("relay-mail:fingerprint-key:v1").length + raw.length);
    derivationInput.set(encoder.encode("relay-mail:fingerprint-key:v1"), 0);
    derivationInput.set(raw, encoder.encode("relay-mail:fingerprint-key:v1").length);
    const fingerprintKeyBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", derivationInput),
    );
    return new LocalEnvelopeVault(
      await importAesGcmKey(raw, ["encrypt", "decrypt"]),
      await crypto.subtle.importKey(
        "raw",
        fingerprintKeyBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      keyVersion,
    );
  }

  async seal(plaintext: string, associatedData: string): Promise<SealedEnvelope> {
    const dataKeyBytes = randomBytes(32);
    const dataKey = await importAesGcmKey(dataKeyBytes, ["encrypt", "decrypt"]);
    const sealedData = await encryptAesGcm(
      dataKey,
      encoder.encode(plaintext),
      associatedData,
    );
    const sealedKey = await encryptAesGcm(
      this.wrappingKey,
      dataKeyBytes,
      `relay:key-wrap:${associatedData}:v${this.keyVersion}`,
    );

    return {
      version: 1,
      algorithm: "A256GCM+A256GCMKW",
      ciphertext: toBase64Url(sealedData.ciphertext),
      nonce: toBase64Url(sealedData.nonce),
      wrappedKey: toBase64Url(sealedKey.ciphertext),
      wrapNonce: toBase64Url(sealedKey.nonce),
      keyVersion: this.keyVersion,
    };
  }

  async open(envelope: SealedEnvelope, associatedData: string): Promise<string> {
    if (envelope.version !== 1 || envelope.algorithm !== "A256GCM+A256GCMKW") {
      throw new Error("RELAY_VAULT_ENVELOPE_UNSUPPORTED");
    }
    if (envelope.keyVersion !== this.keyVersion) {
      throw new Error("RELAY_VAULT_KEY_VERSION_UNAVAILABLE");
    }

    const dataKeyBytes = await decryptAesGcm(
      this.wrappingKey,
      fromBase64Url(envelope.wrappedKey),
      fromBase64Url(envelope.wrapNonce),
      `relay:key-wrap:${associatedData}:v${envelope.keyVersion}`,
    );
    const dataKey = await importAesGcmKey(dataKeyBytes, ["decrypt"]);
    const plaintext = await decryptAesGcm(
      dataKey,
      fromBase64Url(envelope.ciphertext),
      fromBase64Url(envelope.nonce),
      associatedData,
    );
    return decoder.decode(plaintext);
  }

  async fingerprint(value: string, context: string): Promise<string> {
    const signature = await crypto.subtle.sign(
      "HMAC",
      this.fingerprintKey,
      encoder.encode(`${context}\u0000${value}`),
    );
    return toBase64Url(new Uint8Array(signature));
  }
}

export const serializeEnvelope = (envelope: SealedEnvelope): string =>
  JSON.stringify(envelope);

export function parseEnvelope(value: string): SealedEnvelope {
  const parsed = JSON.parse(value) as Partial<SealedEnvelope>;
  if (
    parsed.version !== 1 ||
    parsed.algorithm !== "A256GCM+A256GCMKW" ||
    typeof parsed.ciphertext !== "string" ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.wrappedKey !== "string" ||
    typeof parsed.wrapNonce !== "string" ||
    typeof parsed.keyVersion !== "number"
  ) {
    throw new Error("RELAY_VAULT_ENVELOPE_INVALID");
  }
  return parsed as SealedEnvelope;
}

export const encodeOpaque = (value: string): string => toBase64Url(encoder.encode(value));
export const decodeOpaque = (value: string): string => decoder.decode(fromBase64Url(value));

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}

export function randomOpaque(byteLength = 32): string {
  return toBase64Url(randomBytes(byteLength));
}
