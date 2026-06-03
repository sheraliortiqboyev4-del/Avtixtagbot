const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAGIC = Buffer.from('AVBK1');

function deriveKey(secret, salt) {
    return crypto.scryptSync(secret, salt, KEY_LENGTH, SCRYPT_OPTIONS);
}

function getSecret() {
    const secret = process.env.BACKUP_SECRET || process.env.BACKUP_ENCRYPTION_KEY;
    if (!secret || secret.length < 16) {
        throw new Error('BACKUP_SECRET (kamida 16 belgi) .env da belgilangan bo\'lishi kerak');
    }
    return secret;
}

function encryptBuffer(plainBuffer) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = deriveKey(getSecret(), salt);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, salt, iv, authTag, encrypted]);
}

function decryptBuffer(encryptedBuffer) {
    if (!Buffer.isBuffer(encryptedBuffer) || encryptedBuffer.length < MAGIC.length + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1) {
        throw new Error('Zaxira fayli noto\'g\'ri formatda');
    }
    if (!encryptedBuffer.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('Zaxira fayli versiyasi mos emas');
    }
    let offset = MAGIC.length;
    const salt = encryptedBuffer.subarray(offset, offset + SALT_LENGTH);
    offset += SALT_LENGTH;
    const iv = encryptedBuffer.subarray(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;
    const authTag = encryptedBuffer.subarray(offset, offset + AUTH_TAG_LENGTH);
    offset += AUTH_TAG_LENGTH;
    const data = encryptedBuffer.subarray(offset);

    const key = deriveKey(getSecret(), salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
}

module.exports = { encryptBuffer, decryptBuffer, getSecret };
