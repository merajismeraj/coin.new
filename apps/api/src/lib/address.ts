import { getAddress, isAddress } from "viem";
import { HttpError } from "./errors.js";

/**
 * Checksums an EVM address. A mixed-case address must carry a valid EIP-55
 * checksum: a wrong one almost always means a typo, and a typo in a receiving
 * wallet sends money somewhere unrecoverable.
 */
export function checksumEvm(address: string, field: string): `0x${string}` {
  if (!isAddress(address, { strict: true })) {
    throw new HttpError(400, "validation_error", "Request validation failed", [{ path: field, message: "invalid EVM address checksum — re-copy the address" }]);
  }
  return getAddress(address);
}
