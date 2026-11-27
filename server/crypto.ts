/**
 * Password hashing, session secrets and ids with Web Crypto, which works the same in Cloudflare
 * Workers and in Node.js.
 */
import { JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH } from '../shared/limits.ts'

/** PBKDF2-SHA256. Workers caps PBKDF2 at 100,000 iterations. */
const ITERATIONS = 100_000
const KEY_BITS = 256
const encoder = new TextEncoder()

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BITS)
  return new Uint8Array(bits)
}

/** Comparison that takes the same time wherever the first difference is. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** The same for two strings (hex hashes). */
export function equalText(a: string, b: string): boolean {
  return equalBytes(encoder.encode(a), encoder.encode(b))
}

/** Hash a password. Format: pbkdf2-sha256$iterations$salt$hash (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, ITERATIONS)
  return ['pbkdf2-sha256', ITERATIONS, toBase64(salt), toBase64(hash)].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split('$')
  const n = Number(iterations)
  if (scheme !== 'pbkdf2-sha256' || !salt || !hash || !Number.isInteger(n) || n < 1 || n > ITERATIONS) return false
  try {
    return equalBytes(await derive(password, fromBase64(salt), n), fromBase64(hash))
  } catch {
    return false
  }
}

// A real hash to compare against when the email is unknown, so that a failed sign-in takes the
// same time whether or not the account exists.
let dummyHash: Promise<string> | null = null
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(crypto.randomUUID())
  await verifyPassword(password, await dummyHash)
}

/** 32 random bytes as URL-safe text: session tokens, session secrets and reset tokens. Only hashes are stored. */
export function newToken(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** `length` characters drawn evenly from `alphabet` (which must have at most 256 characters). */
function randomText(alphabet: string, length: number): string {
  // Bytes at or above the largest multiple of the alphabet's size are thrown away, so that every
  // character is equally likely.
  const limit = 256 - (256 % alphabet.length)
  let out = ''
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length]
    }
  }
  return out
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** An id for a user, course or assignment: 20 characters of a-z and 0-9 (about 103 random bits). */
export function newId(): string {
  return randomText(ID_ALPHABET, 20)
}

export const ID_PATTERN = /^[a-z0-9]{20}$/

export function newJoinCode(): string {
  return randomText(JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH)
}
