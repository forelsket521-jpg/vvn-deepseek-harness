// dsh-scrub · 提示词保险柜（密封槽）
// 与 dsh-purge 的差别：算法换成 ChaCha20-Poly1305 + brotli + 逐字节掩码，KDF 换成 HKDF-SHA512，
// 密文格式自带版本号与明文摘要，解密失败一律返回空串（不抛，避免把注入段炸掉）。
//
// 格式（lib/prompt.sealed.js 导出的对象）：
//   { v: 1, alg: "chacha20-poly1305", kdf: "hkdf-sha512", mask: 0xA5,
//     salt: b64(16), iv: b64(12), tag: b64(16), body: b64, sha256: hex }

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";

const IKM = Buffer.from("dsh-scrub.vault.v1|dsh-scrub|surface:any|table:prompt", "utf8");
const INFO = Buffer.from("seal", "utf8");
const MASK = 0xa5;

function deriveKey(salt) {
  return Buffer.from(hkdfSync("sha512", IKM, salt, INFO, 32));
}

function xor(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i += 1) out[i] = buf[i] ^ MASK;
  return out;
}

export function sealText(text) {
  const plain = Buffer.from(String(text ?? ""), "utf8");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(salt);
  const cipher = createCipheriv("chacha20-poly1305", key, iv);
  const packed = xor(brotliCompressSync(plain, {
    params: { 1: 11, 2: 22 }, // QUALITY 11 / LGWIN 22
  }));
  const body = Buffer.concat([cipher.update(packed), cipher.final()]);
  return {
    v: 1,
    alg: "chacha20-poly1305",
    kdf: "hkdf-sha512",
    mask: MASK,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    body: body.toString("base64"),
    sha256: createHash("sha256").update(String(text ?? ""), "utf8").digest("hex"),
  };
}

export function openSealed(blob) {
  try {
    if (!blob || blob.v !== 1) return "";
    const salt = Buffer.from(blob.salt, "base64");
    const iv = Buffer.from(blob.iv, "base64");
    const decipher = createDecipheriv("chacha20-poly1305", deriveKey(salt), iv);
    decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
    const raw = Buffer.concat([decipher.update(Buffer.from(blob.body, "base64")), decipher.final()]);
    const text = brotliDecompressSync(xor(raw)).toString("utf8");
    if (blob.sha256 && createHash("sha256").update(text, "utf8").digest("hex") !== blob.sha256) return "";
    return text;
  } catch {
    return "";
  }
}

export function describe(blob) {
  if (!blob) return "empty";
  return `${blob.alg}/${blob.kdf}/mask=0x${Number(blob.mask).toString(16)} body=${Buffer.from(blob.body || "", "base64").length}B sha256=${String(blob.sha256 || "").slice(0, 12)}…`;
}
