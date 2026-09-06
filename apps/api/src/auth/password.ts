import { hash, verify } from "@node-rs/argon2";

/**
 * OWASP-recommended argon2id parameters. Deliberately not configurable per
 * call - a weaker cost must not be reachable by passing an option.
 */
const OPTIONS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  if (plain.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  return hash(plain, OPTIONS);
}

/** Never throws on a malformed hash - a bad stored value is a failed login. */
export async function verifyPassword(
  storedHash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}
