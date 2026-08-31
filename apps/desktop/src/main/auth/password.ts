import {
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_PARAMETERS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;
const HASH_PREFIX = "scrypt";

function scryptPassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      SCRYPT_PARAMETERS,
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(derivedKey);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await scryptPassword(password, salt);

  return [
    HASH_PREFIX,
    SCRYPT_PARAMETERS.N,
    SCRYPT_PARAMETERS.r,
    SCRYPT_PARAMETERS.p,
    salt.toString("base64"),
    derivedKey.toString("base64"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const parts = encodedHash.split("$");

  if (parts.length !== 6) {
    return false;
  }

  const [prefix, encodedN, encodedR, encodedP, encodedSalt, encodedKey] =
    parts;
  if (
    prefix !== HASH_PREFIX ||
    encodedN === undefined ||
    encodedR === undefined ||
    encodedP === undefined ||
    encodedSalt === undefined ||
    encodedKey === undefined ||
    Number(encodedN) !== SCRYPT_PARAMETERS.N ||
    Number(encodedR) !== SCRYPT_PARAMETERS.r ||
    Number(encodedP) !== SCRYPT_PARAMETERS.p
  ) {
    return false;
  }

  try {
    const salt = Buffer.from(encodedSalt, "base64");
    const expectedKey = Buffer.from(encodedKey, "base64");

    if (salt.length !== 16 || expectedKey.length !== SCRYPT_KEY_LENGTH) {
      return false;
    }

    const actualKey = await scryptPassword(password, salt);
    return timingSafeEqual(expectedKey, actualKey);
  } catch {
    return false;
  }
}
